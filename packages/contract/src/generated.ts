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

export type AgentStatus = "active" | "suspended" | "retired";

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

export interface PageMeta {
  request_id: string;
  api_version: "v1";
  limit: number;
  next_cursor: string | null;
}

export interface AgentResponse {
  data: Agent;
  meta: ResponseMeta;
}

export interface AgentListResponse {
  data: Agent[];
  meta: PageMeta;
}

export type TagType = "string" | "integer" | "boolean" | "enum";

export type TagVisibility = "internal" | "restricted";

export type TagScalar = unknown;

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
  enum_values: unknown | null;
  governed: boolean;
  visibility: TagVisibility;
  description: string;
  created_by: string;
  created_at: string;
}

export interface TagAssignmentPut {
  value: TagScalar;
  reason?: string;
}

export interface TagAssignment {
  agent_id: string;
  namespace: string;
  key: string;
  value: TagScalar;
  revision: number;
  governed: boolean;
  visibility: TagVisibility;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface TagPredicate {
  namespace: string;
  key: string;
  operator: "eq";
  value: TagScalar;
}

export interface AgentTagSearch {
  tags?: TagPredicate[];
  status?: AgentStatus;
  limit?: number;
  cursor?: string;
}

export interface TagDefinitionResponse {
  data: TagDefinition;
  meta: ResponseMeta;
}

export interface TagDefinitionListResponse {
  data: TagDefinition[];
  meta: PageMeta;
}

export interface TagAssignmentResponse {
  data: TagAssignment;
  meta: ResponseMeta;
}

export interface TagAssignmentListResponse {
  data: TagAssignment[];
  meta: ResponseMeta;
}

