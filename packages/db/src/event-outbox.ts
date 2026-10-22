import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { isUuid } from '@fad/auth-core';

/** Immutable CloudEvents type catalog. New versions are new strings. */
export const DIRECTORY_EVENT_TYPES = [
  'com.fad.agent.registered.v1',
  'com.fad.agent.updated.v1',
  'com.fad.agent.lifecycle_changed.v1',
  'com.fad.tag.definition_created.v1',
  'com.fad.tag.assignment_changed.v1',
  'com.fad.capability.published.v1',
  'com.fad.agent.endpoint_changed.v1',
  'com.fad.agent.capability_binding_changed.v1',
  'com.fad.policy.lifecycle_changed.v1',
  'com.fad.enforcement.config_changed.v1',
] as const;

export type DirectoryEventType = (typeof DIRECTORY_EVENT_TYPES)[number];

export const EVENTS_MIGRATION_VERSION = '20261021_007_durable_events';

const ALWAYS_RESTRICTED = new Set<DirectoryEventType>([
  'com.fad.policy.lifecycle_changed.v1',
  'com.fad.enforcement.config_changed.v1',
]);

const PAYLOAD_KEYS = new Set([
  'agent_id',
  'revision',
  'status',
  'namespace',
  'key',
  'change',
  'capability_id',
  'version',
  'endpoint_key',
  'policy_id',
  'mode',
]);

const TYPE_SET = new Set<string>(DIRECTORY_EVENT_TYPES);

export function eventsCaptureEnabled(): boolean {
  return process.env.FAD_EVENTS_ENABLED === 'true';
}

export function isDirectoryEventType(value: string): value is DirectoryEventType {
  return TYPE_SET.has(value);
}

export function eventVisibility(type: DirectoryEventType, requested: 'standard' | 'restricted'): 'standard' | 'restricted' {
  if (ALWAYS_RESTRICTED.has(type)) return 'restricted';
  return requested;
}

export interface DirectoryEventInput {
  organizationId: string;
  eventType: DirectoryEventType;
  subject: string;
  aggregateType: string;
  aggregateId: string | null;
  aggregateRevision: number | null;
  visibility: 'standard' | 'restricted';
  payload: Record<string, unknown>;
  requestId: string | null;
}

/** One event row in the same transaction as the business write. No-op when capture is off. */
export async function appendDirectoryEvent(client: PoolClient, input: DirectoryEventInput): Promise<void> {
  if (!eventsCaptureEnabled()) return;
  if (!isUuid(input.organizationId)) throw new Error('invalid organization id');
  const subject = input.subject.trim();
  if (subject.length < 1 || subject.length > 256) throw new Error('event subject is out of range');
  const payload = minimizePayload(input.payload);
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded) > 8192) throw new Error('event payload exceeds 8192 bytes');
  const visibility = eventVisibility(input.eventType, input.visibility);
  const requestId = input.requestId && isUuid(input.requestId) ? input.requestId : null;
  await client.query(
    `INSERT INTO fad_event_streams (organization_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [input.organizationId],
  );
  const locked = await client.query<{ last_sequence: string }>(
    `UPDATE fad_event_streams
        SET last_sequence = last_sequence + 1,
            updated_at = transaction_timestamp()
      WHERE organization_id = $1
      RETURNING last_sequence`,
    [input.organizationId],
  );
  const sequence = locked.rows[0]?.last_sequence;
  if (!sequence) throw new Error('event stream did not allocate a sequence');
  await client.query(
    `INSERT INTO fad_outbox_events (
       organization_id, event_id, sequence, event_type, subject, aggregate_type,
       aggregate_id, aggregate_revision, visibility, payload, request_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
    [
      input.organizationId,
      randomUUID(),
      sequence,
      input.eventType,
      subject,
      input.aggregateType,
      input.aggregateId,
      input.aggregateRevision,
      visibility,
      encoded,
      requestId,
    ],
  );
}

function minimizePayload(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!PAYLOAD_KEYS.has(key) || value === undefined || value === null) continue;
    out[key] = value;
  }
  return out;
}
