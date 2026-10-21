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

export type CapabilityId = string;

export type CapabilityVersion = string;

export type EndpointKey = string;

export interface CapabilityContract {
  [key: string]: unknown;
}

export interface CapabilityPublish {
  id: CapabilityId;
  version: CapabilityVersion;
  display_name: string;
  description?: string;
  input_schema: CapabilityContract;
  output_schema: CapabilityContract;
}

export interface Capability {
  id: CapabilityId;
  version: CapabilityVersion;
  organization_id: string;
  display_name: string;
  description: string;
  input_schema: CapabilityContract;
  output_schema: CapabilityContract;
  contract_sha256: string;
  verification: "self_declared";
  published_by: string;
  published_at: string;
}

export type EndpointProtocol = "a2a" | "mcp" | "http_json";

export type EndpointAuthScheme = "oauth2" | "mtls" | "api_key" | "none";

export interface EndpointPut {
  protocol: EndpointProtocol;
  url: string;
  auth_scheme: EndpointAuthScheme;
  enabled?: boolean;
}

export interface Endpoint {
  agent_id: string;
  key: EndpointKey;
  protocol: EndpointProtocol;
  url: string;
  auth_scheme: EndpointAuthScheme;
  enabled: boolean;
  revision: number;
  verification: "self_declared";
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface BindingPut {
  version: CapabilityVersion;
  endpoint_key: EndpointKey;
}

export interface Binding {
  agent_id: string;
  capability_id: CapabilityId;
  version: CapabilityVersion;
  endpoint_key: EndpointKey;
  revision: number;
  verification: "self_declared";
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface DiscoveryCapability {
  id: CapabilityId;
  version?: CapabilityVersion;
}

export interface DiscoveryRequest {
  capability: DiscoveryCapability;
  tags?: TagPredicate[];
  protocols?: EndpointProtocol[];
  limit?: number;
  cursor?: string;
}

export interface DiscoveryBoundCapability {
  id: CapabilityId;
  version: CapabilityVersion;
  verification: "self_declared";
}

export interface DiscoveryMatch {
  agent: Agent;
  capability: DiscoveryBoundCapability;
  binding: Binding;
  endpoint: Endpoint;
  invocation_authorization: "not_evaluated";
  availability: "not_checked";
}

export interface CapabilityResponse {
  data: Capability;
  meta: ResponseMeta;
}

export interface EndpointResponse {
  data: Endpoint;
  meta: ResponseMeta;
}

export interface BindingResponse {
  data: Binding;
  meta: ResponseMeta;
}

export interface CapabilityListResponse {
  data: Capability[];
  meta: PageMeta;
}

export interface EndpointListResponse {
  data: Endpoint[];
  meta: ResponseMeta;
}

export interface BindingListResponse {
  data: Binding[];
  meta: ResponseMeta;
}

export interface DiscoveryResponse {
  data: DiscoveryMatch[];
  meta: PageMeta;
}

export type PolicyAction = "agent.read" | "agent.discover" | "agent.invoke" | "agent.update" | "agent.suspend";

export type PolicyEffect = "allow" | "deny";

export type PolicyStatus = "draft" | "active" | "disabled";

export interface PolicyTagPredicate {
  namespace: string;
  key: string;
  operator: "eq";
  value: unknown;
}

export interface PolicySubjects {
  principal_ids: string[];
}

export interface PolicyResourceSelector {
  type: "agent";
  agent_ids?: string[];
  tags_all?: PolicyTagPredicate[];
}

export interface PolicyDefinitionInput {
  name: string;
  description?: string;
  effect: PolicyEffect;
  actions: PolicyAction[];
  subjects: PolicySubjects;
  resource: PolicyResourceSelector;
  supersedes_policy_id?: unknown;
}

export interface Policy {
  id: string;
  organization_id: string;
  name: string;
  description: string;
  effect: PolicyEffect;
  actions: PolicyAction[];
  subjects: PolicySubjects;
  resource: PolicyResourceSelector;
  status: PolicyStatus;
  revision: number;
  contains_restricted_tags: boolean;
  supersedes_policy_id: unknown;
  created_at: string;
  updated_at: string;
  activated_at: unknown;
  disabled_at: unknown;
  created_by: string;
  updated_by: string;
}

export interface PolicyResponse {
  data: Policy;
  meta: ResponseMeta;
}

export interface PolicyPage {
  next_cursor: string | null;
}

export interface PolicyListResponse {
  data: Policy[];
  page: PolicyPage;
  meta: ResponseMeta;
}

export interface EvaluationSubject {
  principal_id: string;
}

export interface EvaluationResource {
  type: "agent";
  id: string;
}

export interface EvaluationContext {
  purpose?: string;
  correlation_id?: string;
}

export interface EvaluationRequest {
  subject: EvaluationSubject;
  action: PolicyAction;
  resource: EvaluationResource;
  context?: EvaluationContext;
}

export interface PolicyMatch {
  policy_id: string;
  revision: number;
  effect: PolicyEffect;
}

export interface EvaluationDecision {
  decision_id: string;
  decision: "allow" | "deny";
  reason_code: "EXPLICIT_ALLOW" | "EXPLICIT_DENY" | "NO_MATCHING_ALLOW" | "SUBJECT_INACTIVE" | "RESOURCE_INACTIVE";
  enforcement: "not_enforced";
  evaluated_at: string;
  resource_revision: number;
  policy_set_digest?: string;
  input_digest?: string;
  matched_policy_count?: number;
  explanation?: PolicyMatch[];
}

export interface EvaluationResponse {
  data: EvaluationDecision;
  meta: ResponseMeta;
}

