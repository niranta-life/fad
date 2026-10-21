export const API_VERSION = 'v1' as const;

export const ERRORS = {
  VALIDATION_ERROR: 'Invalid request.',
  UNAUTHORIZED: 'Invalid or missing API credential.',
  FORBIDDEN: 'Insufficient permission.',
  RATE_LIMITED: 'Request limit exceeded.',
  DEPENDENCY_UNAVAILABLE: 'Service temporarily unavailable.',
  INTERNAL_ERROR: 'Internal server error.',
  METHOD_NOT_ALLOWED: 'Method not allowed.',
  NOT_FOUND: 'Resource not found.',
  PAYLOAD_TOO_LARGE: 'Request body is too large.',
  AGENT_NOT_FOUND: 'Agent not found.',
  INVALID_STATE_TRANSITION: 'The agent status does not allow this change.',
  IDEMPOTENCY_CONFLICT: 'Idempotency key was reused with a different request.',
  PRECONDITION_FAILED: 'The agent has changed. Fetch its current representation and retry.',
  PRECONDITION_REQUIRED: 'If-Match is required.',
  UNSUPPORTED_MEDIA_TYPE: 'Content-Type must be application/json.',
} as const;

export type ErrorCode = keyof typeof ERRORS;

export function successEnvelope<T>(data: T, requestId: string): {
  data: T;
  meta: { request_id: string; api_version: typeof API_VERSION };
} {
  return { data, meta: { request_id: requestId, api_version: API_VERSION } };
}

export function errorEnvelope(code: ErrorCode, requestId: string): {
  error: { code: ErrorCode; message: string };
  meta: { request_id: string; api_version: typeof API_VERSION };
} {
  return {
    error: { code, message: ERRORS[code] },
    meta: { request_id: requestId, api_version: API_VERSION },
  };
}
