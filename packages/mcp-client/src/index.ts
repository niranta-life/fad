import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

const READ_TOOLS = new Set([
  'fad_list_agents',
  'fad_get_agent',
  'fad_list_agent_tags',
  'fad_search_agents_by_tags',
  'fad_list_capabilities',
  'fad_discover_agents',
]);

const WRITE_TOOLS = new Set([
  'fad_register_agent',
  'fad_update_agent',
  'fad_suspend_agent',
  'fad_activate_agent',
  'fad_put_agent_tag',
  'fad_publish_capability',
  'fad_put_endpoint',
  'fad_put_binding',
]);

export const ENABLED_TOOL_NAMES = [
  'fad_list_agents',
  'fad_get_agent',
  'fad_register_agent',
  'fad_update_agent',
  'fad_suspend_agent',
  'fad_activate_agent',
  'fad_list_agent_tags',
  'fad_put_agent_tag',
  'fad_search_agents_by_tags',
  'fad_list_capabilities',
  'fad_publish_capability',
  'fad_put_endpoint',
  'fad_put_binding',
  'fad_discover_agents',
] as const;

export type EnabledFadToolName = (typeof ENABLED_TOOL_NAMES)[number];

export interface FadMcpOptions {
  serverUrl: string;
  tokenProvider: () => Promise<string> | string;
  preferredVersion?: '2026-07-28' | '2025-11-25';
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface FadToolMeta {
  request_id: string;
  api_version: 'v1';
  limit?: number;
  next_cursor?: string | null;
}

export interface FadToolResult<T> {
  data: T;
  meta: FadToolMeta;
  etag?: string;
}

export interface ToolDescriptor {
  name: string;
  description?: string;
}

export class FadMcpToolError extends Error {
  readonly kind = 'tool' as const;
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId: string;

  constructor(code: string, message: string, requestId: string, retryable: boolean) {
    super(message);
    this.name = 'FadMcpToolError';
    this.code = code;
    this.retryable = retryable;
    this.requestId = requestId;
  }
}

export class FadMcpProtocolError extends Error {
  readonly kind = 'protocol' as const;
  readonly rpcCode: number;

  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = 'FadMcpProtocolError';
    this.rpcCode = rpcCode;
  }
}

export class FadMcpHttpError extends Error {
  readonly kind = 'http' as const;
  readonly status: number;
  readonly retryable: boolean;

  constructor(status: number, message: string, retryable: boolean) {
    super(message);
    this.name = 'FadMcpHttpError';
    this.status = status;
    this.retryable = retryable;
  }
}

export class FadMcpAbortError extends Error {
  readonly kind = 'abort' as const;

  constructor() {
    super('The call was aborted.');
    this.name = 'FadMcpAbortError';
  }
}

export class FadMcpIndeterminateError extends Error {
  readonly kind = 'indeterminate' as const;
  readonly idempotencyKey: string | undefined;

  constructor(idempotencyKey: string | undefined) {
    super('The call may have committed. Retry the same arguments and the same idempotency key.');
    this.name = 'FadMcpIndeterminateError';
    this.idempotencyKey = idempotencyKey;
  }
}

export type FadMcpFailure = FadMcpToolError | FadMcpProtocolError | FadMcpHttpError | FadMcpAbortError | FadMcpIndeterminateError;

interface AgentBody {
  name?: string;
  description?: string;
  owner_principal_id?: string;
}

function idempotencyKeyOf(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || !('idempotency_key' in args)) return undefined;
  const value = (args as { idempotency_key?: unknown }).idempotency_key;
  return typeof value === 'string' ? value : undefined;
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as { status?: unknown; statusCode?: unknown; name?: unknown; code?: unknown };
  if (typeof record.status === 'number') return record.status;
  if (typeof record.statusCode === 'number') return record.statusCode;
  const data = (error as { data?: { status?: unknown } }).data;
  if (data && typeof data.status === 'number') return data.status;
  if (record.name === 'UnauthorizedError') return 401;
  if (record.code === 'ClientHttpAuthentication') return 401;
  return undefined;
}

function rpcCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' && code <= -32000 ? code : undefined;
}

function aborted(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'FadMcpAbortError';
}

function retryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as { retryAfter?: unknown; headers?: { get?: (name: string) => string | null } };
  if (typeof record.retryAfter === 'number' && Number.isFinite(record.retryAfter)) return record.retryAfter * 1000;
  const header = record.headers?.get?.('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  return undefined;
}

