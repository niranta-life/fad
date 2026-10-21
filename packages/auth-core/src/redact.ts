const KEY_PATTERN = /fad_live\.[0-9a-f]{32}\.[A-Za-z0-9_-]{43}/g;
const BANNED_KEYS = new Set([
  'secret',
  'api_key',
  'apikey',
  'apiKey',
  'verifier',
  'verifier_hmac',
  'pepper',
  'digest',
  'authorization',
  'password',
  'token',
  'x-fad-api-key',
]);

export function redactText(input: string, extraSecrets: readonly string[] = []): string {
  let out = input.replace(KEY_PATTERN, '[REDACTED]');
  for (const secret of extraSecrets) {
    if (secret.length >= 8) out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

export function redactValue(value: unknown, extraSecrets: readonly string[] = []): unknown {
  return walk(value, extraSecrets, 0);
}

function walk(value: unknown, extraSecrets: readonly string[], depth: number): unknown {
  if (depth > 8) return '[REDACTED]';
  if (typeof value === 'string') return redactText(value, extraSecrets);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => walk(item, extraSecrets, depth + 1));
  if (typeof value === 'object' && value !== undefined) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (BANNED_KEYS.has(key) || BANNED_KEYS.has(key.toLowerCase())) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = walk(inner, extraSecrets, depth + 1);
      }
    }
    return out;
  }
  return null;
}
