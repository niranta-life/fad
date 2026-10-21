/** Exact scope strings. Slice 1 names are provisionable and do not imply routes. */
export const KNOWN_SCOPES = [
  'organizations:read',
  'agents:read',
  'agents:write',
  'agents:lifecycle',
] as const;

export type KnownScope = (typeof KNOWN_SCOPES)[number];

const ALLOWED = new Set<string>(KNOWN_SCOPES);

export class ScopeError extends Error {
  constructor(message = 'Scope is not allowed') {
    super(message);
    this.name = 'ScopeError';
  }
}

export function parseScopes(input: readonly string[]): KnownScope[] {
  if (input.length === 0) {
    throw new ScopeError('At least one scope is required');
  }
  const out: KnownScope[] = [];
  for (const raw of input) {
    if (raw === '*' || raw.trim() !== raw || raw.length === 0 || !ALLOWED.has(raw)) {
      throw new ScopeError('Scope is not allowed');
    }
    const scope = raw as KnownScope;
    if (!out.includes(scope)) out.push(scope);
  }
  return out;
}

/** Exact match. Wildcards and prefixes do not grant a scope. */
export function hasScope(scopes: readonly string[], required: string): boolean {
  if (!ALLOWED.has(required)) return false;
  return scopes.includes(required);
}
