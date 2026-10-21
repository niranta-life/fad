/* Generated from contracts/openapi.yaml by packages/contract/scripts/generate.mjs. Do not edit. */

export interface Liveness {
  status: "ok";
}

export interface Readiness {
  status: "ready" | "not_ready";
}

export interface Organization {
  id: string;
  name: string;
  status: "active" | "suspended";
  created_at: string;
}

export interface ResponseMeta {
  [key: string]: unknown;
  request_id: string;
  api_version: "v1";
}

export interface OrganizationResponse {
  data: Organization;
  meta: ResponseMeta;
}

export interface ErrorData {
  [key: string]: unknown;
  code: string;
  message: string;
}

export interface ErrorResponse {
  error: ErrorData;
  meta: ResponseMeta;
}

export interface HealthUnavailable {
  status: "not_ready";
}

