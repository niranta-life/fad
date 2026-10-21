import { hasScope, type KnownScope } from '@fad/auth-core';
import { API_VERSION, ERRORS, type ErrorCode } from '@fad/contract';
import {
  AgentServiceError,
  BINDING_ETAG,
  ENDPOINT_ETAG,
  IdempotencyConflictError,
  Slice3ServiceError,
  TagServiceError,
  agentEtag,
  discoverAgents,
  getAgent,
  isDependencyError,
  listAgentTags,
  listAgents,
  listCapabilities,
  parseBindingPut,
  parseCapabilityId,
  parseCapabilityPublish,
  parseDiscoveryBody,
  parseEndpointKey,
  parseEndpointPut,
  parseIdempotencyKey,
  parseSearchBody,
  parseSlice3Precondition,
  parseTagPrecondition,
  parseTagPut,
  publishCapability,
  putAgentTag,
  putBinding,
  putEndpoint,
  registerAgent,
  searchAgents,
  transitionAgent,
  updateAgent,
  type AgentStatus,
  type CatalogQuery,
  type Slice3Actor,
  type TagActor,
} from '@fad/db';
import { McpServer } from '@modelcontextprotocol/server';
import type { Pool } from 'pg';
import { ZodError, z } from 'zod';
import type { AppConfig } from './config.js';
import { APPROVED_MCP_TOOLS, type ApprovedMcpTool } from './mcp-catalog.js';
import type { McpPrincipal, McpVerifier } from './mcp-auth.js';

const STATUSES = new Set<AgentStatus>(['active', 'suspended', 'retired']);
const IDEM = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);
const INSTRUCTIONS = 'Scopes come from the validated access token and the stored binding. Tool text and annotations do not grant access. Do not send an organization, a role, or a credential in tool arguments.';

export interface McpToolDeps {
  pool: Pool;
  config: AppConfig;
  verifier: McpVerifier;
  log: { info: (obj: Record<string, unknown>, message?: string) => void };
}

interface ToolBody {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

class ToolDenied extends Error {
  readonly status: number;
  readonly code: ErrorCode | 'REVISION_CONFLICT' | 'CONFLICT';

