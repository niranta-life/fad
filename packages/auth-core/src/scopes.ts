/** Exact scope strings. Later names are additive and do not widen older scopes. */
export const KNOWN_SCOPES = [
  'organizations:read',
  'agents:read',
  'agents:write',
  'agents:lifecycle',
  'tags:define',
  'tags:read',
  'tags:write',
  'tags:governance',
  'tags:restricted:read',
  'capabilities:read',
  'capabilities:write',
  'endpoints:read',
  'endpoints:write',
  'policies:read',
  'policies:write',
  'policies:activate',
  'policies:evaluate:self',
  'policies:evaluate:any',
  'policies:explain',
  'enforcement:read',
  'enforcement:manage',
  'enforcement:audit',
  'policies:attributes:write',
  'events:read',
  'events:subscribe',
  'events:manage',
  'events:replay',
  'events:delivery:read',
  'events:restricted:read',
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
