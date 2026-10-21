export interface FadClientOptions {
  baseUrl: string;
  apiKey?: string | (() => Promise<string> | string);
  /** Same role as apiKey. Use one of them. apiKey wins when both are set. */
  credentialProvider?: () => Promise<string> | string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  maxGetRetries?: number;
  maxRetryAfterMs?: number;
  userAgentSuffix?: string;
  /** Allows http only for loopback hosts. Non-loopback cleartext is rejected. */
  allowInsecureHttp?: boolean;
  /** Test seam. Production uses Date.now. */
  now?: () => number;
  /** Test seam in [0, 1). Production uses Math.random. */
  random?: () => number;
  /** Test seam. Production waits on the caller signal. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface Organization {
  id: string;
  name: string;
  status: 'active' | 'suspended' | (string & {});
  created_at: string;
}

export interface FadResponse<T> {
  data: T;
  meta: { request_id: string; api_version: 'v1'; [key: string]: unknown };
}

export type AgentStatus = 'active' | 'suspended' | 'retired';

export interface Agent {
  id: string;
  global_id: string;
  organization_id: string;
  name: string;
  description: string;
  owner_principal_id: string;
  status: AgentStatus;
  revision: number;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
}

export interface AgentCreate {
  name: string;
  description?: string;
  owner_principal_id: string;
}

export interface AgentUpdate {
  name?: string;
  description?: string | null;
  owner_principal_id?: string;
}

export interface LifecycleRequest {
  reason: string;
}

export interface AgentResult extends FadResponse<Agent> {
  etag: string;
  location?: string;
}

export interface AgentPage {
  data: Agent[];
  meta: { request_id: string; api_version: 'v1'; limit: number; next_cursor: string | null };
}

export interface AgentListQuery {
  status?: AgentStatus;
  limit?: number;
  cursor?: string;
}

export type TagValue = string | number | boolean;
export type TagType = 'string' | 'integer' | 'boolean' | 'enum';
export type TagVisibility = 'internal' | 'restricted';

export interface TagDefinitionCreate {
  namespace: string;
  key: string;
  value_type: TagType;
  enum_values?: string[];
  governed: boolean;
  visibility: TagVisibility;
  description?: string;
}

export interface TagDefinition {
  organization_id: string;
  namespace: string;
  key: string;
  value_type: TagType;
  enum_values: string[] | null;
  governed: boolean;
  visibility: TagVisibility;
  description: string;
  created_by: string;
  created_at: string;
}

export interface TagDefinitionResult extends FadResponse<TagDefinition> {
  location?: string;
}

export interface TagDefinitionListQuery {
  namespace?: string;
  limit?: number;
  cursor?: string;
}

export interface TagDefinitionPage {
  data: TagDefinition[];
  meta: { request_id: string; api_version: 'v1'; limit: number; next_cursor: string | null };
}

export interface AgentTag {
  agent_id: string;
  namespace: string;
  key: string;
  value: TagValue;
  revision: number;
  governed: boolean;
  visibility: TagVisibility;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface AgentTagResult extends FadResponse<AgentTag> {
  etag: string;
  location?: string;
}

export interface AgentTagPut {
  value: TagValue;
  reason?: string;
}

export interface TagPutOptions extends IdempotentOptions {
  ifMatch?: string;
  ifNoneMatch?: '*';
}

export interface TagDeleteOptions extends IdempotentOptions {
  ifMatch: string;
  reason?: string;
}

export interface SearchPredicate {
  namespace: string;
  key: string;
  operator: 'eq';
  value: TagValue;
}

export interface AgentSearchInput {
  tags?: SearchPredicate[];
  status?: AgentStatus;
  limit?: number;
  cursor?: string;
}

interface IdempotentOptions extends CallOptions {
  idempotencyKey: string;
}

interface PreconditionOptions extends IdempotentOptions {
  ifMatch: string;
}

export class FadApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;

  constructor(status: number, code: string, message: string, requestId?: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'FadApiError';
    this.status = status;
    this.code = code;
    if (requestId !== undefined) this.requestId = requestId;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface CallOptions {
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_AFTER_CAP_MS = 30_000;

function loopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export function assertBaseUrl(baseUrl: string, allowInsecureHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('baseUrl is not a URL');
  }
  if (url.username || url.password) throw new Error('baseUrl must not contain credentials');
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && loopback(url.hostname) && allowInsecureHttp) return url;
  throw new Error('HTTPS is required');
}

function scrub(text: string, secret: string): string {
  if (secret.length === 0) return text;
  return text.split(secret).join('[REDACTED]');
}

function abortError(name: string): Error {
  const error = new Error(name === 'TimeoutError' ? 'The operation timed out' : 'The operation was aborted');
  error.name = name === 'TimeoutError' ? 'TimeoutError' : 'AbortError';
  return error;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function isRedirect(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (/redirect/i.test(error.message)) return true;
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error && /redirect/i.test(cause.message);
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal.reason instanceof Error ? signal.reason.name : 'AbortError'));
    };
    if (signal.aborted) {
      clearTimeout(timer);
      reject(abortError(signal.reason instanceof Error ? signal.reason.name : 'AbortError'));
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const BACKOFF_BASE_MS = 200;

function unitInterval(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Wait for one GET retry. Retry-After is capped by the client cap and the time left on the deadline. Otherwise the wait is exponential with equal jitter. */
function retryWaitMs(input: {
  attempt: number;
  retryAfterHeader: string | null;
  maxRetryAfterMs: number;
  remainingMs: number;
  random: () => number;
}): number {
  if (input.remainingMs <= 0) return 0;
  const header = input.retryAfterHeader?.trim() ?? '';
  let desired: number;
  if (/^\d+$/.test(header)) {
    desired = Number(header) * 1000;
  } else {
    const exponential = Math.min(input.maxRetryAfterMs, BACKOFF_BASE_MS * 2 ** Math.max(0, input.attempt - 1));
    const jitter = unitInterval(input.random);
    desired = Math.floor(exponential / 2 + jitter * (exponential / 2));
  }
  return Math.max(0, Math.min(input.maxRetryAfterMs, desired, input.remainingMs));
}

export class FadClient {
  private readonly baseUrl: URL;
  private readonly apiKey: string | (() => Promise<string> | string);
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly maxGetRetries: number;
  private readonly maxRetryAfterMs: number;
  private readonly userAgent: string;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(options: FadClientOptions) {
    this.baseUrl = assertBaseUrl(options.baseUrl, options.allowInsecureHttp === true);
    const provider = options.apiKey ?? options.credentialProvider;
    if (provider === undefined) throw new Error('apiKey is empty');
    this.apiKey = provider;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 120_000) {
      throw new Error('timeoutMs is out of range');
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.maxGetRetries = options.maxGetRetries ?? DEFAULT_RETRIES;
    if (!Number.isInteger(this.maxGetRetries) || this.maxGetRetries < 0 || this.maxGetRetries > 5) {
      throw new Error('maxGetRetries is out of range');
    }
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_RETRY_AFTER_CAP_MS;
    const suffix = options.userAgentSuffix ? ` ${options.userAgentSuffix}` : '';
    this.userAgent = `@fad/sdk/0.3.0${suffix}`;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? delay;
  }

  readonly health = {
    live: (options?: CallOptions): Promise<{ status: 'ok' }> => this.healthCall('/health/live', 'ok', options),
    ready: (options?: CallOptions): Promise<{ status: 'ready' | 'not_ready' }> =>
      this.healthCall('/health/ready', 'ready', options),
  };

  readonly organizations = {
    current: (options?: CallOptions): Promise<FadResponse<Organization>> => this.currentOrganization(options),
  };

  readonly agents = {
    register: (body: AgentCreate, options: IdempotentOptions): Promise<AgentResult> =>
      this.agentWrite('/v1/agents', 'POST', body, options, false),
    get: (agentId: string, options?: CallOptions): Promise<AgentResult> =>
      this.agentRead(`/v1/agents/${encodeURIComponent(agentId)}`, options),
    list: (query: AgentListQuery = {}, options?: CallOptions): Promise<AgentPage> => this.agentList(query, options),
    update: (agentId: string, body: AgentUpdate, options: PreconditionOptions): Promise<AgentResult> =>
      this.agentWrite(`/v1/agents/${encodeURIComponent(agentId)}`, 'PATCH', body, options, true),
    suspend: (agentId: string, body: LifecycleRequest, options: PreconditionOptions): Promise<AgentResult> =>
      this.agentWrite(`/v1/agents/${encodeURIComponent(agentId)}/suspend`, 'POST', body, options, true),
    activate: (agentId: string, body: LifecycleRequest, options: PreconditionOptions): Promise<AgentResult> =>
      this.agentWrite(`/v1/agents/${encodeURIComponent(agentId)}/activate`, 'POST', body, options, true),
    retire: (agentId: string, body: LifecycleRequest, options: PreconditionOptions): Promise<AgentResult> =>
      this.agentWrite(`/v1/agents/${encodeURIComponent(agentId)}/retire`, 'POST', body, options, true),
    iterate: (query: AgentListQuery = {}, options?: CallOptions): AsyncGenerator<Agent> => this.iterateAgents(query, options),
    search: (body: AgentSearchInput, options?: CallOptions): Promise<AgentPage> => this.agentSearch(body, options),
    iterateSearch: (body: AgentSearchInput, options?: CallOptions): AsyncGenerator<Agent> => this.iterateSearch(body, options),
  };

  readonly tagDefinitions = {
    create: (body: TagDefinitionCreate, options: IdempotentOptions): Promise<TagDefinitionResult> =>
      this.definitionCreate(body, options),
    get: (namespace: string, key: string, options?: CallOptions): Promise<FadResponse<TagDefinition>> =>
      this.definitionGet(namespace, key, options),
    list: (query: TagDefinitionListQuery = {}, options?: CallOptions): Promise<TagDefinitionPage> =>
      this.definitionList(query, options),
    iterate: (query: TagDefinitionListQuery = {}, options?: CallOptions): AsyncGenerator<TagDefinition> =>
      this.iterateDefinitions(query, options),
  };

  readonly agentTags = {
    list: (agentId: string, options?: CallOptions): Promise<FadResponse<AgentTag[]>> => this.tagList(agentId, options),
    get: (agentId: string, namespace: string, key: string, options?: CallOptions): Promise<AgentTagResult> =>
      this.tagGet(agentId, namespace, key, options),
    put: (agentId: string, namespace: string, key: string, body: AgentTagPut, options: TagPutOptions): Promise<AgentTagResult> =>
      this.tagPut(agentId, namespace, key, body, options),
    delete: (agentId: string, namespace: string, key: string, options: TagDeleteOptions): Promise<{ requestId?: string }> =>
      this.tagDelete(agentId, namespace, key, options),
  };

  private async healthCall<T extends { status: string }>(
    path: string,
    okStatus: string,
    options?: CallOptions,
  ): Promise<T> {
    const response = await this.send(path, false, options?.signal);
    const body = await readJson(response, '');
    if (response.status === 200 && isRecord(body) && body.status === okStatus) {
      return body as T;
    }
    if (path === '/health/ready' && response.status === 503 && isRecord(body) && body.status === 'not_ready') {
      return body as T;
    }
    throw errorFrom(response, body, '');
  }

  private async currentOrganization(options?: CallOptions): Promise<FadResponse<Organization>> {
    const key = await this.resolveKey();
    const response = await this.send('/v1/organizations/current', true, options?.signal, key);
    const body = await readJson(response, key);
    if (response.status === 200 && isOrganizationResponse(body)) return body;
    throw errorFrom(response, body, key);
  }

  private async resolveKey(): Promise<string> {
    const value = typeof this.apiKey === 'function' ? await this.apiKey() : this.apiKey;
    if (typeof value !== 'string' || value.length === 0) throw new Error('apiKey is empty');
    return value;
  }

  private async send(path: string, authenticated: boolean, signal?: AbortSignal, key = ''): Promise<Response> {
    const started = this.now();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signals = signal ? [timeout, signal] : [timeout];
    const combined = AbortSignal.any(signals);
    const url = new URL(path, this.baseUrl);
    let attempt = 0;
    while (true) {
      if (combined.aborted) {
        throw abortError(combined.reason instanceof Error ? combined.reason.name : 'AbortError');
      }
      const headers = new Headers({ accept: 'application/json', 'user-agent': this.userAgent });
      if (authenticated) headers.set('X-FAD-API-Key', key);
      let response: Response;
      try {
        response = await this.fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal: combined });
      } catch (error) {
        if (isAbort(error) || (error instanceof Error && error.name === 'AbortError')) {
          throw abortError(error instanceof Error ? error.name : 'AbortError');
        }
        if (isRedirect(error)) {
          const redirect = new Error('Redirects are not followed.');
          redirect.name = 'FadRedirectError';
          throw redirect;
        }
        const remaining = this.timeoutMs - (this.now() - started);
        if (attempt < this.maxGetRetries && remaining > 0) {
          const wait = retryWaitMs({
            attempt: attempt + 1,
            retryAfterHeader: null,
            maxRetryAfterMs: this.maxRetryAfterMs,
            remainingMs: remaining,
            random: this.random,
          });
          if (!(wait >= remaining && wait > 0)) {
            attempt += 1;
            await this.sleep(wait, combined);
            if (this.now() - started < this.timeoutMs) continue;
          }
        }
        const wrapped = new Error('Network request failed');
        wrapped.name = 'FadNetworkError';
        throw wrapped;
      }
      const retryable = response.status === 429 || response.status === 503;
      const remaining = this.timeoutMs - (this.now() - started);
      if (retryable && attempt < this.maxGetRetries && remaining > 0) {
        const wait = retryWaitMs({
          attempt: attempt + 1,
          retryAfterHeader: response.headers.get('retry-after'),
          maxRetryAfterMs: this.maxRetryAfterMs,
          remainingMs: remaining,
          random: this.random,
        });
        if (wait >= remaining && wait > 0) return response;
        attempt += 1;
        await response.arrayBuffer().catch(() => undefined);
        await this.sleep(wait, combined);
        if (this.now() - started >= this.timeoutMs) return response;
        continue;
      }
      return response;
    }
  }

  private async sendJson(
    path: string,
    method: 'POST' | 'PATCH' | 'PUT',
    body: unknown,
    extraHeaders: Record<string, string>,
    signal: AbortSignal | undefined,
    key: string,
  ): Promise<Response> {
    const started = this.now();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = AbortSignal.any(signal ? [timeout, signal] : [timeout]);
    const url = new URL(path, this.baseUrl);
    const payload = JSON.stringify(body);
    let attempt = 0;
    while (true) {
      if (combined.aborted) {
        throw abortError(combined.reason instanceof Error ? combined.reason.name : 'AbortError');
      }
      const headers = new Headers({
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': this.userAgent,
      });
      headers.set('X-FAD-API-Key', key);
      for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
      let response: Response;
      try {
        response = await this.fetchImpl(url, { method, headers, body: payload, redirect: 'error', signal: combined });
      } catch (error) {
        if (isAbort(error)) throw abortError(error instanceof Error ? error.name : 'AbortError');
        if (isRedirect(error)) {
          const redirect = new Error('Redirects are not followed.');
          redirect.name = 'FadRedirectError';
          throw redirect;
        }
        const remaining = this.timeoutMs - (this.now() - started);
        if (attempt < this.maxGetRetries && remaining > 0) {
          const wait = retryWaitMs({
            attempt: attempt + 1,
            retryAfterHeader: null,
            maxRetryAfterMs: this.maxRetryAfterMs,
            remainingMs: remaining,
            random: this.random,
          });
          if (!(wait >= remaining && wait > 0)) {
            attempt += 1;
            await this.sleep(wait, combined);
            if (this.now() - started < this.timeoutMs) continue;
          }
        }
        const wrapped = new Error('Network request failed');
        wrapped.name = 'FadNetworkError';
        throw wrapped;
      }
      const retryable = response.status === 429 || response.status === 503;
      const remaining = this.timeoutMs - (this.now() - started);
      if (retryable && attempt < this.maxGetRetries && remaining > 0) {
        const wait = retryWaitMs({
          attempt: attempt + 1,
          retryAfterHeader: response.headers.get('retry-after'),
          maxRetryAfterMs: this.maxRetryAfterMs,
          remainingMs: remaining,
          random: this.random,
        });
        if (wait >= remaining && wait > 0) return response;
        attempt += 1;
        await response.arrayBuffer().catch(() => undefined);
        await this.sleep(wait, combined);
        if (this.now() - started >= this.timeoutMs) return response;
        continue;
      }
      return response;
    }
  }

  private async agentWrite(
    path: string,
    method: 'POST' | 'PATCH',
    body: unknown,
    options: IdempotentOptions | PreconditionOptions,
    precondition: boolean,
  ): Promise<AgentResult> {
    if (typeof options.idempotencyKey !== 'string' || options.idempotencyKey.length === 0) {
      throw new Error('idempotencyKey is required');
    }
    const headers: Record<string, string> = { 'Idempotency-Key': options.idempotencyKey };
    if (precondition) {
      const tag = (options as PreconditionOptions).ifMatch;
      if (typeof tag !== 'string' || tag.length === 0) throw new Error('ifMatch is required');
      headers['If-Match'] = tag;
    }
    const key = await this.resolveKey();
    const response = await this.sendJson(path, method, body, headers, options.signal, key);
    const parsed = await readJson(response, key);
    if ((response.status === 200 || response.status === 201) && isAgentResponse(parsed)) {
      const etag = response.headers.get('etag') ?? '';
      if (!/^"agent-v[1-9][0-9]*"$/.test(etag)) {
        throw new FadApiError(response.status, 'INVALID_RESPONSE', 'Response did not include a strong ETag', headerRequestId(response));
      }
      const location = response.headers.get('location') ?? undefined;
      return location ? { ...parsed, etag, location } : { ...parsed, etag };
    }
    throw errorFrom(response, parsed, key);
  }

  private async agentRead(path: string, options?: CallOptions): Promise<AgentResult> {
    const key = await this.resolveKey();
    const response = await this.send(path, true, options?.signal, key);
    const parsed = await readJson(response, key);
    if (response.status === 200 && isAgentResponse(parsed)) {
      const etag = response.headers.get('etag') ?? '';
      if (!/^"agent-v[1-9][0-9]*"$/.test(etag)) {
        throw new FadApiError(response.status, 'INVALID_RESPONSE', 'Response did not include a strong ETag', headerRequestId(response));
      }
      return { ...parsed, etag };
    }
    throw errorFrom(response, parsed, key);
  }

  private async agentList(query: AgentListQuery, options?: CallOptions): Promise<AgentPage> {
    const params = new URLSearchParams();
    if (query.status) params.set('status', query.status);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor) params.set('cursor', query.cursor);
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    const key = await this.resolveKey();
    const response = await this.send(`/v1/agents${suffix}`, true, options?.signal, key);
    const parsed = await readJson(response, key);
    if (response.status === 200 && isAgentPage(parsed)) return parsed;
    throw errorFrom(response, parsed, key);
  }

  private async *iterateAgents(query: AgentListQuery, options?: CallOptions): AsyncGenerator<Agent> {
    let cursor = query.cursor;
    for (;;) {
      const page = await this.agentList({ ...query, cursor }, options);
      for (const agent of page.data) yield agent;
      const next = page.meta.next_cursor;
      if (next === null || next === cursor) return;
      cursor = next;
    }
  }

  private async definitionCreate(body: TagDefinitionCreate, options: IdempotentOptions): Promise<TagDefinitionResult> {
    requireKey(options.idempotencyKey);
    const key = await this.resolveKey();
    const response = await this.sendJson('/v1/tag-definitions', 'POST', body, {
      'Idempotency-Key': options.idempotencyKey,
    }, options.signal, key);
    const parsed = await readJson(response, key);
    if (response.status === 201 && isTagDefinitionResponse(parsed)) {
      const location = response.headers.get('location') ?? undefined;
      return location ? { ...parsed, location } : parsed;
    }
    throw errorFrom(response, parsed, key);
  }

  private async definitionGet(namespace: string, keyName: string, options?: CallOptions): Promise<FadResponse<TagDefinition>> {
    const key = await this.resolveKey();
    const path = `/v1/tag-definitions/${encodeURIComponent(namespace)}/${encodeURIComponent(keyName)}`;
    const response = await this.send(path, true, options?.signal, key);
    const parsed = await readJson(response, key);
    if (response.status === 200 && isTagDefinitionResponse(parsed)) return parsed;
    throw errorFrom(response, parsed, key);
  }

  private async definitionList(query: TagDefinitionListQuery, options?: CallOptions): Promise<TagDefinitionPage> {
    const params = new URLSearchParams();
    if (query.namespace) params.set('namespace', query.namespace);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor) params.set('cursor', query.cursor);
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    const key = await this.resolveKey();
    const response = await this.send(`/v1/tag-definitions${suffix}`, true, options?.signal, key);
    const parsed = await readJson(response, key);
    if (response.status === 200 && isTagDefinitionPage(parsed)) return parsed;
    throw errorFrom(response, parsed, key);
  }

  private async *iterateDefinitions(query: TagDefinitionListQuery, options?: CallOptions): AsyncGenerator<TagDefinition> {
    let cursor = query.cursor;
    for (;;) {
      const page = await this.definitionList({ ...query, cursor }, options);
      for (const item of page.data) yield item;
      const next = page.meta.next_cursor;
      if (next === null || next === cursor) return;
      cursor = next;
    }
  }

  private async tagList(agentId: string, options?: CallOptions): Promise<FadResponse<AgentTag[]>> {
    const key = await this.resolveKey();
    const response = await this.send(`/v1/agents/${encodeURIComponent(agentId)}/tags`, true, options?.signal, key);
    const parsed = await readJson(response, key);
    if (response.status === 200 && isRecord(parsed) && Array.isArray(parsed.data) && parsed.data.every((item) => isAgentTag(item))
      && isRecord(parsed.meta) && parsed.meta.api_version === 'v1') {
      return parsed as unknown as FadResponse<AgentTag[]>;
    }
    throw errorFrom(response, parsed, key);
  }

  private async tagGet(agentId: string, namespace: string, keyName: string, options?: CallOptions): Promise<AgentTagResult> {
    const key = await this.resolveKey();
    const path = `/v1/agents/${encodeURIComponent(agentId)}/tags/${encodeURIComponent(namespace)}/${encodeURIComponent(keyName)}`;
    const response = await this.send(path, true, options?.signal, key);
    const parsed = await readJson(response, key);
    if (response.status === 200 && isAgentTagResponse(parsed)) return withTagEtag(response, parsed);
    throw errorFrom(response, parsed, key);
  }

  private async tagPut(
    agentId: string,
    namespace: string,
    keyName: string,
    body: AgentTagPut,
    options: TagPutOptions,
  ): Promise<AgentTagResult> {
    requireKey(options.idempotencyKey);
    assertTagValue(body.value);
    const match = options.ifMatch !== undefined;
    const none = options.ifNoneMatch !== undefined;
    if (match === none) throw new Error('exactly one of ifMatch or ifNoneMatch is required');
    if (none && options.ifNoneMatch !== '*') throw new Error('ifNoneMatch must be *');
    const headers: Record<string, string> = { 'Idempotency-Key': options.idempotencyKey };
    if (match && options.ifMatch) headers['If-Match'] = options.ifMatch;
    if (none) headers['If-None-Match'] = '*';
    const key = await this.resolveKey();
    const path = `/v1/agents/${encodeURIComponent(agentId)}/tags/${encodeURIComponent(namespace)}/${encodeURIComponent(keyName)}`;
    const response = await this.sendJson(path, 'PUT', { value: body.value, ...(body.reason !== undefined ? { reason: body.reason } : {}) }, headers, options.signal, key);
    const parsed = await readJson(response, key);
    if ((response.status === 200 || response.status === 201) && isAgentTagResponse(parsed)) {
      const result = withTagEtag(response, parsed);
      const location = response.headers.get('location') ?? undefined;
      return location ? { ...result, location } : result;
    }
    throw errorFrom(response, parsed, key);
  }

  private async tagDelete(
    agentId: string,
    namespace: string,
    keyName: string,
    options: TagDeleteOptions,
  ): Promise<{ requestId?: string }> {
    requireKey(options.idempotencyKey);
    if (typeof options.ifMatch !== 'string' || options.ifMatch.length === 0) throw new Error('ifMatch is required');
    const headers: Record<string, string> = {
      'Idempotency-Key': options.idempotencyKey,
      'If-Match': options.ifMatch,
    };
    if (options.reason !== undefined) headers['X-Change-Reason'] = options.reason;
    const key = await this.resolveKey();
    const path = `/v1/agents/${encodeURIComponent(agentId)}/tags/${encodeURIComponent(namespace)}/${encodeURIComponent(keyName)}`;
    const response = await this.sendNoBody(path, 'DELETE', headers, options.signal, key);
    if (response.status === 204) return { requestId: headerRequestId(response) };
    const parsed = await readJson(response, key);
    throw errorFrom(response, parsed, key);
  }

  private async agentSearch(body: AgentSearchInput, options?: CallOptions): Promise<AgentPage> {
    const key = await this.resolveKey();
    const response = await this.sendJson('/v1/agents/search', 'POST', body, {}, options?.signal, key);
    const parsed = await readJson(response, key);
    if (response.status === 200 && isAgentPage(parsed)) return parsed;
    throw errorFrom(response, parsed, key);
  }

  private async *iterateSearch(body: AgentSearchInput, options?: CallOptions): AsyncGenerator<Agent> {
    let cursor = body.cursor;
    for (;;) {
      const page = await this.agentSearch({ ...body, cursor }, options);
      for (const agent of page.data) yield agent;
      const next = page.meta.next_cursor;
      if (next === null || next === cursor) return;
      cursor = next;
    }
  }

  private async sendNoBody(
    path: string,
    method: 'DELETE',
    extraHeaders: Record<string, string>,
    signal: AbortSignal | undefined,
    key: string,
  ): Promise<Response> {
    const started = this.now();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = AbortSignal.any(signal ? [timeout, signal] : [timeout]);
    const url = new URL(path, this.baseUrl);
    let attempt = 0;
    while (true) {
      if (combined.aborted) {
        throw abortError(combined.reason instanceof Error ? combined.reason.name : 'AbortError');
      }
      const headers = new Headers({ accept: 'application/json', 'user-agent': this.userAgent });
      headers.set('X-FAD-API-Key', key);
      for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
      let response: Response;
      try {
        response = await this.fetchImpl(url, { method, headers, redirect: 'error', signal: combined });
      } catch (error) {
        if (isAbort(error)) throw abortError(error instanceof Error ? error.name : 'AbortError');
        if (isRedirect(error)) {
          const redirect = new Error('Redirects are not followed.');
          redirect.name = 'FadRedirectError';
          throw redirect;
        }
        const remaining = this.timeoutMs - (this.now() - started);
        if (attempt < this.maxGetRetries && remaining > 0) {
          const wait = retryWaitMs({
            attempt: attempt + 1,
            retryAfterHeader: null,
            maxRetryAfterMs: this.maxRetryAfterMs,
            remainingMs: remaining,
            random: this.random,
          });
          if (!(wait >= remaining && wait > 0)) {
            attempt += 1;
            await this.sleep(wait, combined);
            if (this.now() - started < this.timeoutMs) continue;
          }
        }
        const wrapped = new Error('Network request failed');
        wrapped.name = 'FadNetworkError';
        throw wrapped;
      }
      const retryable = response.status === 429 || response.status === 503;
      const remaining = this.timeoutMs - (this.now() - started);
      if (retryable && attempt < this.maxGetRetries && remaining > 0) {
        const wait = retryWaitMs({
          attempt: attempt + 1,
          retryAfterHeader: response.headers.get('retry-after'),
          maxRetryAfterMs: this.maxRetryAfterMs,
          remainingMs: remaining,
          random: this.random,
        });
        if (wait >= remaining && wait > 0) return response;
        attempt += 1;
        await response.arrayBuffer().catch(() => undefined);
        await this.sleep(wait, combined);
        if (this.now() - started >= this.timeoutMs) return response;
        continue;
      }
      return response;
    }
  }
}