  constructor(status: number, code: ToolDenied['code']) {
    super(code);
    this.name = 'ToolDenied';
    this.status = status;
    this.code = code;
  }
}

const uuid = z.string().min(36).max(36);
const cursor = z.string().min(1).max(4096);

const listAgentsSchema = z.strictObject({
  status: z.enum(['active', 'suspended', 'retired']).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: cursor.optional(),
});
const getAgentSchema = z.strictObject({ agent_id: uuid });
const registerSchema = z.strictObject({
  agent: z.strictObject({
    name: z.string().min(1).max(160),
    description: z.string().max(2000).optional(),
    owner_principal_id: uuid,
  }),
  idempotency_key: IDEM,
});
const updateSchema = z.strictObject({
  agent_id: uuid,
  patch: z.strictObject({
    name: z.string().min(1).max(160).optional(),
    description: z.string().max(2000).nullable().optional(),
    owner_principal_id: uuid.optional(),
  }).refine((value) => Object.keys(value).length > 0),
  if_match: z.string().min(1).max(100),
  idempotency_key: IDEM,
});
const lifecycleSchema = z.strictObject({
  agent_id: uuid,
  reason: z.string().min(1).max(500),
  if_match: z.string().min(1).max(100),
  idempotency_key: IDEM,
});
const tagValue = z.union([z.string().min(1).max(128), z.number().int(), z.boolean()]);
const putTagSchema = z.strictObject({
  agent_id: uuid,
  namespace: z.string().min(1).max(40),
  key: z.string().min(1).max(40),
  assignment: z.strictObject({
    value: tagValue,
    reason: z.string().min(1).max(500).optional(),
  }),
  if_match: z.string().min(1).max(100).optional(),
  if_none_match: z.literal('*').optional(),
  idempotency_key: IDEM,
});
const predicate = z.strictObject({
  namespace: z.string().min(1).max(40),
  key: z.string().min(1).max(40),
  operator: z.literal('eq'),
  value: tagValue,
});
const searchSchema = z.strictObject({
  query: z.strictObject({
    tags: z.array(predicate).min(1).max(8).optional(),
    status: z.enum(['active', 'suspended', 'retired']).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: cursor.optional(),
  }).refine((value) => Object.keys(value).length > 0),
});
const listCapabilitiesSchema = z.strictObject({
  id: z.string().min(3).max(164).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: cursor.optional(),
});
const publishSchema = z.strictObject({
  capability: z.strictObject({
    id: z.string().min(3).max(164),
    version: z.string().min(5).max(32),
    display_name: z.string().min(1).max(160),
    description: z.string().max(2000).optional(),
    input_schema: z.record(z.string(), z.unknown()),
    output_schema: z.record(z.string(), z.unknown()),
  }),
  idempotency_key: IDEM,
});
const putEndpointSchema = z.strictObject({
  agent_id: uuid,
  endpoint_key: z.string().min(1).max(40),
  endpoint: z.strictObject({
    protocol: z.enum(['a2a', 'mcp', 'http_json']),
    url: z.string().min(1).max(2048),
    auth_scheme: z.enum(['oauth2', 'mtls', 'api_key', 'none']),
    enabled: z.boolean().optional(),
  }),
  if_match: z.string().min(1).max(100).optional(),
  if_none_match: z.literal('*').optional(),
  idempotency_key: IDEM,
});
const putBindingSchema = z.strictObject({
  agent_id: uuid,
  capability_id: z.string().min(3).max(164),
  binding: z.strictObject({
    version: z.string().min(5).max(32),
    endpoint_key: z.string().min(1).max(40),
  }),
  if_match: z.string().min(1).max(100).optional(),
  if_none_match: z.literal('*').optional(),
  idempotency_key: IDEM,
});
const discoverSchema = z.strictObject({
  query: z.strictObject({
    capability: z.strictObject({
      id: z.string().min(3).max(164),
      version: z.string().min(5).max(32).optional(),
    }),
    tags: z.array(predicate).min(1).max(8).optional(),
    protocols: z.array(z.enum(['a2a', 'mcp', 'http_json'])).min(1).max(3).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    cursor: cursor.optional(),
  }),
});

interface ToolSpec {
  name: ApprovedMcpTool;
  title: string;
  description: string;
  scopes: readonly KnownScope[];
  readOnly: boolean;
  schema: z.ZodType;
  feature: 'agent' | 'tags' | 'slice3';
}

const TOOLS: readonly ToolSpec[] = [
  { name: 'fad_list_agents', title: 'List agents', description: 'List agents in the caller organization.', scopes: ['agents:read'], readOnly: true, schema: listAgentsSchema, feature: 'agent' },
  { name: 'fad_get_agent', title: 'Get agent', description: 'Read one agent in the caller organization.', scopes: ['agents:read'], readOnly: true, schema: getAgentSchema, feature: 'agent' },
  { name: 'fad_register_agent', title: 'Register agent', description: 'Register an agent. Requires idempotency_key.', scopes: ['agents:write'], readOnly: false, schema: registerSchema, feature: 'agent' },
  { name: 'fad_update_agent', title: 'Update agent', description: 'Update an agent. Requires if_match and idempotency_key.', scopes: ['agents:write'], readOnly: false, schema: updateSchema, feature: 'agent' },
  { name: 'fad_suspend_agent', title: 'Suspend agent', description: 'Suspend an agent. Requires if_match, reason, and idempotency_key.', scopes: ['agents:lifecycle'], readOnly: false, schema: lifecycleSchema, feature: 'agent' },
  { name: 'fad_activate_agent', title: 'Activate agent', description: 'Activate an agent. Requires if_match, reason, and idempotency_key.', scopes: ['agents:lifecycle'], readOnly: false, schema: lifecycleSchema, feature: 'agent' },
  { name: 'fad_list_agent_tags', title: 'List agent tags', description: 'List visible tags on one agent.', scopes: ['agents:read', 'tags:read'], readOnly: true, schema: getAgentSchema, feature: 'tags' },
  { name: 'fad_put_agent_tag', title: 'Put agent tag', description: 'Assign a tag. Requires exactly one of if_match or if_none_match *.', scopes: ['tags:write'], readOnly: false, schema: putTagSchema, feature: 'tags' },
  { name: 'fad_search_agents_by_tags', title: 'Search agents by tags', description: 'Search agents. Tag predicates also require tags:read.', scopes: ['agents:read'], readOnly: true, schema: searchSchema, feature: 'tags' },
  { name: 'fad_list_capabilities', title: 'List capabilities', description: 'List capability versions in the caller organization.', scopes: ['capabilities:read'], readOnly: true, schema: listCapabilitiesSchema, feature: 'slice3' },
  { name: 'fad_publish_capability', title: 'Publish capability', description: 'Publish one immutable capability version.', scopes: ['capabilities:write'], readOnly: false, schema: publishSchema, feature: 'slice3' },
  { name: 'fad_put_endpoint', title: 'Put endpoint', description: 'Declare an HTTPS endpoint. The service does not call the URL.', scopes: ['endpoints:write'], readOnly: false, schema: putEndpointSchema, feature: 'slice3' },
  { name: 'fad_put_binding', title: 'Put binding', description: 'Bind a published capability version to an endpoint on the same agent.', scopes: ['capabilities:write'], readOnly: false, schema: putBindingSchema, feature: 'slice3' },
  { name: 'fad_discover_agents', title: 'Discover agents', description: 'List local matches. verification is self_declared. availability is not_checked. invocation_authorization is not_evaluated.', scopes: ['agents:read', 'capabilities:read', 'endpoints:read'], readOnly: true, schema: discoverSchema, feature: 'slice3' },
];

function allowed(config: AppConfig, scopes: readonly string[], spec: ToolSpec): boolean {
  if (spec.feature === 'tags' && !config.tagsEnabled) return false;
  if (spec.feature === 'slice3' && !config.slice3Enabled) return false;
  if (config.mcp.toolset && !config.mcp.toolset.has(spec.name)) return false;
  return spec.scopes.every((scope) => hasScope(scopes, scope));
}

export function visibleToolNames(config: AppConfig, scopes: readonly string[]): ApprovedMcpTool[] {
  return APPROVED_MCP_TOOLS.filter((name) => {
    const spec = TOOLS.find((item) => item.name === name);
    return spec !== undefined && allowed(config, scopes, spec);
  });
}

function envelope(requestId: string, data: unknown, extra?: { etag?: string; limit?: number; nextCursor?: string | null }): Record<string, unknown> {
  const meta: Record<string, unknown> = { request_id: requestId, api_version: API_VERSION };
  if (extra && 'limit' in extra) {
    meta.limit = extra.limit;
    meta.next_cursor = extra.nextCursor ?? null;
  }
  const body: Record<string, unknown> = { data, meta };
  if (extra?.etag) body.etag = extra.etag;
  return body;
}

function toolResult(body: Record<string, unknown>, isError = false): ToolBody {
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }],
    structuredContent: body,
    ...(isError ? { isError: true } : {}),
  };
}