async function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new FadMcpAbortError());
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function classify(error: unknown, mutation: boolean, key: string | undefined, signal: AbortSignal | undefined): FadMcpFailure {
  if (error instanceof FadMcpToolError || error instanceof FadMcpProtocolError || error instanceof FadMcpHttpError
    || error instanceof FadMcpAbortError || error instanceof FadMcpIndeterminateError) {
    return error;
  }
  const rpc = rpcCode(error);
  if (rpc === -32700 || rpc === -32600 || rpc === -32601 || rpc === -32602) {
    return new FadMcpProtocolError(rpc, 'The MCP request was rejected.');
  }
  const status = httpStatus(error);
  if (status === 401 || status === 403) return new FadMcpHttpError(status, 'Authentication failed.', false);
  if (status === 429) return new FadMcpHttpError(429, 'The request was rate limited.', true);
  if (status === 400 || status === 415 || status === 422) return new FadMcpHttpError(status, 'The request was rejected.', false);
  if (aborted(error, signal)) {
    return mutation ? new FadMcpIndeterminateError(key) : new FadMcpAbortError();
  }
  if (mutation) return new FadMcpIndeterminateError(key);
  if (status === 503 || status === undefined) return new FadMcpHttpError(status ?? 503, 'The service is unavailable.', true);
  return new FadMcpHttpError(status, 'The request failed.', status >= 500);
}

export class FadMcpClient {
  private readonly options: FadMcpOptions;
  private client: Client | undefined;
  private transport: StreamableHTTPClientTransport | undefined;

  constructor(options: FadMcpOptions) {
    if (!options.serverUrl || !options.tokenProvider) throw new FadMcpProtocolError(-32600, 'Client options are incomplete.');
    this.options = options;
  }

  async connect(): Promise<void> {
    const version = this.options.preferredVersion ?? '2026-07-28';
    const client = new Client(
      { name: '@fad/mcp-client', version: '0.1.0' },
      { versionNegotiation: { mode: version === '2025-11-25' ? 'legacy' : { pin: '2026-07-28' } } },
    );
    const transport = new StreamableHTTPClientTransport(new URL(this.options.serverUrl), {
      authProvider: {
        token: async () => this.options.tokenProvider(),
      },
    });
    await client.connect(transport, { timeout: this.timeoutMs(), signal: this.options.signal });
    this.client = client;
    this.transport = transport;
  }

  async listTools(): Promise<readonly ToolDescriptor[]> {
    const client = this.requireClient();
    const listed = await this.withReadRetry(() => client.listTools(undefined, { timeout: this.timeoutMs(), signal: this.options.signal }));
    return listed.tools.map((tool) => ({ name: tool.name, description: tool.description }));
  }

