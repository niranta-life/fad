import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { lookup as dnsLookup } from 'node:dns';
import { isIP, BlockList } from 'node:net';
import { readFileSync } from 'node:fs';

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
blocked.addAddress('255.255.255.255', 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

const METADATA_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.google.com',
  'instance-data',
  'localhost',
  'localhost.localdomain',
]);

export class WebhookUrlError extends Error {
  readonly code = 'WEBHOOK_URL_REJECTED';

  constructor() {
    super('WEBHOOK_URL_REJECTED');
    this.name = 'WebhookUrlError';
  }
}

export interface EgressRequest {
  url: string;
  body: Buffer;
  headers: Record<string, string>;
  timeoutMs?: number;
  resolver?: (hostname: string) => Promise<string[]>;
}

export interface EgressResponse {
  status: number;
  body: Buffer;
  address: string;
  retryAfterSeconds: number | null;
}

export function testEgressEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return process.env.FAD_EVENTS_TEST_EGRESS === 'loopback';
}

/** True when the address is not a public unicast target. */
export function addressBlocked(address: string): boolean {
  const mapped = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  const family = isIP(mapped);
  if (family === 0) return true;
  return blocked.check(mapped, family === 4 ? 'ipv4' : 'ipv6');
}

export function assertWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookUrlError();
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new WebhookUrlError();
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host.length === 0 || METADATA_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.localdomain')) {
    throw new WebhookUrlError();
  }
  if (isIP(host) !== 0) throw new WebhookUrlError();
  const port = url.port === '' ? 443 : Number(url.port);
  const testPort = testEgressEnabled() ? Number(process.env.FAD_EVENTS_TEST_PORT ?? '') : NaN;
  const allowedPort = port === 443 || (testEgressEnabled() && Number.isInteger(testPort) && port === testPort);
  if (!allowedPort || port < 1 || port > 65535) throw new WebhookUrlError();
  return url;
}

function testHostAddress(hostname: string): string | null {
  if (!testEgressEnabled()) return null;
  const raw = process.env.FAD_EVENTS_TEST_HOSTS ?? '';
  const host = hostname.toLowerCase();
  for (const item of raw.split(',')) {
    const [name, address] = item.split('=');
    if (name?.trim().toLowerCase() === host && address && isIP(address.trim()) !== 0) return address.trim();
  }
  return null;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const mapped = testHostAddress(hostname);
  if (mapped) return [mapped];
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, records) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(records.map((record) => record.address));
    });
  });
}

async function approvedAddresses(hostname: string, resolver: (hostname: string) => Promise<string[]>): Promise<string[]> {
  let found: string[];
  try {
    found = await resolver(hostname);
  } catch {
    throw new WebhookUrlError();
  }
  if (found.length === 0) throw new WebhookUrlError();
  const testHost = testHostAddress(hostname);
  for (const address of found) {
    if (isIP(address) === 0) throw new WebhookUrlError();
    if (addressBlocked(address) && !(testEgressEnabled() && testHost === address)) throw new WebhookUrlError();
  }
  return found;
}

function testCa(): string | undefined {
  if (!testEgressEnabled()) return undefined;
  const path = process.env.FAD_EVENTS_TEST_CA;
  if (!path) return undefined;
  return readFileSync(path, 'utf8');
}

/** Reject a destination that is not a public HTTPS name with public DNS answers. */
export async function assertWebhookDestination(
  raw: string,
  resolver?: (hostname: string) => Promise<string[]>,
): Promise<URL> {
  const url = assertWebhookUrl(raw);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  await approvedAddresses(hostname, resolver ?? defaultResolve);
  return url;
}

/** HTTPS POST pinned to a validated address. Redirects and proxies are not used. */
export async function postWebhook(input: EgressRequest): Promise<EgressResponse> {
  const url = assertWebhookUrl(input.url);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const resolver = input.resolver ?? defaultResolve;
  const approved = await approvedAddresses(hostname, resolver);
  const address = await recheck(hostname, resolver, approved);
  const port = url.port === '' ? 443 : Number(url.port);
  const timeoutMs = input.timeoutMs ?? 5000;
  const ca = testCa();
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const socket = tlsConnect({
      host: address,
      servername: hostname,
      port,
      ca,
      rejectUnauthorized: true,
      timeout: timeoutMs,
    }, () => {
      if (!socket.authorized) {
        socket.destroy();
        fail(new WebhookUrlError());
        return;
      }
      writeRequest(socket, url, input, timeoutMs, address, resolve, fail);
    });
    socket.on('error', () => fail(new WebhookUrlError()));
    socket.on('timeout', () => {
      socket.destroy();
      fail(new WebhookUrlError());
    });
  });
}

async function recheck(
  hostname: string,
  resolver: (hostname: string) => Promise<string[]>,
  approved: string[],
): Promise<string> {
  const again = await approvedAddresses(hostname, resolver);
  const address = again.find((item) => approved.includes(item));
  if (!address) throw new WebhookUrlError();
  return address;
}

function writeRequest(
  socket: TLSSocket,
  url: URL,
  input: EgressRequest,
  timeoutMs: number,
  address: string,
  resolve: (value: EgressResponse) => void,
  fail: (error: Error) => void,
): void {
  const path = `${url.pathname}${url.search}`;
  const headerLines = [
    `POST ${path || '/'} HTTP/1.1`,
    `Host: ${url.host}`,
    'Content-Type: application/json',
    `Content-Length: ${input.body.length}`,
    'Connection: close',
    'Accept: application/json',
  ];
  for (const [name, value] of Object.entries(input.headers)) {
    if (value.includes('\r') || value.includes('\n') || name.includes('\r') || name.includes('\n')) {
      fail(new WebhookUrlError());
      return;
    }
    headerLines.push(`${name}: ${value}`);
  }
  headerLines.push('', '');
  const chunks: Buffer[] = [];
  let bytes = 0;
  const timer = setTimeout(() => {
    socket.destroy();
    fail(new WebhookUrlError());
  }, timeoutMs);
  socket.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 65_536) {
      clearTimeout(timer);
      socket.destroy();
      fail(new WebhookUrlError());
      return;
    }
    chunks.push(chunk);
  });
  socket.on('end', () => {
    clearTimeout(timer);
    try {
      resolve(parseHttp(Buffer.concat(chunks), address));
    } catch (error) {
      fail(error instanceof Error ? error : new WebhookUrlError());
    }
  });
  socket.on('error', () => {
    clearTimeout(timer);
    fail(new WebhookUrlError());
  });
  socket.write(Buffer.concat([Buffer.from(headerLines.join('\r\n')), input.body]));
}

function parseHttp(raw: Buffer, address: string): EgressResponse {
  const text = raw.toString('latin1');
  const split = text.indexOf('\r\n\r\n');
  if (split < 0) throw new WebhookUrlError();
  const head = text.slice(0, split);
  const statusLine = head.split('\r\n')[0] ?? '';
  const match = /^HTTP\/1\.[01] (\d{3}) /.exec(statusLine);
  if (!match?.[1]) throw new WebhookUrlError();
  const status = Number(match[1]);
  if (status >= 300 && status < 400) throw new WebhookUrlError();
  let retryAfterSeconds: number | null = null;
  for (const line of head.split('\r\n').slice(1)) {
    const index = line.indexOf(':');
    if (index < 1) continue;
    const name = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (name === 'retry-after' && /^\d{1,6}$/.test(value)) {
      retryAfterSeconds = Math.min(3600, Number(value));
    }
  }
  const bodyStart = split + 4;
  return { status, body: raw.subarray(bodyStart), address, retryAfterSeconds };
}