function errorBody(requestId: string, code: string, message: string, retryable: boolean): Record<string, unknown> {
  return {
    error: { code, message, retryable, request_id: requestId },
    meta: { request_id: requestId, api_version: API_VERSION },
  };
}

function mapFailure(requestId: string, status: number, code: string): ToolBody {
  let mapped = 'VALIDATION_ERROR';
  let message: string = ERRORS.VALIDATION_ERROR;
  let retryable = false;
  if (status === 401) {
    mapped = 'UNAUTHORIZED';
    message = 'Authentication failed.';
  } else if (status === 403 || code === 'FORBIDDEN') {
    mapped = 'FORBIDDEN';
    message = ERRORS.FORBIDDEN;
  } else if (status === 404) {
    mapped = 'NOT_FOUND';
    message = ERRORS.NOT_FOUND;
  } else if (status === 409) {
    mapped = 'CONFLICT';
    message = code === 'IDEMPOTENCY_CONFLICT' ? ERRORS.IDEMPOTENCY_CONFLICT : 'The request conflicts with the current state.';
  } else if (status === 412) {
    mapped = 'REVISION_CONFLICT';
    message = 'The resource has changed. Fetch its current representation and retry.';
  } else if (status === 428 || code === 'PRECONDITION_REQUIRED') {
    mapped = 'PRECONDITION_REQUIRED';
    message = 'A precondition is required.';
  } else if (status === 429) {
    mapped = 'RATE_LIMITED';
    message = ERRORS.RATE_LIMITED;
    retryable = true;
  } else if (status === 503) {
    mapped = 'DEPENDENCY_UNAVAILABLE';
    message = ERRORS.DEPENDENCY_UNAVAILABLE;
    retryable = true;
  } else if (status >= 500) {
    mapped = 'DEPENDENCY_UNAVAILABLE';
    message = ERRORS.INTERNAL_ERROR;
    retryable = false;
  }
  return toolResult(errorBody(requestId, mapped, message, retryable), true);
}