  async callTool<T = unknown>(name: EnabledFadToolName, args: Record<string, unknown>): Promise<FadToolResult<T>> {
    if (!READ_TOOLS.has(name) && !WRITE_TOOLS.has(name)) {
      throw new FadMcpProtocolError(-32602, 'The tool is not enabled.');
    }
    const mutation = WRITE_TOOLS.has(name);
    const key = idempotencyKeyOf(args);
    if (mutation && (key === undefined || !IDEMPOTENCY_KEY.test(key))) {
      throw new FadMcpToolError('VALIDATION_ERROR', 'A caller-chosen idempotency key is required.', '', false);
    }
    const client = this.requireClient();
    const run = async (): Promise<FadToolResult<T>> => {
      const result = await client.callTool(
        { name, arguments: args },
        { timeout: this.timeoutMs(), signal: this.options.signal },
      );
      return this.readResult<T>(result);
    };
    try {
      if (!mutation) return await this.withReadRetry(run);
      return await run();
    } catch (error) {
      throw classify(error, mutation, key, this.options.signal);
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    await client?.close();
    await transport?.close();
  }

  listAgents(args: { status?: 'active' | 'suspended' | 'retired'; limit?: number; cursor?: string } = {}): Promise<FadToolResult<unknown>> {
    return this.callTool('fad_list_agents', args);
  }

  getAgent(args: { agent_id: string }): Promise<FadToolResult<unknown>> {
    return this.callTool('fad_get_agent', args);
  }

  registerAgent(args: { agent: AgentBody; idempotency_key: string }): Promise<FadToolResult<unknown>> {
    return this.callTool('fad_register_agent', args);
  }

  updateAgent(args: { agent_id: string; patch: AgentBody; if_match: string; idempotency_key: string }): Promise<FadToolResult<unknown>> {
    return this.callTool('fad_update_agent', args);
  }

  suspendAgent(args: { agent_id: string; reason: string; if_match: string; idempotency_key: string }): Promise<FadToolResult<unknown>> {
    return this.callTool('fad_suspend_agent', args);
  }

  activateAgent(args: { agent_id: string; reason: string; if_match: string; idempotency_key: string }): Promise<FadToolResult<unknown>> {
    return this.callTool('fad_activate_agent', args);
  }

  listAgentTags(args: { agent_id: string; namespace?: string }): Promise<FadToolResult<unknown>> {
    return this.callTool('fad_list_agent_tags', args);
  }

  putAgentTag(args: Record<string, unknown>): Promise<FadToolResult<unknown>> {
    return this.callTool('fad_put_agent_tag', args);
  }

  searchAgentsByTags(args: { query: Record<string, unknown> }): Promise<FadToolResult<unknown>> {
    return this.callTool('fad_search_agents_by_tags', args);
  }

  listCapabilities(args: { id?: string; limit?: number; cursor?: string } = {}): Promise<FadToolResult<unknown>> {
    return this.callTool('fad_list_capabilities', args);
  }

  publishCapability(args: { capability: Record<string, unknown>; idempotency_key: string }): Promise<FadToolResult<unknown>> {
    return this.callTool('fad_publish_capability', args);
  }

  putEndpoint(args: Record<string, unknown>): Promise<FadToolResult<unknown>> {
    return this.callTool('fad_put_endpoint', args);
  }

  putBinding(args: Record<string, unknown>): Promise<FadToolResult<unknown>> {
    return this.callTool('fad_put_binding', args);
  }

  discoverAgents(args: { query: Record<string, unknown> }): Promise<FadToolResult<unknown>> {
    return this.callTool('fad_discover_agents', args);
  }

  private timeoutMs(): number {
    return this.options.timeoutMs ?? 10_000;
  }

  private requireClient(): Client {
    if (!this.client) throw new FadMcpProtocolError(-32600, 'The client is not connected.');
    return this.client;
  }

  private async withReadRetry<T>(run: () => Promise<T>): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        last = error;
        const failure = classify(error, false, undefined, this.options.signal);
        if (failure instanceof FadMcpAbortError || failure instanceof FadMcpToolError || failure instanceof FadMcpProtocolError) throw failure;
        if (failure instanceof FadMcpHttpError && !failure.retryable) throw failure;
        if (attempt === 2) throw failure;
        const wait = Math.min(retryAfterMs(error) ?? 50 * (attempt + 1), this.timeoutMs());
        await pause(wait, this.options.signal);
      }
    }
    throw classify(last, false, undefined, this.options.signal);
  }

  private readResult<T>(result: { isError?: boolean; structuredContent?: unknown; content?: Array<{ type: string; text?: string }> }): FadToolResult<T> {
    const structured = result.structuredContent;
    const text = result.content?.find((item) => item.type === 'text')?.text;
    let parsed: unknown;
    if (structured && typeof structured === 'object') {
      parsed = structured;
    } else if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        // The SDK reports a schema rejection as plain text with isError set.
        if (result.isError) throw new FadMcpProtocolError(-32602, 'The tool arguments were rejected.');
        throw new FadMcpProtocolError(-32603, 'The tool result has no envelope.');
      }
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new FadMcpProtocolError(-32603, 'The tool result has no envelope.');
    }
    const record = parsed as { error?: { code?: unknown; message?: unknown; retryable?: unknown; request_id?: unknown }; data?: T; meta?: FadToolMeta; etag?: string };
    if (result.isError || record.error) {
      const code = typeof record.error?.code === 'string' ? record.error.code : 'INTERNAL_ERROR';
      const message = typeof record.error?.message === 'string' ? record.error.message : 'The tool failed.';
      const requestId = typeof record.error?.request_id === 'string' ? record.error.request_id : '';
      const retryable = record.error?.retryable === true;
      throw new FadMcpToolError(code, message, requestId, retryable);
    }
    if (!record.meta || record.meta.api_version !== 'v1') {
      throw new FadMcpProtocolError(-32603, 'The tool result has no envelope.');
    }
    return { data: record.data as T, meta: record.meta, etag: record.etag };
  }
}