async function readJson(response: Response, secret: string): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new FadApiError(response.status, 'INVALID_RESPONSE', scrub('Response was not JSON', secret), headerRequestId(response));
  }
}

function headerRequestId(response: Response): string | undefined {
  return response.headers.get('x-request-id') ?? undefined;
}

function retryHeader(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (header && /^\d+$/.test(header.trim())) return Number(header.trim());
  return undefined;
}

function errorFrom(response: Response, body: unknown, secret: string): FadApiError {
  const requestId = (isRecord(body) && isRecord(body.meta) && typeof body.meta.request_id === 'string'
    ? body.meta.request_id
    : headerRequestId(response));
  const code = isRecord(body) && isRecord(body.error) && typeof body.error.code === 'string'
    ? body.error.code
    : 'INVALID_RESPONSE';
  const message = isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string'
    ? scrub(body.error.message, secret)
    : 'Request failed';
  return new FadApiError(response.status, code, message, requestId, retryHeader(response));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOrganizationResponse(value: unknown): value is FadResponse<Organization> {
  if (!isRecord(value) || !isRecord(value.data) || !isRecord(value.meta)) return false;
  return typeof value.data.id === 'string'
    && typeof value.data.name === 'string'
    && typeof value.data.status === 'string'
    && typeof value.data.created_at === 'string'
    && typeof value.meta.request_id === 'string'
    && value.meta.api_version === 'v1';
}

function isAgent(value: unknown): value is Agent {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.global_id === 'string'
    && typeof value.organization_id === 'string'
    && typeof value.name === 'string'
    && typeof value.description === 'string'
    && typeof value.owner_principal_id === 'string'
    && (value.status === 'active' || value.status === 'suspended' || value.status === 'retired')
    && typeof value.revision === 'number'
    && typeof value.created_at === 'string'
    && typeof value.updated_at === 'string'
    && typeof value.created_by === 'string'
    && typeof value.updated_by === 'string';
}

function isAgentResponse(value: unknown): value is FadResponse<Agent> {
  return isRecord(value)
    && isAgent(value.data)
    && isRecord(value.meta)
    && typeof value.meta.request_id === 'string'
    && value.meta.api_version === 'v1';
}

function isAgentPage(value: unknown): value is AgentPage {
  if (!isRecord(value) || !Array.isArray(value.data) || !isRecord(value.meta)) return false;
  const next = value.meta.next_cursor;
  return value.data.every((item) => isAgent(item))
    && typeof value.meta.request_id === 'string'
    && value.meta.api_version === 'v1'
    && typeof value.meta.limit === 'number'
    && (typeof next === 'string' || next === null);
}

function requireKey(value: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new Error('idempotencyKey is required');
}

function assertTagValue(value: TagValue): void {
  if (typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.length === 0 || [...value].length > 128) throw new Error('tag value is invalid');
    return;
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= -1_000_000_000 && value <= 1_000_000_000) return;
  throw new Error('tag value is invalid');
}