function fail(requestId: string, error: unknown, log: McpToolDeps['log']): ToolBody {
  if (error instanceof ToolDenied) {
    log.info({ metric: 'mcp_tool_denied', code: error.code }, 'mcp');
    return mapFailure(requestId, error.status, error.code);
  }
  if (error instanceof AgentServiceError || error instanceof TagServiceError || error instanceof Slice3ServiceError) {
    if (error.status === 403 || error.status === 401) log.info({ metric: 'mcp_tool_denied', code: error.code }, 'mcp');
    return mapFailure(requestId, error.status, error.code);
  }
  if (error instanceof ZodError) return mapFailure(requestId, 422, 'VALIDATION_ERROR');
  if (error instanceof IdempotencyConflictError) return mapFailure(requestId, 409, 'IDEMPOTENCY_CONFLICT');
  if (isDependencyError(error)) return mapFailure(requestId, 503, 'DEPENDENCY_UNAVAILABLE');
  log.info({ metric: 'mcp_tool_denied', code: 'INTERNAL_ERROR' }, 'mcp');
  return toolResult(errorBody(requestId, 'DEPENDENCY_UNAVAILABLE', ERRORS.INTERNAL_ERROR, false), true);
}

async function reauthorize(deps: McpToolDeps, token: string, required: readonly KnownScope[]): Promise<McpPrincipal> {
  const result = await deps.verifier.authenticate(deps.pool, token);
  if (!result.ok) {
    throw new ToolDenied(result.status, result.status === 503 ? 'DEPENDENCY_UNAVAILABLE' : 'UNAUTHORIZED');
  }
  for (const scope of required) {
    if (!hasScope(result.principal.scopes, scope)) throw new ToolDenied(403, 'FORBIDDEN');
  }
  return result.principal;
}

function actorOf(principal: McpPrincipal, requestId: string): { organizationId: string; principalId: string; requestId: string } {
  return { organizationId: principal.organizationId, principalId: principal.principalId, requestId };
}

function scoped(principal: McpPrincipal, requestId: string): TagActor & Slice3Actor {
  return { ...actorOf(principal, requestId), scopes: principal.scopes };
}

function agentList(args: z.infer<typeof listAgentsSchema>): { status: AgentStatus | null; limit: number; cursor: string | null } {
  let status: AgentStatus | null = null;
  if (args.status !== undefined) {
    if (!STATUSES.has(args.status)) throw new AgentServiceError(400, 'VALIDATION_ERROR');
    status = args.status;
  }
  return { status, limit: args.limit ?? 25, cursor: args.cursor ?? null };
}

function catalogQuery(args: z.infer<typeof listCapabilitiesSchema>, maxLimit: number): CatalogQuery {
  const id = args.id === undefined ? null : parseCapabilityId(args.id, 422);
  if (args.limit !== undefined && args.limit > maxLimit) throw new Slice3ServiceError(422, 'VALIDATION_ERROR');
  return { id, limit: args.limit ?? Math.min(25, maxLimit), cursor: args.cursor ?? null };
}

