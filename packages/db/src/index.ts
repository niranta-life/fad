export { isDependencyError } from './errors.js';
export { createPool, withTransaction } from './pool.js';
export { withTenant, withBootstrap } from './tenant.js';
export { insertAudit, auditedMutation, type AuditInput } from './audit.js';
export {
  IdempotencyConflictError,
  beginIdempotency,
  requestFingerprint,
  writeIdempotency,
  deleteExpiredIdempotency,
  type IdempotencyWrite,
  type IdempotencyResult,
} from './idempotency.js';
export {
  AgentServiceError,
  agentEtag,
  canonicalJson,
  codePointLength,
  decodeCursor,
  encodeCursor,
  nextStatus,
  normalizeDescription,
  normalizeName,
  normalizeReason,
  parseCreateBody,
  parseEtag,
  parseIdempotencyKey,
  parseLifecycleBody,
  parsePatchBody,
  CURSOR_LIFETIME_MS,
  type AgentCreateInput,
  type AgentPatchInput,
  type AgentStatus,
  type LifecycleAction,
} from './agent-rules.js';
export {
  getAgent,
  listAgents,
  registerAgent,
  transitionAgent,
  updateAgent,
  type AgentCommandResult,
  type AgentRecord,
} from './agents.js';
export {
  TAG_ASSIGNMENT_CEILING,
  TAG_DEFINITION_CEILING,
  TAG_MIGRATION_VERSION,
  TAG_SEARCH_PREDICATE_CEILING,
  TagServiceError,
  encodeSearchCursor,
  headerText,
  parseDefinitionBody,
  parseDefinitionListQuery,
  parseSearchBody,
  parseTagName,
  parseTagPrecondition,
  parseTagPut,
  searchFilterKey,
  tagEtag,
  type TagType,
  type TagValue,
  type TagVisibility,
} from './tag-rules.js';
export {
  buildAgentSearchQuery,
  createTagDefinition,
  deleteAgentTag,
  getAgentTag,
  getTagDefinition,
  listAgentTags,
  listTagDefinitions,
  putAgentTag,
  searchAgents,
  type TagActor,
  type TagAssignmentRecord,
  type TagDefinitionRecord,
  type TagLimits,
  type TagWriteResult,
} from './tags.js';
export { migrationChecksum, readMigrationFiles, type MigrationFile } from './migrations.js';
export { rateLimitBucket, consumeRateLimit, cleanupRateLimits, type RateLimitDecision } from './rate-limit.js';
