export {
  PepperError,
  assertPepper,
  parseApiKey,
  generateApiKey,
  computeVerifier,
  verifiersMatch,
  credentialIsActive,
  type ParsedApiKey,
  type CredentialView,
} from './keys.js';
export { KNOWN_SCOPES, ScopeError, parseScopes, hasScope, type KnownScope } from './scopes.js';
export { redactText, redactValue } from './redact.js';
export { readCredentialHeader, type CredentialHeaderResult } from './header.js';

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