function isTagValue(value: unknown): value is TagValue {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length > 0;
  return typeof value === 'number' && Number.isFinite(value);
}

function isTagDefinition(value: unknown): value is TagDefinition {
  if (!isRecord(value)) return false;
  const enums = value.enum_values;
  return typeof value.organization_id === 'string'
    && typeof value.namespace === 'string'
    && typeof value.key === 'string'
    && (value.value_type === 'string' || value.value_type === 'integer' || value.value_type === 'boolean' || value.value_type === 'enum')
    && (enums === null || (Array.isArray(enums) && enums.every((item) => typeof item === 'string')))
    && typeof value.governed === 'boolean'
    && (value.visibility === 'internal' || value.visibility === 'restricted')
    && typeof value.description === 'string'
    && typeof value.created_by === 'string'
    && typeof value.created_at === 'string';
}

function isTagDefinitionResponse(value: unknown): value is FadResponse<TagDefinition> {
  return isRecord(value) && isTagDefinition(value.data) && isRecord(value.meta)
    && typeof value.meta.request_id === 'string' && value.meta.api_version === 'v1';
}

function isTagDefinitionPage(value: unknown): value is TagDefinitionPage {
  if (!isRecord(value) || !Array.isArray(value.data) || !isRecord(value.meta)) return false;
  const next = value.meta.next_cursor;
  return value.data.every((item) => isTagDefinition(item))
    && typeof value.meta.request_id === 'string'
    && value.meta.api_version === 'v1'
    && typeof value.meta.limit === 'number'
    && (typeof next === 'string' || next === null);
}

function isAgentTag(value: unknown): value is AgentTag {
  if (!isRecord(value)) return false;
  return typeof value.agent_id === 'string'
    && typeof value.namespace === 'string'
    && typeof value.key === 'string'
    && isTagValue(value.value)
    && typeof value.revision === 'number'
    && typeof value.governed === 'boolean'
    && (value.visibility === 'internal' || value.visibility === 'restricted')
    && typeof value.created_by === 'string'
    && typeof value.updated_by === 'string'
    && typeof value.created_at === 'string'
    && typeof value.updated_at === 'string';
}

function isAgentTagResponse(value: unknown): value is FadResponse<AgentTag> {
  return isRecord(value) && isAgentTag(value.data) && isRecord(value.meta)
    && typeof value.meta.request_id === 'string' && value.meta.api_version === 'v1';
}

function withTagEtag(response: Response, parsed: FadResponse<AgentTag>): AgentTagResult {
  const etag = response.headers.get('etag') ?? '';
  if (!/^"tag-v[1-9][0-9]*"$/.test(etag)) {
    throw new FadApiError(response.status, 'INVALID_RESPONSE', 'Response did not include a strong ETag', headerRequestId(response));
  }
  return { ...parsed, etag };
}
