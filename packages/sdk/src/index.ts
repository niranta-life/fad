export interface FadClientOptions {
  baseUrl: string;
  apiKey: string | (() => Promise<string> | string);
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
  private readonly apiKey: FadClientOptions['apiKey'];
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
    this.apiKey = options.apiKey;
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
    this.userAgent = `@fad/sdk/0.1.0${suffix}`;
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