async function runTool(deps: McpToolDeps, spec: ToolSpec, token: string, requestId: string, args: unknown): Promise<ToolBody> {
  try {
    const principal = await reauthorize(deps, token, spec.scopes);
    const limits = {
      maxDefinitions: deps.config.tagDefinitionsMaxPerOrg,
      maxPerAgent: deps.config.tagMaxPerAgent,
    };
    const sliceLimits = {
      maxEndpoints: deps.config.maxEndpointsPerAgent,
      maxBindings: deps.config.maxBindingsPerAgent,
      discoveryTimeoutMs: deps.config.discoveryQueryTimeoutMs,
    };
    if (spec.name === 'fad_list_agents') {
      const parsed = listAgentsSchema.parse(args);
      const page = await listAgents(deps.pool, principal.organizationId, agentList(parsed), deps.config.pepper);
      return toolResult(envelope(requestId, page.agents, { limit: page.limit, nextCursor: page.nextCursor }));
    }
    if (spec.name === 'fad_get_agent') {
      const parsed = getAgentSchema.parse(args);
      const agent = await getAgent(deps.pool, principal.organizationId, parsed.agent_id);
      return toolResult(envelope(requestId, agent, { etag: agentEtag(agent.revision) }));
    }
    if (spec.name === 'fad_register_agent') {
      const parsed = registerSchema.parse(args);
      parseIdempotencyKey(parsed.idempotency_key);
      const body: Record<string, unknown> = {
        name: parsed.agent.name,
        owner_principal_id: parsed.agent.owner_principal_id,
      };
      if (parsed.agent.description !== undefined) body.description = parsed.agent.description;
      const result = await registerAgent(deps.pool, actorOf(principal, requestId), parsed.idempotency_key, body);
      return toolResult(envelope(requestId, result.agent, { etag: result.etag }));
    }
    if (spec.name === 'fad_update_agent') {
      const parsed = updateSchema.parse(args);
      parseIdempotencyKey(parsed.idempotency_key);
      const result = await updateAgent(
        deps.pool,
        actorOf(principal, requestId),
        parsed.agent_id,
        parsed.idempotency_key,
        parsed.if_match,
        parsed.patch,
      );
      return toolResult(envelope(requestId, result.agent, { etag: result.etag }));
    }
    if (spec.name === 'fad_suspend_agent' || spec.name === 'fad_activate_agent') {
      const parsed = lifecycleSchema.parse(args);
      parseIdempotencyKey(parsed.idempotency_key);
      const action = spec.name === 'fad_suspend_agent' ? 'suspend' : 'activate';
      const result = await transitionAgent(
        deps.pool,
        actorOf(principal, requestId),
        parsed.agent_id,
        action,
        parsed.idempotency_key,
        parsed.if_match,
        { reason: parsed.reason },
      );
      return toolResult(envelope(requestId, result.agent, { etag: result.etag }));
    }
    if (spec.name === 'fad_list_agent_tags') {
      const parsed = getAgentSchema.parse(args);
      const tags = await listAgentTags(deps.pool, scoped(principal, requestId), parsed.agent_id);
      return toolResult(envelope(requestId, tags));
    }
    if (spec.name === 'fad_put_agent_tag') {
      const parsed = putTagSchema.parse(args);
      parseIdempotencyKey(parsed.idempotency_key);
      const precondition = parseTagPrecondition(parsed.if_match, parsed.if_none_match);
      const input = parseTagPut(parsed.assignment);
      const result = await putAgentTag(
        deps.pool,
        scoped(principal, requestId),
        parsed.agent_id,
        parsed.namespace,
        parsed.key,
        parsed.idempotency_key,
        precondition,
        input,
        limits,
      );
      return toolResult(envelope(requestId, result.assignment ?? null, { etag: result.etag }));
    }
    if (spec.name === 'fad_search_agents_by_tags') {
      const parsed = searchSchema.parse(args);
      if (parsed.query.tags && !hasScope(principal.scopes, 'tags:read')) throw new ToolDenied(403, 'FORBIDDEN');
      const query = parseSearchBody(parsed.query, deps.config.tagSearchMaxPredicates, deps.config.tagSearchMaxLimit);
      const page = await searchAgents(deps.pool, scoped(principal, requestId), query, deps.config.pepper);
      return toolResult(envelope(requestId, page.agents, { limit: page.limit, nextCursor: page.nextCursor }));
    }
    if (spec.name === 'fad_list_capabilities') {
      const parsed = listCapabilitiesSchema.parse(args);
      const page = await listCapabilities(
        deps.pool,
        scoped(principal, requestId),
        catalogQuery(parsed, deps.config.maxCapabilityListLimit),
        deps.config.pepper,
      );
      return toolResult(envelope(requestId, page.capabilities, { limit: page.limit, nextCursor: page.nextCursor }));
    }
    if (spec.name === 'fad_publish_capability') {
      const parsed = publishSchema.parse(args);
      parseIdempotencyKey(parsed.idempotency_key);
      const input = parseCapabilityPublish(parsed.capability);
      const result = await publishCapability(deps.pool, scoped(principal, requestId), parsed.idempotency_key, input);
      return toolResult(envelope(requestId, result.capability ?? null, { etag: result.etag }));
    }
    if (spec.name === 'fad_put_endpoint') {
      const parsed = putEndpointSchema.parse(args);
      parseIdempotencyKey(parsed.idempotency_key);
      parseEndpointKey(parsed.endpoint_key, 422);
      const precondition = parseSlice3Precondition(parsed.if_match, parsed.if_none_match, ENDPOINT_ETAG);
      const input = parseEndpointPut(parsed.endpoint);
      const result = await putEndpoint(
        deps.pool,
        scoped(principal, requestId),
        parsed.agent_id,
        parsed.endpoint_key,
        parsed.idempotency_key,
        precondition,
        input,
        sliceLimits,
      );
      return toolResult(envelope(requestId, result.endpoint ?? null, { etag: result.etag }));
    }
    if (spec.name === 'fad_put_binding') {
      const parsed = putBindingSchema.parse(args);
      parseIdempotencyKey(parsed.idempotency_key);
      const precondition = parseSlice3Precondition(parsed.if_match, parsed.if_none_match, BINDING_ETAG);
      const input = parseBindingPut(parsed.binding);
      const result = await putBinding(
        deps.pool,
        scoped(principal, requestId),
        parsed.agent_id,
        parsed.capability_id,
        parsed.idempotency_key,
        precondition,
        input,
        sliceLimits,
      );
      return toolResult(envelope(requestId, result.binding ?? null, { etag: result.etag }));
    }
    const parsed = discoverSchema.parse(args);
    if (parsed.query.tags && !hasScope(principal.scopes, 'tags:read')) throw new ToolDenied(403, 'FORBIDDEN');
    const query = parseDiscoveryBody(parsed.query, deps.config.maxDiscoveryLimit, deps.config.discoveryMaxPredicates);
    const page = await discoverAgents(deps.pool, scoped(principal, requestId), query, deps.config.pepper, sliceLimits);
    return toolResult(envelope(requestId, page.matches, { limit: page.limit, nextCursor: page.nextCursor }));
  } catch (error) {
    return fail(requestId, error, deps.log);
  }
}

export function buildMcpServer(deps: McpToolDeps, principal: McpPrincipal, requestId: string, token: string): McpServer {
  const server = new McpServer({ name: 'fad', version: '1.4.0' }, { instructions: INSTRUCTIONS });
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: unknown;
      annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
    },
    cb: (args: unknown) => Promise<ToolBody>,
  ) => void;
  for (const spec of TOOLS) {
    if (!allowed(deps.config, principal.scopes, spec)) continue;
    register(spec.name, {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.schema,
      annotations: { readOnlyHint: spec.readOnly, destructiveHint: false },
    }, (args) => runTool(deps, spec, token, requestId, args));
  }
  return server;
}
