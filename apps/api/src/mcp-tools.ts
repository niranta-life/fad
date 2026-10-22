import { hasScope, type KnownScope } from '@fad/auth-core';
import { API_VERSION, ERRORS, type ErrorCode } from '@fad/contract';
import {
  AgentServiceError,
  CommittedDenial,
  EnforcementServiceError,
  EventServiceError,
  BINDING_ETAG,
  ENDPOINT_ETAG,
  IdempotencyConflictError,
  PolicyServiceError,
  Slice3ServiceError,
  TagServiceError,
  agentEtag,
  discoverAgents,
  getAgent,
  getEnforcementConfig,
  getEnforcementDecision,
  createReplay,
  createSubscription,
  getEvent,
  getReplay,
  getSubscription,
  listDeliveries,
  listEvents,
  listSubscriptions,
  patchSubscription,
  rotateSubscriptionSecret,
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
  activatePolicy,
  createPolicy,
  disablePolicy,
  evaluateAgentAccess,
  getPolicy,
  listPolicies,
  updateDraftPolicy,
  preflightEnforcement,
  publishCapability,
  putAgentTag,
  putBinding,
  putEndpoint,
  registerAgent,
  searchAgents,
  setEnforcementConfig,
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
const policyAction = z.enum(['agent.read', 'agent.discover', 'agent.invoke', 'agent.update', 'agent.suspend']);
const policyPredicate = z.strictObject({
  namespace: z.string().min(1).max(40),
  key: z.string().min(1).max(40),
  operator: z.literal('eq'),
  value: tagValue,
});
const policyDefinition = z.strictObject({
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional(),
  effect: z.enum(['allow', 'deny']),
  actions: z.array(policyAction).min(1).max(5),
  subjects: z.strictObject({ principal_ids: z.array(uuid).min(1).max(64) }),
  resource: z.strictObject({
    type: z.literal('agent'),
    agent_ids: z.array(uuid).min(1).max(100).optional(),
    tags_all: z.array(policyPredicate).min(1).max(8).optional(),
  }),
  supersedes_policy_id: z.union([uuid, z.null()]).optional(),
});
const listPoliciesSchema = z.strictObject({
  status: z.enum(['draft', 'active', 'disabled']).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: cursor.optional(),
});
const policyIdSchema = z.strictObject({ policy_id: uuid });
const createPolicySchema = z.strictObject({
  definition: policyDefinition,
  idempotency_key: IDEM,
});
const updatePolicySchema = z.strictObject({
  policy_id: uuid,
  definition: policyDefinition,
  if_match: z.string().min(1).max(100),
  idempotency_key: IDEM,
});
const policyTransitionSchema = z.strictObject({
  policy_id: uuid,
  if_match: z.string().min(1).max(100),
  idempotency_key: IDEM,
});
const evaluateSchema = z.strictObject({
  subject: z.strictObject({ principal_id: uuid }),
  action: policyAction,
  resource: z.strictObject({ type: z.literal('agent'), id: uuid }),
  context: z.strictObject({
    purpose: z.string().min(1).max(100).optional(),
    correlation_id: z.string().min(1).max(128).optional(),
  }).optional(),
});

const enforcementAction = z.enum(['agent.read', 'agent.discover', 'agent.update', 'agent.suspend']);
const enforcementConfigSchema = z.strictObject({});
const enforcementPreflightSchema = z.strictObject({
  mode: z.enum(['shadow', 'enforce']),
  actions: z.array(enforcementAction).min(1).max(4),
  reason: z.string().min(3).max(500),
});
const enforcementSetSchema = z.strictObject({
  mode: z.enum(['off', 'shadow', 'enforce']),
  actions: z.array(enforcementAction).max(4),
  reason: z.string().min(3).max(500),
  preflight_id: uuid.optional(),
  acknowledge_default_deny: z.boolean(),
  if_match: z.string().min(1).max(128),
  idempotency_key: IDEM,
});
const enforcementDecisionSchema = z.strictObject({
  decision_id: uuid,
});
const eventListSchema = z.strictObject({
  type: z.string().min(1).max(120).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: cursor.optional(),
});
const eventIdSchema = z.strictObject({ event_id: uuid });
const subscriptionCreateSchema = z.strictObject({
  callback_url: z.string().min(12).max(2048),
  event_types: z.array(z.string().min(1).max(120)).min(1).max(20),
  description: z.string().max(256).optional(),
  idempotency_key: IDEM,
});
const subscriptionListSchema = z.strictObject({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: cursor.optional(),
});
const subscriptionIdSchema = z.strictObject({ subscription_id: uuid });
const subscriptionPatchSchema = z.strictObject({
  subscription_id: uuid,
  status: z.enum(['active', 'paused', 'disabled']),
  if_match: z.string().min(1).max(100),
  idempotency_key: IDEM,
});
const subscriptionRotateSchema = z.strictObject({
  subscription_id: uuid,
  if_match: z.string().min(1).max(100),
  idempotency_key: IDEM,
});
const replaySchema = z.strictObject({
  subscription_id: uuid,
  after_sequence: z.number().int().min(0),
  through_sequence: z.number().int().min(1),
  reason: z.string().min(1).max(256),
  idempotency_key: IDEM,
});
const replayGetSchema = z.strictObject({ subscription_id: uuid, replay_id: uuid });
const deliveryListSchema = z.strictObject({
  subscription_id: uuid,
  limit: z.number().int().min(1).max(100).optional(),
  cursor: cursor.optional(),
});

interface ToolSpec {
  name: ApprovedMcpTool;
  title: string;
  description: string;
  scopes: readonly KnownScope[];
  readOnly: boolean;
  schema: z.ZodType;
  feature: 'agent' | 'tags' | 'slice3' | 'policy' | 'enforcement' | 'events';
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
  { name: 'fad_list_policies', title: 'List policies', description: 'List visible policies. Restricted policies stay hidden without tags:restricted:read.', scopes: ['policies:read'], readOnly: true, schema: listPoliciesSchema, feature: 'policy' },
  { name: 'fad_get_policy', title: 'Get policy', description: 'Read one visible policy.', scopes: ['policies:read'], readOnly: true, schema: policyIdSchema, feature: 'policy' },
  { name: 'fad_create_policy', title: 'Create policy', description: 'Create a draft policy. This does not activate or enforce it.', scopes: ['policies:write'], readOnly: false, schema: createPolicySchema, feature: 'policy' },
  { name: 'fad_update_draft_policy', title: 'Update draft policy', description: 'Replace a draft policy. Requires if_match and idempotency_key.', scopes: ['policies:write'], readOnly: false, schema: updatePolicySchema, feature: 'policy' },
  { name: 'fad_activate_policy', title: 'Activate policy', description: 'Activate a draft. Requires policies:write and policies:activate. This does not enforce the policy.', scopes: ['policies:write', 'policies:activate'], readOnly: false, schema: policyTransitionSchema, feature: 'policy' },
  { name: 'fad_disable_policy', title: 'Disable policy', description: 'Disable an active policy for later evaluations. Previous decision rows stay.', scopes: ['policies:write', 'policies:activate'], readOnly: false, schema: policyTransitionSchema, feature: 'policy' },
  { name: 'fad_evaluate_access', title: 'Evaluate access', description: 'Record a hypothetical decision. enforcement is not_enforced. This does not invoke an agent.', scopes: ['agents:read'], readOnly: false, schema: evaluateSchema, feature: 'policy' },
  { name: 'fad_get_enforcement_config', title: 'Read enforcement config', description: 'Read this organization enforcement configuration. Requires enforcement:read.', scopes: ['enforcement:read'], readOnly: true, schema: enforcementConfigSchema, feature: 'enforcement' },
  { name: 'fad_preflight_enforcement', title: 'Preflight enforcement', description: 'Check readiness for shadow or enforce. Requires enforcement:manage. Does not change the mode.', scopes: ['enforcement:manage'], readOnly: true, schema: enforcementPreflightSchema, feature: 'enforcement' },
  { name: 'fad_set_enforcement_config', title: 'Set enforcement config', description: 'Change enforcement mode. Requires if_match, idempotency_key, and enforcement:manage.', scopes: ['enforcement:manage'], readOnly: false, schema: enforcementSetSchema, feature: 'enforcement' },
  { name: 'fad_get_enforcement_decision', title: 'Read enforcement decision', description: 'Read one decision in this organization. Requires enforcement:audit.', scopes: ['enforcement:audit'], readOnly: true, schema: enforcementDecisionSchema, feature: 'enforcement' },
  { name: 'fad_list_events', title: 'List events', description: 'List visible directory change events. Requires events:read.', scopes: ['events:read'], readOnly: true, schema: eventListSchema, feature: 'events' },
  { name: 'fad_get_event', title: 'Get event', description: 'Read one visible directory change event. Requires events:read.', scopes: ['events:read'], readOnly: true, schema: eventIdSchema, feature: 'events' },
  { name: 'fad_create_event_subscription', title: 'Create event subscription', description: 'Register a webhook. Requires events:subscribe and idempotency_key.', scopes: ['events:subscribe'], readOnly: false, schema: subscriptionCreateSchema, feature: 'events' },
  { name: 'fad_list_event_subscriptions', title: 'List event subscriptions', description: 'List subscriptions owned by the caller, or all subscriptions with events:manage.', scopes: ['events:subscribe'], readOnly: true, schema: subscriptionListSchema, feature: 'events' },
  { name: 'fad_get_event_subscription', title: 'Get event subscription', description: 'Read one subscription. The signing secret is not returned.', scopes: ['events:subscribe'], readOnly: true, schema: subscriptionIdSchema, feature: 'events' },
  { name: 'fad_update_event_subscription', title: 'Update event subscription', description: 'Pause, resume, or disable a subscription. Requires if_match and idempotency_key.', scopes: ['events:subscribe'], readOnly: false, schema: subscriptionPatchSchema, feature: 'events' },
  { name: 'fad_rotate_event_subscription_secret', title: 'Rotate subscription secret', description: 'Rotate the signing secret. Requires if_match and idempotency_key.', scopes: ['events:subscribe'], readOnly: false, schema: subscriptionRotateSchema, feature: 'events' },
  { name: 'fad_replay_events', title: 'Replay events', description: 'Queue a bounded replay. Requires events:replay, events:read, and events:restricted:read.', scopes: ['events:replay', 'events:read', 'events:restricted:read'], readOnly: false, schema: replaySchema, feature: 'events' },
  { name: 'fad_get_event_replay', title: 'Get event replay', description: 'Read one replay request. Requires events:replay.', scopes: ['events:replay'], readOnly: true, schema: replayGetSchema, feature: 'events' },
  { name: 'fad_list_event_deliveries', title: 'List event deliveries', description: 'List delivery jobs for one subscription. Requires events:delivery:read.', scopes: ['events:delivery:read'], readOnly: true, schema: deliveryListSchema, feature: 'events' },
];

function allowed(config: AppConfig, scopes: readonly string[], spec: ToolSpec): boolean {
  if (spec.feature === 'tags' && !config.tagsEnabled) return false;
  if (spec.feature === 'slice3' && !config.slice3Enabled) return false;
  if (spec.feature === 'policy' && !config.policiesEnabled) return false;
  if (spec.feature === 'enforcement' && !config.enforcementEnabled) return false;
  if (spec.feature === 'events' && !config.eventsEnabled) return false;
  if (config.mcp.toolset && !config.mcp.toolset.has(spec.name)) return false;
  if (spec.name === 'fad_get_event_subscription') {
    return hasScope(scopes, 'events:subscribe') || hasScope(scopes, 'events:manage') || hasScope(scopes, 'events:replay') || hasScope(scopes, 'events:delivery:read');
  }
  if (spec.name === 'fad_list_event_subscriptions' || spec.name === 'fad_update_event_subscription' || spec.name === 'fad_rotate_event_subscription_secret') {
    return hasScope(scopes, 'events:subscribe') || hasScope(scopes, 'events:manage');
  }
  if (spec.name === 'fad_evaluate_access') {
    return hasScope(scopes, 'agents:read')
      && (hasScope(scopes, 'policies:evaluate:self') || hasScope(scopes, 'policies:evaluate:any'));
  }
  return spec.scopes.every((scope) => hasScope(scopes, scope));
}

export function visibleToolNames(config: AppConfig, scopes: readonly string[]): ApprovedMcpTool[] {
  return APPROVED_MCP_TOOLS.filter((name) => {
    const spec = TOOLS.find((item) => item.name === name);
    return spec !== undefined && allowed(config, scopes, spec);
  });
}

function envelope(requestId: string, data: unknown, extra?: { etag?: string; limit?: number; nextCursor?: string | null; hasMore?: boolean }): Record<string, unknown> {
  const meta: Record<string, unknown> = { request_id: requestId, api_version: API_VERSION };
  if (extra && 'limit' in extra) {
    meta.limit = extra.limit;
    meta.next_cursor = extra.nextCursor ?? null;
  }
  if (extra && extra.hasMore !== undefined) meta.has_more = extra.hasMore;
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
  if (code === 'POLICY_DENIED') {
    return toolResult(errorBody(requestId, 'POLICY_DENIED', ERRORS.POLICY_DENIED, false), true);
  }
  if (code === 'ENFORCEMENT_SCAN_BUDGET_EXCEEDED') {
    return toolResult(errorBody(requestId, 'ENFORCEMENT_SCAN_BUDGET_EXCEEDED', ERRORS.ENFORCEMENT_SCAN_BUDGET_EXCEEDED, true), true);
  }
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
  } else if (
    code === 'SECRET_RECEIPT_EXPIRED'
    || code === 'EVENT_SCAN_BUDGET_EXCEEDED'
    || code === 'CURSOR_CONTEXT_CHANGED'
    || code === 'EVENT_CURSOR_EXPIRED'
    || code === 'WEBHOOK_URL_REJECTED'
    || code === 'REPLAY_RANGE_EXPIRED'
    || code === 'DELIVERY_TEMPORARILY_UNAVAILABLE'
    || code === 'INVALID_CURSOR'
  ) {
    const preserved = code as ErrorCode;
    return toolResult(errorBody(requestId, preserved, ERRORS[preserved], status === 503 || status === 429), true);
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
  if (error instanceof CommittedDenial || error instanceof EnforcementServiceError) {
    return mapFailure(requestId, error.statusCode, error.code);
  }
  if (error instanceof EventServiceError || error instanceof AgentServiceError || error instanceof TagServiceError || error instanceof Slice3ServiceError || error instanceof PolicyServiceError) {
    if (error.status === 403 || error.status === 401) log.info({ metric: 'mcp_tool_denied', code: error.code }, 'mcp');
    return mapFailure(requestId, error.status, error.code);
  }
  if (error instanceof ZodError) return mapFailure(requestId, 422, 'VALIDATION_ERROR');
  if (error instanceof IdempotencyConflictError) return mapFailure(requestId, 409, 'IDEMPOTENCY_CONFLICT');
  if (isDependencyError(error)) return mapFailure(requestId, 503, 'DEPENDENCY_UNAVAILABLE');
  log.info({ metric: 'mcp_tool_denied', code: 'INTERNAL_ERROR' }, 'mcp');
  return toolResult(errorBody(requestId, 'DEPENDENCY_UNAVAILABLE', ERRORS.INTERNAL_ERROR, false), true);
}

function mcpRequiredScopes(spec: ToolSpec): readonly KnownScope[] {
  if (spec.name === 'fad_get_event_subscription'
    || spec.name === 'fad_list_event_subscriptions'
    || spec.name === 'fad_update_event_subscription'
    || spec.name === 'fad_rotate_event_subscription_secret') return [];
  return spec.scopes;
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

function actorOf(principal: McpPrincipal, requestId: string): { organizationId: string; principalId: string; requestId: string; scopes: readonly string[]; channel: 'mcp' } {
  return {
    organizationId: principal.organizationId,
    principalId: principal.principalId,
    requestId,
    scopes: principal.scopes,
    channel: 'mcp',
  };
}

function scoped(principal: McpPrincipal, requestId: string): TagActor & Slice3Actor {
  return actorOf(principal, requestId);
}

function eventActor(principal: McpPrincipal, requestId: string) {
  return { ...actorOf(principal, requestId), channel: 'mcp' as const };
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
    const principal = await reauthorize(deps, token, mcpRequiredScopes(spec));
    if (!allowed(deps.config, principal.scopes, spec)) throw new ToolDenied(403, 'FORBIDDEN');
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
      const page = await listAgents(deps.pool, principal.organizationId, agentList(parsed), deps.config.pepper, Date.now(), actorOf(principal, requestId));
      return toolResult(envelope(requestId, page.agents, { limit: page.limit, nextCursor: page.nextCursor }));
    }
    if (spec.name === 'fad_get_agent') {
      const parsed = getAgentSchema.parse(args);
      const agent = await getAgent(deps.pool, principal.organizationId, parsed.agent_id, actorOf(principal, requestId));
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
    if (spec.name === 'fad_list_policies') {
      const parsed = listPoliciesSchema.parse(args);
      const query: Record<string, string> = {};
      if (parsed.status) query.status = parsed.status;
      if (parsed.limit !== undefined) query.limit = String(parsed.limit);
      if (parsed.cursor) query.cursor = parsed.cursor;
      const page = await listPolicies(deps.pool, scoped(principal, requestId), query, deps.config.pepper);
      return toolResult({
        data: page.policies,
        page: { next_cursor: page.nextCursor },
        meta: { request_id: requestId, api_version: API_VERSION },
      });
    }
    if (spec.name === 'fad_get_policy') {
      const parsed = policyIdSchema.parse(args);
      const loaded = await getPolicy(deps.pool, scoped(principal, requestId), parsed.policy_id);
      return toolResult(envelope(requestId, loaded.policy, { etag: loaded.etag }));
    }
    if (spec.name === 'fad_create_policy') {
      const parsed = createPolicySchema.parse(args);
      parseIdempotencyKey(parsed.idempotency_key);
      const result = await createPolicy(deps.pool, scoped(principal, requestId), parsed.idempotency_key, parsed.definition);
      return toolResult(envelope(requestId, result.policy, { etag: result.etag }));
    }
    if (spec.name === 'fad_update_draft_policy') {
      const parsed = updatePolicySchema.parse(args);
      parseIdempotencyKey(parsed.idempotency_key);
      const result = await updateDraftPolicy(
        deps.pool,
        scoped(principal, requestId),
        parsed.policy_id,
        parsed.idempotency_key,
        parsed.if_match,
        parsed.definition,
      );
      return toolResult(envelope(requestId, result.policy, { etag: result.etag }));
    }
    if (spec.name === 'fad_activate_policy' || spec.name === 'fad_disable_policy') {
      const parsed = policyTransitionSchema.parse(args);
      parseIdempotencyKey(parsed.idempotency_key);
      const command = spec.name === 'fad_activate_policy' ? activatePolicy : disablePolicy;
      const result = await command(
        deps.pool,
        scoped(principal, requestId),
        parsed.policy_id,
        parsed.idempotency_key,
        parsed.if_match,
      );
      return toolResult(envelope(requestId, result.policy, { etag: result.etag }));
    }
    if (spec.name === 'fad_evaluate_access') {
      const parsed = evaluateSchema.parse(args);
      const result = await evaluateAgentAccess(deps.pool, scoped(principal, requestId), parsed);
      return toolResult(envelope(requestId, result.body));
    }
    if (spec.name === 'fad_get_enforcement_config') {
      enforcementConfigSchema.parse(args);
      const loaded = await getEnforcementConfig(deps.pool, actorOf(principal, requestId));
      return toolResult(envelope(requestId, loaded.config, { etag: loaded.etag }));
    }
    if (spec.name === 'fad_preflight_enforcement') {
      const parsed = enforcementPreflightSchema.parse(args);
      const result = await preflightEnforcement(deps.pool, actorOf(principal, requestId), parsed);
      return toolResult(envelope(requestId, result));
    }
    if (spec.name === 'fad_set_enforcement_config') {
      const parsed = enforcementSetSchema.parse(args);
      parseIdempotencyKey(parsed.idempotency_key);
      const body: Record<string, unknown> = {
        mode: parsed.mode,
        actions: parsed.actions,
        reason: parsed.reason,
        acknowledge_default_deny: parsed.acknowledge_default_deny,
      };
      if (parsed.preflight_id !== undefined) body.preflight_id = parsed.preflight_id;
      const result = await setEnforcementConfig(deps.pool, actorOf(principal, requestId), parsed.idempotency_key, parsed.if_match, body);
      return toolResult(envelope(requestId, result.config, { etag: result.etag }));
    }
    if (spec.name === 'fad_get_enforcement_decision') {
      const parsed = enforcementDecisionSchema.parse(args);
      const decision = await getEnforcementDecision(deps.pool, actorOf(principal, requestId), parsed.decision_id);
      return toolResult(envelope(requestId, decision));
    }
    if (spec.name === 'fad_list_events') {
      const parsed = eventListSchema.parse(args);
      const page = await listEvents(deps.pool, eventActor(principal, requestId), parsed, deps.config.pepper);
      return toolResult(envelope(requestId, page.events, { limit: page.limit, nextCursor: page.nextCursor, hasMore: page.hasMore }));
    }
    if (spec.name === 'fad_get_event') {
      const parsed = eventIdSchema.parse(args);
      const event = await getEvent(deps.pool, eventActor(principal, requestId), parsed.event_id);
      return toolResult(envelope(requestId, event));
    }
    if (spec.name === 'fad_create_event_subscription') {
      const parsed = subscriptionCreateSchema.parse(args);
      parseIdempotencyKey(parsed.idempotency_key);
      const result = await createSubscription(deps.pool, eventActor(principal, requestId), parsed.idempotency_key, {
        callback_url: parsed.callback_url,
        event_types: parsed.event_types,
        ...(parsed.description === undefined ? {} : { description: parsed.description }),
      });
      return toolResult(envelope(requestId, result.body, { etag: result.etag }));
    }
    if (spec.name === 'fad_list_event_subscriptions') {
      const parsed = subscriptionListSchema.parse(args);
      const page = await listSubscriptions(deps.pool, eventActor(principal, requestId), parsed, deps.config.pepper);
      return toolResult(envelope(requestId, page.subscriptions, { limit: page.limit, nextCursor: page.nextCursor, hasMore: page.hasMore }));
    }
    if (spec.name === 'fad_get_event_subscription') {
      const parsed = subscriptionIdSchema.parse(args);
      const loaded = await getSubscription(deps.pool, eventActor(principal, requestId), parsed.subscription_id);
      return toolResult(envelope(requestId, loaded.subscription, { etag: loaded.etag }));
    }
    if (spec.name === 'fad_update_event_subscription') {
      const parsed = subscriptionPatchSchema.parse(args);
      parseIdempotencyKey(parsed.idempotency_key);
      const result = await patchSubscription(
        deps.pool,
        eventActor(principal, requestId),
        parsed.subscription_id,
        parsed.idempotency_key,
        parsed.if_match,
        { status: parsed.status },
      );
      return toolResult(envelope(requestId, result.subscription, { etag: result.etag }));
    }
    if (spec.name === 'fad_rotate_event_subscription_secret') {
      const parsed = subscriptionRotateSchema.parse(args);
      parseIdempotencyKey(parsed.idempotency_key);
      const result = await rotateSubscriptionSecret(
        deps.pool,
        eventActor(principal, requestId),
        parsed.subscription_id,
        parsed.idempotency_key,
        parsed.if_match,
      );
      return toolResult(envelope(requestId, result.body, { etag: result.etag }));
    }
    if (spec.name === 'fad_replay_events') {
      const parsed = replaySchema.parse(args);
      parseIdempotencyKey(parsed.idempotency_key);
      const result = await createReplay(deps.pool, eventActor(principal, requestId), parsed.subscription_id, parsed.idempotency_key, {
        after_sequence: parsed.after_sequence,
        through_sequence: parsed.through_sequence,
        reason: parsed.reason,
      });
      return toolResult(envelope(requestId, result.replay));
    }
    if (spec.name === 'fad_get_event_replay') {
      const parsed = replayGetSchema.parse(args);
      const replay = await getReplay(deps.pool, eventActor(principal, requestId), parsed.subscription_id, parsed.replay_id);
      return toolResult(envelope(requestId, replay));
    }
    if (spec.name === 'fad_list_event_deliveries') {
      const parsed = deliveryListSchema.parse(args);
      const page = await listDeliveries(deps.pool, eventActor(principal, requestId), parsed.subscription_id, parsed, deps.config.pepper);
      return toolResult(envelope(requestId, page.deliveries, { limit: page.limit, nextCursor: page.nextCursor, hasMore: page.hasMore }));
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
