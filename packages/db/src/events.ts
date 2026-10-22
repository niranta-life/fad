import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { hasScope, isUuid } from '@fad/auth-core';
import { insertAudit } from './audit.js';
import { assertWebhookDestination, postWebhook, WebhookUrlError } from './event-egress.js';
import {
  DIRECTORY_EVENT_TYPES,
  isDirectoryEventType,
  type DirectoryEventType,
} from './event-outbox.js';
import { IdempotencyConflictError, beginIdempotency, requestFingerprint, writeIdempotency } from './idempotency.js';
import { CommittedDenial, enforceAgent } from './enforcement.js';
import { withTenant } from './tenant.js';

const LIVE_TOKEN = '00000000-0000-0000-0000-000000000000';
const SUBSCRIPTION_CAP = 50;
const SCAN_BUDGET = 5000;
const MAX_ATTEMPTS = 12;
const MAX_DELIVERY_MS = 48 * 60 * 60 * 1000;
const OVERLAP_MS = 15 * 60 * 1000;
const CURSOR_MS = 5 * 60 * 1000;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const KEY_REF = 'local:FAD_EVENTS_SECRET_KEY:v1';
const PAGE_DEFAULT = 25;

export class EventServiceError extends Error {
  readonly status: number;
  readonly code:
    | 'VALIDATION_ERROR'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'PRECONDITION_FAILED'
    | 'PRECONDITION_REQUIRED'
    | 'INVALID_CURSOR'
    | 'CURSOR_CONTEXT_CHANGED'
    | 'EVENT_CURSOR_EXPIRED'
    | 'EVENT_SCAN_BUDGET_EXCEEDED'
    | 'SECRET_RECEIPT_EXPIRED'
    | 'WEBHOOK_URL_REJECTED'
    | 'REPLAY_RANGE_EXPIRED'
    | 'UNSUPPORTED_MEDIA_TYPE'
    | 'DEPENDENCY_UNAVAILABLE';

  constructor(status: number, code: EventServiceError['code']) {
    super(code);
    this.name = 'EventServiceError';
    this.status = status;
    this.code = code;
  }
}

export interface EventActor {
  organizationId: string;
  principalId: string;
  requestId: string;
  scopes: readonly string[];
  channel?: 'rest' | 'mcp';
}

interface CursorClaims {
  v: 1;
  kind: 'events' | 'subscriptions' | 'deliveries';
  org: string;
  principal: string;
  scopes: string;
  filter: string;
  retention: number;
  seq: string;
  exp: number;
}

interface EventRow {
  event_id: string;
  sequence: string;
  event_type: string;
  subject: string;
  visibility: 'standard' | 'restricted';
  payload: Record<string, unknown>;
  occurred_at: Date | string;
  aggregate_id: string | null;
}

interface SubscriptionRow {
  id: string;
  callback_url: string;
  description: string;
  event_types: string[];
  status: 'pending_verification' | 'active' | 'paused' | 'disabled';
  revision: string;
  start_after_sequence: string | null;
  verified_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  owner_principal_id: string;
  verification_attempts: number;
  challenge_ciphertext: Buffer | null;
  challenge_expires_at: Date | string | null;
}

export interface CloudEventBody {
  specversion: '1.0';
  id: string;
  source: string;
  type: string;
  subject: string;
  time: string;
  datacontenttype: 'application/json';
  data: Record<string, unknown>;
  fadsequence?: number;
}

export function webhookSignature(secret: string, timestamp: string, rawBody: Buffer): string {
  return createHmac('sha256', secret).update(timestamp, 'utf8').update('.').update(rawBody).digest('hex');
}

export function cloudEventBytes(event: CloudEventBody): Buffer {
  return Buffer.from(JSON.stringify(event));
}

export async function listEvents(
  pool: Pool,
  actor: EventActor,
  query: { type?: string | undefined; limit?: number | undefined; cursor?: string | undefined },
  pepper: Buffer,
): Promise<{ events: CloudEventBody[]; limit: number; nextCursor: string | null; hasMore: boolean }> {
  requireScope(actor, 'events:read');
  const limit = pageLimit(query.limit);
  const type = query.type === undefined || query.type === '' ? null : parseEventType(query.type);
  if (type && !resourceAllowed(actor.scopes, type, 'standard')) {
    throw new EventServiceError(403, 'FORBIDDEN');
  }
  return withTenant(pool, actor.organizationId, async (client) => {
    await requireActor(client, actor);
    const stream = await streamRow(client, actor.organizationId);
    const claims = query.cursor
      ? openCursor(pepper, query.cursor, actor, 'events', type ?? '', stream.minRetained)
      : null;
    const after = claims ? claims.seq : '0';
    const rows = await client.query<EventRow>(
      `SELECT event_id, sequence::text, event_type, subject, visibility, payload, occurred_at, aggregate_id
         FROM fad_outbox_events
        WHERE organization_id = $1
          AND sequence > $2::bigint
          AND sequence >= $3::bigint
          AND ($4::text IS NULL OR event_type = $4)
        ORDER BY sequence ASC
        LIMIT $5`,
      [actor.organizationId, after, stream.minRetained, type, SCAN_BUDGET],
    );
    const visible: EventRow[] = [];
    for (const row of rows.rows) {
      if (!(await rowVisible(client, actor, row))) continue;
      visible.push(row);
      if (visible.length > limit) break;
    }
    if (visible.length <= limit && rows.rows.length === SCAN_BUDGET && visible.length < limit + 1) {
      throw new EventServiceError(503, 'EVENT_SCAN_BUDGET_EXCEEDED');
    }
    const page = visible.slice(0, limit);
    const hasMore = visible.length > limit;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last
      ? sealCursor(pepper, {
        v: 1,
        kind: 'events',
        org: actor.organizationId,
        principal: actor.principalId,
        scopes: scopeDigest(actor.scopes),
        filter: type ?? '',
        retention: stream.minRetained,
        seq: last.sequence,
        exp: Date.now() + CURSOR_MS,
      })
      : null;
    const showSequence = hasScope(actor.scopes, 'events:restricted:read');
    return {
      events: page.map((row) => toCloudEvent(row, actor.organizationId, showSequence)),
      limit,
      nextCursor,
      hasMore,
    };
  });
}

export async function getEvent(pool: Pool, actor: EventActor, eventId: string): Promise<CloudEventBody> {
  requireScope(actor, 'events:read');
  if (!isUuid(eventId)) throw new EventServiceError(400, 'VALIDATION_ERROR');
  return withTenant(pool, actor.organizationId, async (client) => {
    await requireActor(client, actor);
    const stream = await streamRow(client, actor.organizationId);
    const found = await client.query<EventRow>(
      `SELECT event_id, sequence::text, event_type, subject, visibility, payload, occurred_at, aggregate_id
         FROM fad_outbox_events
        WHERE organization_id = $1 AND event_id = $2 AND sequence >= $3::bigint`,
      [actor.organizationId, eventId, stream.minRetained],
    );
    const row = found.rows[0];
    if (!row || !isDirectoryEventType(row.event_type)) throw new EventServiceError(404, 'NOT_FOUND');
    if (row.visibility === 'restricted' && !hasScope(actor.scopes, 'events:restricted:read')) {
      throw new EventServiceError(404, 'NOT_FOUND');
    }
    if (!resourceAllowed(actor.scopes, row.event_type, row.visibility)) {
      throw new EventServiceError(403, 'FORBIDDEN');
    }
    if (!(await rowVisible(client, actor, row))) throw new EventServiceError(404, 'NOT_FOUND');
    return toCloudEvent(row, actor.organizationId, hasScope(actor.scopes, 'events:restricted:read'));
  });
}

export async function createSubscription(
  pool: Pool,
  actor: EventActor,
  idempotencyKey: string,
  body: unknown,
): Promise<{ status: number; etag: string; body: Record<string, unknown> }> {
  requireScope(actor, 'events:subscribe');
  const input = parseCreate(body);
  const url = await assertWebhookDestination(input.callback_url).catch((error: unknown) => {
    if (error instanceof WebhookUrlError) throw new EventServiceError(400, 'WEBHOOK_URL_REJECTED');
    throw new EventServiceError(503, 'DEPENDENCY_UNAVAILABLE');
  });
  const path = '/v1/event-subscriptions';
  const fingerprint = requestFingerprint('POST', path, input);
  return withTenant(pool, actor.organizationId, async (client) => {
    await requireActor(client, actor);
    const claim = await beginIdempotency(client, {
      organizationId: actor.organizationId,
      principalId: actor.principalId,
      method: 'POST',
      resourcePath: path,
      idemKey: idempotencyKey,
      requestSha256: fingerprint,
    });
    const prior = await readReceipt(client, actor, 'create_subscription', idempotencyKey);
    if (prior) {
      if (!prior.request_digest.equals(fingerprint)) throw new IdempotencyConflictError();
      return revealReceipt(client, actor, prior, fingerprint);
    }
    if (claim.kind === 'replay') throw new EventServiceError(409, 'SECRET_RECEIPT_EXPIRED');
    const count = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM fad_event_subscriptions
        WHERE organization_id = $1 AND status <> 'disabled'`,
      [actor.organizationId],
    );
    if ((count.rows[0]?.n ?? 0) >= SUBSCRIPTION_CAP) throw new EventServiceError(409, 'CONFLICT');
    const id = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const secretId = randomUUID();
    const nonce = randomBytes(32).toString('base64url');
    await client.query(
      `INSERT INTO fad_event_subscriptions (
         organization_id, id, owner_principal_id, callback_url, description, event_types,
         status, revision, challenge_digest, challenge_ciphertext, challenge_expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'pending_verification',1,$7,$8,transaction_timestamp() + interval '10 minutes')`,
      [
        actor.organizationId,
        id,
        actor.principalId,
        url.href,
        input.description,
        input.event_types,
        createHash('sha256').update(nonce).digest(),
        seal(Buffer.from(nonce, 'utf8')),
      ],
    );
    await client.query(
      `INSERT INTO fad_webhook_secrets (
         organization_id, id, subscription_id, secret_version, ciphertext, kms_key_ref, status
       ) VALUES ($1,$2,$3,1,$4,$5,'active')`,
      [actor.organizationId, secretId, id, seal(Buffer.from(secret, 'utf8')), KEY_REF],
    );
    await insertReceipt(client, actor, 'create_subscription', idempotencyKey, id, secretId, fingerprint);
    const row = await lockSubscription(client, actor.organizationId, id);
    if (!row) throw new EventServiceError(503, 'DEPENDENCY_UNAVAILABLE');
    const subscription = subscriptionView(row);
    const data = { subscription, signing_secret: secret, signing_key_id: secretId };
    await insertAudit(client, audit(actor, 'event_subscription.created', id, { status: 'pending_verification' }));
    await writeIdempotency(client, {
      organizationId: actor.organizationId,
      principalId: actor.principalId,
      method: 'POST',
      resourcePath: path,
      idemKey: idempotencyKey,
      requestSha256: fingerprint,
      responseStatus: 201,
      responseHeaders: { etag: etagOf(1) },
      responseBody: { subscription, signing_secret: '[redacted]', signing_key_id: secretId },
      expiresAt: new Date(Date.now() + RETENTION_MS),
    });
    return { status: 201, etag: etagOf(1), body: data };
  });
}

export async function listSubscriptions(
  pool: Pool,
  actor: EventActor,
  query: { limit?: number | undefined; cursor?: string | undefined },
  pepper: Buffer,
): Promise<{ subscriptions: Record<string, unknown>[]; limit: number; nextCursor: string | null; hasMore: boolean }> {
  if (!hasScope(actor.scopes, 'events:subscribe') && !hasScope(actor.scopes, 'events:manage')) {
    throw new EventServiceError(403, 'FORBIDDEN');
  }
  const limit = pageLimit(query.limit);
  const manage = hasScope(actor.scopes, 'events:manage');
  return withTenant(pool, actor.organizationId, async (client) => {
    await requireActor(client, actor);
    const claims = query.cursor
      ? openCursor(pepper, query.cursor, actor, 'subscriptions', manage ? 'manage' : 'own', 1)
      : null;
    const rows = await client.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS}
         FROM fad_event_subscriptions
        WHERE organization_id = $1
          AND ($2::boolean OR owner_principal_id = $3)
          AND ($4::timestamptz IS NULL OR (created_at, id) > ($4::timestamptz, $5::uuid))
        ORDER BY created_at ASC, id ASC
        LIMIT $6`,
      [actor.organizationId, manage, actor.principalId, claims?.seq.split('|')[0] ?? null, claims?.seq.split('|')[1] ?? null, limit + 1],
    );
    const page = rows.rows.slice(0, limit);
    const extra = rows.rows[limit];
    const last = page[page.length - 1];
    const nextCursor = extra && last
      ? sealCursor(pepper, {
        v: 1,
        kind: 'subscriptions',
        org: actor.organizationId,
        principal: actor.principalId,
        scopes: scopeDigest(actor.scopes),
        filter: manage ? 'manage' : 'own',
        retention: 1,
        seq: `${iso(last.created_at)}|${last.id}`,
        exp: Date.now() + CURSOR_MS,
      })
      : null;
    return {
      subscriptions: page.map((row) => subscriptionView(row)),
      limit,
      nextCursor,
      hasMore: Boolean(extra),
    };
  });
}

export async function getSubscription(pool: Pool, actor: EventActor, subscriptionId: string): Promise<{ etag: string; subscription: Record<string, unknown> }> {
  if (!isUuid(subscriptionId)) throw new EventServiceError(400, 'VALIDATION_ERROR');
  return withTenant(pool, actor.organizationId, async (client) => {
    await requireActor(client, actor);
    const row = await readVisibleSubscription(client, actor, subscriptionId);
    return { etag: etagOf(Number(row.revision)), subscription: subscriptionView(row) };
  });
}

export async function patchSubscription(
  pool: Pool,
  actor: EventActor,
  subscriptionId: string,
  idempotencyKey: string,
  ifMatch: string | undefined,
  body: unknown,
): Promise<{ etag: string; subscription: Record<string, unknown> }> {
  if (!isUuid(subscriptionId)) throw new EventServiceError(400, 'VALIDATION_ERROR');
  const status = parsePatchStatus(body);
  const expected = parseSubscriptionEtag(ifMatch);
  const path = `/v1/event-subscriptions/${subscriptionId}`;
  const fingerprint = requestFingerprint('PATCH', path, { status, if_match: ifMatch ?? null });
  return withTenant(pool, actor.organizationId, async (client) => {
    await requireActor(client, actor);
    const claim = await beginIdempotency(client, {
      organizationId: actor.organizationId,
      principalId: actor.principalId,
      method: 'PATCH',
      resourcePath: path,
      idemKey: idempotencyKey,
      requestSha256: fingerprint,
    });
    if (claim.kind === 'replay') {
      const stored = claim.responseBody as { subscription?: Record<string, unknown> };
      return { etag: claim.responseHeaders.etag ?? etagOf(expected), subscription: stored.subscription ?? {} };
    }
    const row = await lockVisible(client, actor, subscriptionId);
    if (Number(row.revision) !== expected) throw new EventServiceError(412, 'PRECONDITION_FAILED');
    if (!transitionAllowed(row.status, status)) throw new EventServiceError(409, 'CONFLICT');
    const nextRevision = status === row.status ? Number(row.revision) : Number(row.revision) + 1;
    if (status !== row.status) {
      const updated = await client.query<SubscriptionRow>(
        `UPDATE fad_event_subscriptions
            SET status = $3, revision = $4, updated_at = transaction_timestamp()
          WHERE organization_id = $1 AND id = $2
          RETURNING ${SUBSCRIPTION_COLUMNS}`,
        [actor.organizationId, subscriptionId, status, nextRevision],
      );
      const saved = updated.rows[0];
      if (!saved) throw new EventServiceError(409, 'CONFLICT');
      await insertAudit(client, audit(actor, 'event_subscription.updated', subscriptionId, { status }));
      const subscription = subscriptionView(saved);
      await storePlain(client, actor, 'PATCH', path, idempotencyKey, fingerprint, etagOf(nextRevision), { subscription });
      return { etag: etagOf(nextRevision), subscription };
    }
    const subscription = subscriptionView(row);
    await storePlain(client, actor, 'PATCH', path, idempotencyKey, fingerprint, etagOf(nextRevision), { subscription });
    return { etag: etagOf(nextRevision), subscription };
  });
}

export async function rotateSubscriptionSecret(
  pool: Pool,
  actor: EventActor,
  subscriptionId: string,
  idempotencyKey: string,
  ifMatch: string | undefined,
): Promise<{ status: number; etag: string; body: Record<string, unknown> }> {
  if (!isUuid(subscriptionId)) throw new EventServiceError(400, 'VALIDATION_ERROR');
  const expected = parseSubscriptionEtag(ifMatch);
  const path = `/v1/event-subscriptions/${subscriptionId}/rotate-secret`;
  const fingerprint = requestFingerprint('POST', path, { if_match: ifMatch ?? null });
  return withTenant(pool, actor.organizationId, async (client) => {
    await requireActor(client, actor);
    const claim = await beginIdempotency(client, {
      organizationId: actor.organizationId,
      principalId: actor.principalId,
      method: 'POST',
      resourcePath: path,
      idemKey: idempotencyKey,
      requestSha256: fingerprint,
    });
    const prior = await readReceipt(client, actor, 'rotate_secret', idempotencyKey);
    if (prior) {
      if (!prior.request_digest.equals(fingerprint)) throw new IdempotencyConflictError();
      if (prior.subscription_id !== subscriptionId) throw new IdempotencyConflictError();
      return revealReceipt(client, actor, prior, fingerprint);
    }
    if (claim.kind === 'replay') throw new EventServiceError(409, 'SECRET_RECEIPT_EXPIRED');
    const row = await lockVisible(client, actor, subscriptionId);
    if (Number(row.revision) !== expected) throw new EventServiceError(412, 'PRECONDITION_FAILED');
    if (row.status !== 'active' && row.status !== 'paused') throw new EventServiceError(409, 'CONFLICT');
    const secret = randomBytes(32).toString('base64url');
    const secretId = randomUUID();
    const version = await client.query<{ n: number }>(
      `SELECT COALESCE(max(secret_version), 0)::int AS n
         FROM fad_webhook_secrets
        WHERE organization_id = $1 AND subscription_id = $2`,
      [actor.organizationId, subscriptionId],
    );
    await client.query(
      `UPDATE fad_webhook_secrets
          SET status = 'retired', retire_after = transaction_timestamp()
        WHERE organization_id = $1 AND subscription_id = $2 AND status = 'overlap'`,
      [actor.organizationId, subscriptionId],
    );
    const overlapped = await client.query<{ retire_after: Date }>(
      `UPDATE fad_webhook_secrets
          SET status = 'overlap', retire_after = transaction_timestamp() + interval '15 minutes'
        WHERE organization_id = $1 AND subscription_id = $2 AND status = 'active'
        RETURNING retire_after`,
      [actor.organizationId, subscriptionId],
    );
    const overlap = overlapped.rows[0]?.retire_after;
    if (!overlap) throw new EventServiceError(409, 'CONFLICT');
    await client.query(
      `INSERT INTO fad_webhook_secrets (
         organization_id, id, subscription_id, secret_version, ciphertext, kms_key_ref, status
       ) VALUES ($1,$2,$3,$4,$5,$6,'active')`,
      [actor.organizationId, secretId, subscriptionId, (version.rows[0]?.n ?? 0) + 1, seal(Buffer.from(secret, 'utf8')), KEY_REF],
    );
    const nextRevision = Number(row.revision) + 1;
    const updated = await client.query<SubscriptionRow>(
      `UPDATE fad_event_subscriptions
          SET revision = $3, updated_at = transaction_timestamp()
        WHERE organization_id = $1 AND id = $2
        RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [actor.organizationId, subscriptionId, nextRevision],
    );
    const saved = updated.rows[0];
    if (!saved) throw new EventServiceError(409, 'CONFLICT');
    await insertReceipt(client, actor, 'rotate_secret', idempotencyKey, subscriptionId, secretId, fingerprint);
    await insertAudit(client, audit(actor, 'event_subscription.secret_rotated', subscriptionId, { signing_key_id: secretId }));
    const data = {
      signing_secret: secret,
      signing_key_id: secretId,
      overlap_expires_at: iso(overlap),
      subscription: subscriptionView(saved),
    };
    await writeIdempotency(client, {
      organizationId: actor.organizationId,
      principalId: actor.principalId,
      method: 'POST',
      resourcePath: path,
      idemKey: idempotencyKey,
      requestSha256: fingerprint,
      responseStatus: 200,
      responseHeaders: { etag: etagOf(nextRevision) },
      responseBody: { ...data, signing_secret: '[redacted]' },
      expiresAt: new Date(Date.now() + RETENTION_MS),
    });
    return { status: 200, etag: etagOf(nextRevision), body: data };
  });
}

export async function createReplay(
  pool: Pool,
  actor: EventActor,
  subscriptionId: string,
  idempotencyKey: string,
  body: unknown,
): Promise<{ etag: string; replay: Record<string, unknown> }> {
  requireScope(actor, 'events:replay');
  requireScope(actor, 'events:read');
  requireScope(actor, 'events:restricted:read');
  if (!isUuid(subscriptionId)) throw new EventServiceError(400, 'VALIDATION_ERROR');
  const input = parseReplay(body);
  const path = `/v1/event-subscriptions/${subscriptionId}/replays`;
  const fingerprint = requestFingerprint('POST', path, input);
  return withTenant(pool, actor.organizationId, async (client) => {
    await requireActor(client, actor);
    const before = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM fad_outbox_events WHERE organization_id = $1`,
      [actor.organizationId],
    );
    const claim = await beginIdempotency(client, {
      organizationId: actor.organizationId,
      principalId: actor.principalId,
      method: 'POST',
      resourcePath: path,
      idemKey: idempotencyKey,
      requestSha256: fingerprint,
    });
    if (claim.kind === 'replay') {
      return { etag: claim.responseHeaders.etag ?? '', replay: claim.responseBody as Record<string, unknown> };
    }
    const row = await lockVisible(client, actor, subscriptionId);
    if (row.status !== 'active') throw new EventServiceError(409, 'CONFLICT');
    const stream = await streamRow(client, actor.organizationId);
    if (input.after_sequence + 1 < stream.minRetained || input.through_sequence > stream.last) {
      throw new EventServiceError(410, 'REPLAY_RANGE_EXPIRED');
    }
    const id = randomUUID();
    await client.query(
      `INSERT INTO fad_event_replay_requests (
         organization_id, id, subscription_id, from_sequence_exclusive, through_sequence_inclusive,
         status, reason_digest, created_by
       ) VALUES ($1,$2,$3,$4,$5,'queued',$6,$7)`,
      [
        actor.organizationId,
        id,
        subscriptionId,
        input.after_sequence,
        input.through_sequence,
        createHash('sha256').update(input.reason).digest(),
        actor.principalId,
      ],
    );
    await client.query(
      `INSERT INTO fad_event_delivery_jobs (
         organization_id, id, subscription_id, event_id, replay_token, status
       )
       SELECT e.organization_id, gen_random_uuid(), $2, e.event_id, $3, 'pending'
         FROM fad_outbox_events e
        WHERE e.organization_id = $1
          AND e.sequence > $4::bigint
          AND e.sequence <= $5::bigint
          AND e.event_type = ANY($6::text[])
       ON CONFLICT (organization_id, subscription_id, event_id, replay_token) DO NOTHING`,
      [actor.organizationId, subscriptionId, id, input.after_sequence, input.through_sequence, row.event_types],
    );
    const after = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM fad_outbox_events WHERE organization_id = $1`,
      [actor.organizationId],
    );
    if (after.rows[0]?.n !== before.rows[0]?.n) throw new EventServiceError(503, 'DEPENDENCY_UNAVAILABLE');
    await refreshReplay(client, actor.organizationId, id);
    const replay = await replayView(client, actor.organizationId, id);
    await insertAudit(client, audit(actor, 'event_subscription.replay_requested', subscriptionId, { replay_id: id }));
    await storePlain(client, actor, 'POST', path, idempotencyKey, fingerprint, '', replay);
    return { etag: '', replay };
  });
}

export async function getReplay(pool: Pool, actor: EventActor, subscriptionId: string, replayId: string): Promise<Record<string, unknown>> {
  requireScope(actor, 'events:replay');
  if (!isUuid(subscriptionId) || !isUuid(replayId)) throw new EventServiceError(400, 'VALIDATION_ERROR');
  return withTenant(pool, actor.organizationId, async (client) => {
    await requireActor(client, actor);
    await readVisibleSubscription(client, actor, subscriptionId);
    const found = await client.query(
      `SELECT id FROM fad_event_replay_requests
        WHERE organization_id = $1 AND id = $2 AND subscription_id = $3`,
      [actor.organizationId, replayId, subscriptionId],
    );
    if (!found.rows[0]) throw new EventServiceError(404, 'NOT_FOUND');
    return replayView(client, actor.organizationId, replayId);
  });
}

export async function listDeliveries(
  pool: Pool,
  actor: EventActor,
  subscriptionId: string,
  query: { limit?: number | undefined; cursor?: string | undefined },
  pepper: Buffer,
): Promise<{ deliveries: Record<string, unknown>[]; limit: number; nextCursor: string | null; hasMore: boolean }> {
  requireScope(actor, 'events:delivery:read');
  if (!isUuid(subscriptionId)) throw new EventServiceError(400, 'VALIDATION_ERROR');
  const limit = pageLimit(query.limit);
  return withTenant(pool, actor.organizationId, async (client) => {
    await requireActor(client, actor);
    await readVisibleSubscription(client, actor, subscriptionId);
    const claims = query.cursor
      ? openCursor(pepper, query.cursor, actor, 'deliveries', subscriptionId, 1)
      : null;
    const rows = await client.query<{
      id: string;
      event_id: string;
      subscription_id: string;
      status: string;
      attempt_count: number;
      last_attempt_at: Date | string | null;
      last_http_status: number | null;
      created_at: Date | string;
    }>(
      `SELECT id, event_id, subscription_id, status, attempt_count, last_attempt_at, last_http_status, created_at
         FROM fad_event_delivery_jobs
        WHERE organization_id = $1 AND subscription_id = $2
          AND ($3::timestamptz IS NULL OR (created_at, id) > ($3::timestamptz, $4::uuid))
        ORDER BY created_at ASC, id ASC
        LIMIT $5`,
      [actor.organizationId, subscriptionId, claims?.seq.split('|')[0] ?? null, claims?.seq.split('|')[1] ?? null, limit + 1],
    );
    const page = rows.rows.slice(0, limit);
    const extra = rows.rows[limit];
    const last = page[page.length - 1];
    return {
      deliveries: page.map((row) => ({
        id: row.id,
        event_id: row.event_id,
        subscription_id: row.subscription_id,
        status: row.status,
        attempt_count: row.attempt_count,
        last_attempt_at: row.last_attempt_at ? iso(row.last_attempt_at) : null,
        last_http_status: row.last_http_status,
      })),
      limit,
      nextCursor: extra && last
        ? sealCursor(pepper, {
          v: 1,
          kind: 'deliveries',
          org: actor.organizationId,
          principal: actor.principalId,
          scopes: scopeDigest(actor.scopes),
          filter: subscriptionId,
          retention: 1,
          seq: `${iso(last.created_at)}|${last.id}`,
          exp: Date.now() + CURSOR_MS,
        })
        : null,
      hasMore: Boolean(extra),
    };
  });
}

export async function pendingOrganizations(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ organization_id: string }>(`SELECT organization_id FROM fad_s7_pending_orgs()`);
  return result.rows.map((row) => row.organization_id);
}

export async function fanoutOrganization(pool: Pool, organizationId: string): Promise<number> {
  return withTenant(pool, organizationId, async (client) => {
    await client.query(
      `INSERT INTO fad_event_fanout_offsets (organization_id)
       VALUES ($1) ON CONFLICT DO NOTHING`,
      [organizationId],
    );
    const locked = await client.query<{ last_fanned_sequence: string }>(
      `SELECT last_fanned_sequence::text
         FROM fad_event_fanout_offsets
        WHERE organization_id = $1
        FOR UPDATE SKIP LOCKED`,
      [organizationId],
    );
    const offset = locked.rows[0];
    if (!offset) return 0;
    const stream = await streamRow(client, organizationId);
    if (stream.last <= Number(offset.last_fanned_sequence)) return 0;
    const events = await client.query<{ event_id: string; sequence: string; event_type: string }>(
      `SELECT event_id, sequence::text, event_type
         FROM fad_outbox_events
        WHERE organization_id = $1
          AND sequence > $2::bigint
          AND sequence <= $3::bigint
        ORDER BY sequence ASC`,
      [organizationId, offset.last_fanned_sequence, stream.last],
    );
    let advanced = Number(offset.last_fanned_sequence);
    let inserted = 0;
    for (const event of events.rows) {
      const pending = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM fad_event_delivery_jobs
          WHERE organization_id = $1 AND status IN ('pending','leased')`,
        [organizationId],
      );
      if ((pending.rows[0]?.n ?? 0) >= 5000) break;
      const jobs = await client.query(
        `INSERT INTO fad_event_delivery_jobs (
           organization_id, id, subscription_id, event_id, replay_token, status
         )
         SELECT organization_id, gen_random_uuid(), id, $3, $4::uuid, 'pending'
           FROM fad_event_subscriptions
          WHERE organization_id = $1
            AND status = 'active'
            AND $5 = ANY(event_types)
            AND start_after_sequence IS NOT NULL
            AND start_after_sequence < $2::bigint
         ON CONFLICT (organization_id, subscription_id, event_id, replay_token) DO NOTHING`,
        [organizationId, event.sequence, event.event_id, LIVE_TOKEN, event.event_type],
      );
      inserted += jobs.rowCount ?? 0;
      advanced = Number(event.sequence);
    }
    await client.query(
      `UPDATE fad_event_fanout_offsets
          SET last_fanned_sequence = $2, updated_at = transaction_timestamp()
        WHERE organization_id = $1`,
      [organizationId, advanced],
    );
    return inserted;
  });
}

export interface VerificationClaim {
  organizationId: string;
  subscriptionId: string;
  url: string;
  challenge: string;
  secret: string;
  keyId: string;
}

export async function claimVerification(pool: Pool, organizationId: string): Promise<VerificationClaim | null> {
  return withTenant(pool, organizationId, async (client) => {
    const picked = await client.query<{ id: string }>(
      `SELECT id FROM fad_event_subscriptions
        WHERE organization_id = $1
          AND status = 'pending_verification'
          AND verification_attempts < 20
          AND (challenge_expires_at IS NULL OR challenge_expires_at > transaction_timestamp())
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      [organizationId],
    );
    const id = picked.rows[0]?.id;
    if (!id) return null;
    const row = await lockSubscription(client, organizationId, id);
    if (!row || row.status !== 'pending_verification' || !row.challenge_ciphertext) return null;
    try {
      const secret = await activeSecret(client, organizationId, id);
      if (!secret) {
        await bumpVerification(client, organizationId, id);
        return null;
      }
      return {
        organizationId,
        subscriptionId: id,
        url: row.callback_url,
        challenge: openSeal(row.challenge_ciphertext).toString('utf8'),
        secret: secret.secret,
        keyId: secret.id,
      };
    } catch (error) {
      if (!(error instanceof SealError)) throw error;
      await bumpVerification(client, organizationId, id);
      return null;
    }
  });
}

export async function finishVerification(
  pool: Pool,
  organizationId: string,
  subscriptionId: string,
  status: number,
  responseBody: Buffer,
): Promise<'active' | 'pending'> {
  return withTenant(pool, organizationId, async (client) => {
    const row = await lockSubscription(client, organizationId, subscriptionId);
    if (!row || row.status !== 'pending_verification' || !row.challenge_ciphertext) return row?.status === 'active' ? 'active' : 'pending';
    if (row.challenge_expires_at !== null && new Date(row.challenge_expires_at).getTime() <= Date.now()) {
      await client.query(
        `UPDATE fad_event_subscriptions
            SET verification_attempts = LEAST(verification_attempts + 1, 20),
                updated_at = transaction_timestamp()
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, subscriptionId],
      );
      return 'pending';
    }
    const challenge = openSeal(row.challenge_ciphertext).toString('utf8');
    const echoed = status === 200 || status === 201 || status === 202 ? echoChallenge(responseBody) : null;
    const matched = echoed !== null && sameSecret(echoed, challenge);
    if (!matched) {
      await client.query(
        `UPDATE fad_event_subscriptions
            SET verification_attempts = verification_attempts + 1,
                updated_at = transaction_timestamp()
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, subscriptionId],
      );
      return 'pending';
    }
    await client.query(
      `INSERT INTO fad_event_streams (organization_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [organizationId],
    );
    const stream = await client.query<{ last_sequence: string }>(
      `UPDATE fad_event_streams
          SET updated_at = transaction_timestamp()
        WHERE organization_id = $1
        RETURNING last_sequence::text`,
      [organizationId],
    );
    const watermark = stream.rows[0]?.last_sequence ?? '0';
    await client.query(
      `UPDATE fad_event_subscriptions
          SET status = 'active',
              revision = revision + 1,
              start_after_sequence = $3::bigint,
              verified_at = transaction_timestamp(),
              challenge_ciphertext = NULL,
              challenge_digest = NULL,
              updated_at = transaction_timestamp()
        WHERE organization_id = $1 AND id = $2 AND status = 'pending_verification'`,
      [organizationId, subscriptionId, watermark],
    );
    await insertAudit(client, {
      organizationId,
      actorPrincipalId: row.owner_principal_id,
      action: 'event_subscription.verified',
      targetType: 'event_subscription',
      targetId: subscriptionId,
      outcome: 'success',
      details: { start_after_sequence: watermark },
    });
    return 'active';
  });
}

export interface DeliveryClaim {
  organizationId: string;
  jobId: string;
  eventId: string;
  subscriptionId: string;
  replayToken: string;
  attempt: number;
  url: string;
  secret: string;
  keyId: string;
  jobToken: string;
  subscriptionToken: string;
  deliveryId: string;
  body: Buffer;
  eventSequence: number;
}

export async function claimDelivery(pool: Pool, organizationId: string): Promise<DeliveryClaim | null> {
  return withTenant(pool, organizationId, async (client) => {
    await releaseExpired(client, organizationId);
    const subs = await client.query<{ id: string }>(
      `SELECT id FROM fad_event_subscriptions
        WHERE organization_id = $1
          AND status = 'active'
          AND (delivery_lease_until IS NULL OR delivery_lease_until < transaction_timestamp())
          AND EXISTS (
            SELECT 1 FROM fad_event_delivery_jobs j
             WHERE j.organization_id = fad_event_subscriptions.organization_id
               AND j.subscription_id = fad_event_subscriptions.id
               AND j.status = 'pending'
               AND j.next_attempt_at <= transaction_timestamp()
          )
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      [organizationId],
    );
    const subscriptionId = subs.rows[0]?.id;
    if (!subscriptionId) return null;
    const head = await client.query<{
      id: string;
      event_id: string;
      replay_token: string;
      attempt_count: number;
      due: boolean;
      sequence: string;
      status: string;
    }>(
      `SELECT j.id, j.event_id, j.replay_token, j.attempt_count, j.status, e.sequence::text,
              (j.next_attempt_at <= transaction_timestamp()) AS due
         FROM fad_event_delivery_jobs j
         JOIN fad_outbox_events e
           ON e.organization_id = j.organization_id AND e.event_id = j.event_id
        WHERE j.organization_id = $1 AND j.subscription_id = $2
          AND j.status IN ('pending', 'leased')
        ORDER BY e.sequence ASC
        LIMIT 1`,
      [organizationId, subscriptionId],
    );
    const job = head.rows[0];
    // Host clock and PostgreSQL clock can differ by milliseconds.
    // The same transaction_timestamp() decides both selection and order.
    if (!job || job.status !== 'pending' || job.due !== true) return null;
    const event = await client.query<EventRow>(
      `SELECT event_id, sequence::text, event_type, subject, visibility, payload, occurred_at, aggregate_id
         FROM fad_outbox_events
        WHERE organization_id = $1 AND event_id = $2`,
      [organizationId, job.event_id],
    );
    const row = event.rows[0];
    const sub = await lockSubscription(client, organizationId, subscriptionId);
    let secret: { id: string; secret: string } | null = null;
    if (sub) {
      try {
        secret = await activeSecret(client, organizationId, subscriptionId);
      } catch (error) {
        if (!(error instanceof SealError)) throw error;
      }
    }
    if (!row || !sub || !secret || !isDirectoryEventType(row.event_type)) {
      const reason = row && isDirectoryEventType(row.event_type) ? 'secret_unavailable' : 'type_unknown';
      await cancelJob(client, organizationId, job.id, reason);
      if (sub) {
        await insertAudit(client, {
          organizationId,
          actorPrincipalId: sub.owner_principal_id,
          action: 'event_delivery.denied',
          targetType: 'event_delivery',
          targetId: job.id,
          outcome: 'denied',
          details: { reason, event_id: job.event_id },
        });
      }
      return null;
    }
    const allowed = await ownerCanReceive(client, organizationId, sub.owner_principal_id, row);
    if (!allowed.ok) {
      await cancelJob(client, organizationId, job.id, allowed.reason);
      await insertAudit(client, {
        organizationId,
        actorPrincipalId: sub.owner_principal_id,
        action: 'event_delivery.denied',
        targetType: 'event_delivery',
        targetId: job.id,
        outcome: 'denied',
        details: { reason: allowed.reason, event_id: job.event_id },
      });
      return null;
    }
    const jobToken = randomUUID();
    const subscriptionToken = randomUUID();
    const owner = `worker-${process.pid}`;
    const lease = leaseMs();
    await client.query(
      `UPDATE fad_event_subscriptions
          SET delivery_lease_owner = $3, delivery_lease_token = $4,
              delivery_lease_until = transaction_timestamp() + ($5::text || ' milliseconds')::interval
        WHERE organization_id = $1 AND id = $2`,
      [organizationId, subscriptionId, owner, subscriptionToken, String(lease)],
    );
    const leased = await client.query(
      `UPDATE fad_event_delivery_jobs
          SET status = 'leased', lease_owner = $3, lease_token = $4,
              lease_expires_at = transaction_timestamp() + ($5::text || ' milliseconds')::interval,
              updated_at = transaction_timestamp()
        WHERE organization_id = $1 AND id = $2 AND status = 'pending'`,
      [organizationId, job.id, owner, jobToken, String(lease)],
    );
    if ((leased.rowCount ?? 0) !== 1) return null;
    if (job.replay_token !== LIVE_TOKEN) await refreshReplay(client, organizationId, job.replay_token);
    const includeSequence = allowed.restricted;
    return {
      organizationId,
      jobId: job.id,
      eventId: job.event_id,
      subscriptionId,
      replayToken: job.replay_token,
      attempt: job.attempt_count + 1,
      url: sub.callback_url,
      secret: secret.secret,
      keyId: secret.id,
      jobToken,
      subscriptionToken,
      deliveryId: randomUUID(),
      body: cloudEventBytes(toCloudEvent(row, organizationId, includeSequence)),
      eventSequence: Number(row.sequence),
    };
  });
}

export async function acknowledgeDelivery(
  pool: Pool,
  claim: Pick<DeliveryClaim, 'organizationId' | 'jobId' | 'subscriptionId' | 'jobToken' | 'subscriptionToken' | 'attempt' | 'replayToken' | 'deliveryId'>,
  outcome: { kind: 'success' | 'retry' | 'dead'; httpStatus: number | null; retryAfterSeconds: number | null; startedAt: Date },
): Promise<'acked' | 'lost'> {
  return withTenant(pool, claim.organizationId, async (client) => {
    const current = await client.query<{
      attempt_count: number;
      created_at: Date;
      lease_token: string;
    }>(
      `SELECT attempt_count, created_at, lease_token
         FROM fad_event_delivery_jobs
        WHERE organization_id = $1 AND id = $2 AND status = 'leased' AND lease_token = $3`,
      [claim.organizationId, claim.jobId, claim.jobToken],
    );
    const job = current.rows[0];
    const sub = await client.query<{ delivery_lease_token: string | null }>(
      `SELECT delivery_lease_token FROM fad_event_subscriptions
        WHERE organization_id = $1 AND id = $2`,
      [claim.organizationId, claim.subscriptionId],
    );
    if (!job || sub.rows[0]?.delivery_lease_token !== claim.subscriptionToken) return 'lost';
    const finished = new Date();
    const latency = Math.max(0, Math.min(300_000, finished.getTime() - outcome.startedAt.getTime()));
    let nextStatus: 'pending' | 'succeeded' | 'dead' = 'pending';
    let nextAttempt = job.attempt_count;
    let waitMs = 0;
    if (outcome.kind === 'success' && outcome.httpStatus !== null && outcome.httpStatus >= 200 && outcome.httpStatus < 300) {
      nextStatus = 'succeeded';
      nextAttempt = job.attempt_count + 1;
    } else {
      nextAttempt = job.attempt_count + 1;
      const aged = finished.getTime() - job.created_at.getTime() >= MAX_DELIVERY_MS;
      if (outcome.kind === 'dead' || nextAttempt >= MAX_ATTEMPTS || aged) nextStatus = 'dead';
      else waitMs = backoffMs(nextAttempt, outcome.retryAfterSeconds);
    }
    const attemptOutcome = nextStatus === 'succeeded'
      ? 'success'
      : outcome.httpStatus === null
        ? 'timeout'
        : nextStatus === 'dead'
          ? 'permanent_failure'
          : 'transient_failure';
    const updated = await client.query(
      `UPDATE fad_event_delivery_jobs
          SET status = $4,
              attempt_count = $5,
              next_attempt_at = transaction_timestamp() + ($6::text || ' milliseconds')::interval,
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              last_error_code = $7,
              last_http_status = $8,
              last_attempt_at = transaction_timestamp(),
              updated_at = transaction_timestamp()
        WHERE organization_id = $1 AND id = $2 AND lease_token = $3 AND status = 'leased'`,
      [
        claim.organizationId,
        claim.jobId,
        claim.jobToken,
        nextStatus,
        nextAttempt,
        String(waitMs),
        nextStatus === 'succeeded' ? null : attemptOutcome,
        outcome.httpStatus,
      ],
    );
    if ((updated.rowCount ?? 0) !== 1) return 'lost';
    await client.query(
      `INSERT INTO fad_event_delivery_attempts (
         organization_id, id, job_id, attempt_number, started_at, finished_at,
         http_status, outcome, request_digest, latency_ms
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        claim.organizationId,
        claim.deliveryId,
        claim.jobId,
        claim.attempt,
        outcome.startedAt,
        finished,
        outcome.httpStatus,
        attemptOutcome,
        createHash('sha256').update(String(claim.jobId)).update(String(claim.attempt)).digest(),
        latency,
      ],
    );
    await client.query(
      `UPDATE fad_event_subscriptions
          SET delivery_lease_owner = NULL, delivery_lease_token = NULL, delivery_lease_until = NULL
        WHERE organization_id = $1 AND id = $2 AND delivery_lease_token = $3`,
      [claim.organizationId, claim.subscriptionId, claim.subscriptionToken],
    );
    if (claim.replayToken !== LIVE_TOKEN) await refreshReplay(client, claim.organizationId, claim.replayToken);
    return 'acked';
  });
}

export async function postSignedWebhook(
  claim: Pick<DeliveryClaim, 'url' | 'secret' | 'keyId' | 'eventId' | 'deliveryId' | 'body'>,
  timestamp = String(Math.floor(Date.now() / 1000)),
): Promise<{ status: number; body: Buffer; retryAfterSeconds: number | null }> {
  const signature = `v1=${webhookSignature(claim.secret, timestamp, claim.body)}`;
  const response = await postWebhook({
    url: claim.url,
    body: claim.body,
    headers: {
      'X-FAD-Timestamp': timestamp,
      'X-FAD-Event-Id': claim.eventId,
      'X-FAD-Delivery-Id': claim.deliveryId,
      'X-FAD-Key-Id': claim.keyId,
      'X-FAD-Signature': signature,
    },
  });
  return { status: response.status, body: response.body, retryAfterSeconds: response.retryAfterSeconds };
}

export async function eventCaptureBlocksReady(pool: Pool): Promise<boolean> {
  const enabled = process.env.FAD_EVENTS_ENABLED === 'true';
  const present = await pool.query(`SELECT 1 FROM schema_migrations WHERE version = '20261021_007_durable_events'`);
  if ((present.rowCount ?? 0) !== 1) return enabled;
  const control = await pool.query<{ required: boolean }>(`SELECT required FROM fad_event_capture_control WHERE id = true`);
  if (control.rows[0]?.required === true && !enabled) return true;
  if (enabled && (process.env.FAD_EVENTS_SECRET_KEY ?? '').length < 16) return true;
  return false;
}

const SUBSCRIPTION_COLUMNS = `id, callback_url, description, event_types, status, revision::text,
  start_after_sequence::text, verified_at, created_at, updated_at, owner_principal_id,
  verification_attempts, challenge_ciphertext, challenge_expires_at`;

function requireScope(actor: EventActor, scope: string): void {
  if (!hasScope(actor.scopes, scope)) throw new EventServiceError(403, 'FORBIDDEN');
}

async function requireActor(client: PoolClient, actor: EventActor): Promise<void> {
  const row = await client.query<{ principal_status: string; organization_status: string }>(
    `SELECT p.status AS principal_status, o.status AS organization_status
       FROM principals p
       JOIN organizations o ON o.id = p.organization_id
      WHERE p.organization_id = $1 AND p.id = $2`,
    [actor.organizationId, actor.principalId],
  );
  const found = row.rows[0];
  if (!found || found.principal_status !== 'active' || found.organization_status !== 'active') {
    throw new EventServiceError(403, 'FORBIDDEN');
  }
}

async function streamRow(client: PoolClient, organizationId: string): Promise<{ last: number; minRetained: number }> {
  const result = await client.query<{ last_sequence: string; min_retained_sequence: string }>(
    `SELECT last_sequence::text, min_retained_sequence::text
       FROM fad_event_streams WHERE organization_id = $1`,
    [organizationId],
  );
  const row = result.rows[0];
  if (!row) return { last: 0, minRetained: 1 };
  return { last: Number(row.last_sequence), minRetained: Number(row.min_retained_sequence) };
}

function resourceAllowed(scopes: readonly string[], type: DirectoryEventType, visibility: 'standard' | 'restricted'): boolean {
  if (visibility === 'restricted' && !hasScope(scopes, 'events:restricted:read')) return false;
  const required = scopesFor(type);
  return required.every((scope) => hasScope(scopes, scope));
}

function scopesFor(type: DirectoryEventType): string[] {
  switch (type) {
    case 'com.fad.agent.registered.v1':
    case 'com.fad.agent.updated.v1':
    case 'com.fad.agent.lifecycle_changed.v1':
      return ['agents:read'];
    case 'com.fad.tag.definition_created.v1':
      return ['tags:read'];
    case 'com.fad.tag.assignment_changed.v1':
      return ['tags:read', 'agents:read'];
    case 'com.fad.capability.published.v1':
      return ['capabilities:read'];
    case 'com.fad.agent.endpoint_changed.v1':
      return ['endpoints:read', 'agents:read'];
    case 'com.fad.agent.capability_binding_changed.v1':
      return ['capabilities:read', 'agents:read'];
    case 'com.fad.policy.lifecycle_changed.v1':
      return ['policies:read', 'events:restricted:read'];
    case 'com.fad.enforcement.config_changed.v1':
      return ['enforcement:read', 'events:restricted:read'];
    default:
      return ['events:restricted:read'];
  }
}

async function rowVisible(client: PoolClient, actor: EventActor, row: EventRow): Promise<boolean> {
  if (!isDirectoryEventType(row.event_type)) return false;
  if (!resourceAllowed(actor.scopes, row.event_type, row.visibility)) return false;
  const agentId = typeof row.payload.agent_id === 'string' ? row.payload.agent_id : row.aggregate_id;
  if (!agentId || !isUuid(agentId)) return true;
  if (!scopesFor(row.event_type).includes('agents:read') && row.event_type !== 'com.fad.tag.definition_created.v1') {
    return true;
  }
  if (row.event_type === 'com.fad.tag.definition_created.v1' || row.event_type === 'com.fad.capability.published.v1' || row.event_type === 'com.fad.policy.lifecycle_changed.v1' || row.event_type === 'com.fad.enforcement.config_changed.v1') {
    return true;
  }
  try {
    await enforceAgent(client, {
      organizationId: actor.organizationId,
      principalId: actor.principalId,
      requestId: actor.requestId,
      scopes: actor.scopes,
      channel: actor.channel ?? 'rest',
    }, 'getAgent', agentId, 'read');
    return true;
  } catch (error) {
    if (error instanceof CommittedDenial) return false;
    throw error;
  }
}

function toCloudEvent(row: EventRow, organizationId: string, includeSequence: boolean): CloudEventBody {
  const event: CloudEventBody = {
    specversion: '1.0',
    id: row.event_id,
    source: `urn:fad:organization:${organizationId}`,
    type: row.event_type,
    subject: row.subject,
    time: iso(row.occurred_at),
    datacontenttype: 'application/json',
    data: row.payload ?? {},
  };
  if (includeSequence) event.fadsequence = Number(row.sequence);
  return event;
}

function parseCreate(body: unknown): { callback_url: string; event_types: string[]; description: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new EventServiceError(400, 'VALIDATION_ERROR');
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== 'callback_url' && key !== 'event_types' && key !== 'description')) {
    throw new EventServiceError(400, 'VALIDATION_ERROR');
  }
  if (typeof record.callback_url !== 'string' || record.callback_url.length < 12 || record.callback_url.length > 2048) {
    throw new EventServiceError(400, 'VALIDATION_ERROR');
  }
  if (!Array.isArray(record.event_types) || record.event_types.length < 1 || record.event_types.length > 20) {
    throw new EventServiceError(400, 'VALIDATION_ERROR');
  }
  const types: string[] = [];
  for (const item of record.event_types) {
    if (typeof item !== 'string' || !isDirectoryEventType(item) || types.includes(item)) {
      throw new EventServiceError(400, 'VALIDATION_ERROR');
    }
    types.push(item);
  }
  const description = record.description === undefined ? '' : record.description;
  if (typeof description !== 'string' || description.length > 256) throw new EventServiceError(400, 'VALIDATION_ERROR');
  return { callback_url: record.callback_url, event_types: types, description };
}

function parsePatchStatus(body: unknown): 'active' | 'paused' | 'disabled' {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new EventServiceError(400, 'VALIDATION_ERROR');
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || (record.status !== 'active' && record.status !== 'paused' && record.status !== 'disabled')) {
    throw new EventServiceError(400, 'VALIDATION_ERROR');
  }
  return record.status;
}

function parseReplay(body: unknown): { after_sequence: number; through_sequence: number; reason: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new EventServiceError(400, 'VALIDATION_ERROR');
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['after_sequence', 'through_sequence', 'reason'].includes(key))) {
    throw new EventServiceError(400, 'VALIDATION_ERROR');
  }
  const after = record.after_sequence;
  const through = record.through_sequence;
  const reason = record.reason;
  if (typeof after !== 'number' || !Number.isInteger(after) || after < 0) throw new EventServiceError(400, 'VALIDATION_ERROR');
  if (typeof through !== 'number' || !Number.isInteger(through) || through < 1) throw new EventServiceError(400, 'VALIDATION_ERROR');
  if (through <= after || through - after > 10_000) throw new EventServiceError(400, 'VALIDATION_ERROR');
  if (typeof reason !== 'string' || reason.trim().length < 1 || reason.length > 256) throw new EventServiceError(400, 'VALIDATION_ERROR');
  return { after_sequence: after, through_sequence: through, reason: reason.trim() };
}

function parseEventType(value: string): DirectoryEventType {
  if (!isDirectoryEventType(value)) throw new EventServiceError(400, 'VALIDATION_ERROR');
  return value;
}

function transitionAllowed(current: SubscriptionRow['status'], next: 'active' | 'paused' | 'disabled'): boolean {
  if (current === 'disabled' || current === 'pending_verification') return false;
  if (current === 'active') return next === 'paused' || next === 'disabled' || next === 'active';
  return next === 'active' || next === 'disabled' || next === 'paused';
}

function parseSubscriptionEtag(value: string | undefined): number {
  if (value === undefined || value === '') throw new EventServiceError(428, 'PRECONDITION_REQUIRED');
  const match = /^"subscription-v([1-9][0-9]*)"$/.exec(value);
  if (!match?.[1]) throw new EventServiceError(400, 'VALIDATION_ERROR');
  return Number(match[1]);
}

function etagOf(revision: number): string {
  return `"subscription-v${revision}"`;
}

function pageLimit(value: number | undefined): number {
  if (value === undefined) return PAGE_DEFAULT;
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new EventServiceError(400, 'VALIDATION_ERROR');
  return value;
}

function subscriptionView(row: SubscriptionRow): Record<string, unknown> {
  return {
    id: row.id,
    callback_url: row.callback_url,
    description: row.description,
    event_types: row.event_types,
    status: row.status,
    revision: Number(row.revision),
    verified_at: row.verified_at ? iso(row.verified_at) : null,
    start_after_sequence: row.start_after_sequence === null ? null : Number(row.start_after_sequence),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

async function lockSubscription(client: PoolClient, organizationId: string, id: string): Promise<SubscriptionRow | undefined> {
  const result = await client.query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_COLUMNS}
       FROM fad_event_subscriptions
      WHERE organization_id = $1 AND id = $2
      FOR UPDATE`,
    [organizationId, id],
  );
  return result.rows[0];
}

async function readVisibleSubscription(client: PoolClient, actor: EventActor, id: string): Promise<SubscriptionRow> {
  const result = await client.query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_COLUMNS}
       FROM fad_event_subscriptions
      WHERE organization_id = $1 AND id = $2`,
    [actor.organizationId, id],
  );
  const row = result.rows[0];
  if (!row) throw new EventServiceError(404, 'NOT_FOUND');
  if (row.owner_principal_id !== actor.principalId && !hasScope(actor.scopes, 'events:manage') && !hasScope(actor.scopes, 'events:delivery:read') && !hasScope(actor.scopes, 'events:replay')) {
    throw new EventServiceError(404, 'NOT_FOUND');
  }
  return row;
}

async function lockVisible(client: PoolClient, actor: EventActor, id: string): Promise<SubscriptionRow> {
  const row = await lockSubscription(client, actor.organizationId, id);
  if (!row) throw new EventServiceError(404, 'NOT_FOUND');
  const manage = hasScope(actor.scopes, 'events:manage') || hasScope(actor.scopes, 'events:replay');
  if (row.owner_principal_id !== actor.principalId && !manage) throw new EventServiceError(404, 'NOT_FOUND');
  return row;
}

interface ReceiptRow {
  subscription_id: string;
  secret_id: string;
  request_digest: Buffer;
  expires_at: Date;
}

async function readReceipt(
  client: PoolClient,
  actor: EventActor,
  kind: 'create_subscription' | 'rotate_secret',
  key: string,
): Promise<ReceiptRow | undefined> {
  const result = await client.query<ReceiptRow>(
    `SELECT subscription_id, secret_id, request_digest, expires_at
       FROM fad_event_secret_receipts
      WHERE organization_id = $1 AND owner_principal_id = $2
        AND operation_kind = $3 AND receipt_key = $4`,
    [actor.organizationId, actor.principalId, kind, key],
  );
  return result.rows[0];
}

async function insertReceipt(
  client: PoolClient,
  actor: EventActor,
  kind: 'create_subscription' | 'rotate_secret',
  key: string,
  subscriptionId: string,
  secretId: string,
  digest: Buffer,
): Promise<void> {
  await client.query(
    `INSERT INTO fad_event_secret_receipts (
       organization_id, owner_principal_id, receipt_key, operation_kind,
       subscription_id, secret_id, request_digest, expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7, transaction_timestamp() + interval '24 hours')`,
    [actor.organizationId, actor.principalId, key, kind, subscriptionId, secretId, digest],
  );
}

async function revealReceipt(
  client: PoolClient,
  actor: EventActor,
  receipt: ReceiptRow,
  fingerprint: Buffer,
): Promise<{ status: number; etag: string; body: Record<string, unknown> }> {
  if (!receipt.request_digest.equals(fingerprint)) throw new IdempotencyConflictError();
  const expires = receipt.expires_at instanceof Date ? receipt.expires_at : new Date(receipt.expires_at);
  if (expires.getTime() <= Date.now()) throw new EventServiceError(409, 'SECRET_RECEIPT_EXPIRED');
  const secret = await client.query<{ ciphertext: Buffer; status: string; retire_after: Date | null }>(
    `SELECT ciphertext, status, retire_after
       FROM fad_webhook_secrets
      WHERE organization_id = $1 AND id = $2`,
    [actor.organizationId, receipt.secret_id],
  );
  const row = secret.rows[0];
  if (!row || row.status !== 'active') throw new EventServiceError(409, 'SECRET_RECEIPT_EXPIRED');
  const subscription = await lockSubscription(client, actor.organizationId, receipt.subscription_id);
  if (!subscription) throw new EventServiceError(409, 'SECRET_RECEIPT_EXPIRED');
  const plain = openSeal(row.ciphertext).toString('utf8');
  const overlap = row.retire_after ? iso(row.retire_after) : null;
  const body: Record<string, unknown> = {
    subscription: subscriptionView(subscription),
    signing_secret: plain,
    signing_key_id: receipt.secret_id,
  };
  if (overlap && subscription.revision !== '1') body.overlap_expires_at = new Date(Date.now() + OVERLAP_MS).toISOString();
  return { status: subscription.revision === '1' && subscription.status === 'pending_verification' ? 201 : 200, etag: etagOf(Number(subscription.revision)), body };
}

async function activeSecret(client: PoolClient, organizationId: string, subscriptionId: string): Promise<{ id: string; secret: string } | null> {
  const result = await client.query<{ id: string; ciphertext: Buffer }>(
    `SELECT id, ciphertext FROM fad_webhook_secrets
      WHERE organization_id = $1 AND subscription_id = $2 AND status = 'active'`,
    [organizationId, subscriptionId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, secret: openSeal(row.ciphertext).toString('utf8') };
}

async function ownerCanReceive(
  client: PoolClient,
  organizationId: string,
  principalId: string,
  row: EventRow,
): Promise<{ ok: true; restricted: boolean } | { ok: false; reason: string }> {
  if (!isDirectoryEventType(row.event_type)) return { ok: false, reason: 'type_unknown' };
  const principal = await client.query<{ status: string }>(
    `SELECT status FROM principals WHERE organization_id = $1 AND id = $2`,
    [organizationId, principalId],
  );
  if (principal.rows[0]?.status !== 'active') return { ok: false, reason: 'owner_inactive' };
  const keys = await client.query<{ scopes: string[] | null }>(
    `SELECT fad_s7_principal_scopes($1::uuid) AS scopes`,
    [principalId],
  );
  const scopes = keys.rows[0]?.scopes ?? [];
  if (!hasScope(scopes, 'events:read')) return { ok: false, reason: 'scope_missing' };
  if (!resourceAllowed(scopes, row.event_type, row.visibility)) return { ok: false, reason: 'scope_missing' };
  const actor: EventActor = {
    organizationId,
    principalId,
    requestId: randomUUID(),
    scopes,
  };
  if (!(await rowVisible(client, actor, row))) return { ok: false, reason: 'policy_denied' };
  return { ok: true, restricted: hasScope(scopes, 'events:restricted:read') };
}

async function cancelJob(client: PoolClient, organizationId: string, jobId: string, reason: string): Promise<void> {
  await client.query(
    `UPDATE fad_event_delivery_jobs
        SET status = 'cancelled', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
            last_error_code = $3, updated_at = transaction_timestamp()
      WHERE organization_id = $1 AND id = $2 AND status IN ('pending','leased')`,
    [organizationId, jobId, reason.slice(0, 80)],
  );
}

async function releaseExpired(client: PoolClient, organizationId: string): Promise<void> {
  await client.query(
    `UPDATE fad_event_subscriptions
        SET delivery_lease_owner = NULL, delivery_lease_token = NULL, delivery_lease_until = NULL
      WHERE organization_id = $1 AND delivery_lease_until < transaction_timestamp()`,
    [organizationId],
  );
  await client.query(
    `UPDATE fad_event_delivery_jobs
        SET status = 'pending', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
            updated_at = transaction_timestamp()
      WHERE organization_id = $1 AND status = 'leased' AND lease_expires_at < transaction_timestamp()`,
    [organizationId],
  );
}

async function refreshReplay(client: PoolClient, organizationId: string, replayId: string): Promise<void> {
  await client.query(
    `UPDATE fad_event_replay_requests AS r
        SET status = CASE
              WHEN NOT EXISTS (
                SELECT 1 FROM fad_event_delivery_jobs j
                 WHERE j.organization_id = r.organization_id AND j.replay_token = r.id
                   AND j.status IN ('pending','leased'))
               AND EXISTS (
                SELECT 1 FROM fad_event_delivery_jobs j
                 WHERE j.organization_id = r.organization_id AND j.replay_token = r.id
                   AND j.status = 'dead')
              THEN 'failed'
              WHEN NOT EXISTS (
                SELECT 1 FROM fad_event_delivery_jobs j
                 WHERE j.organization_id = r.organization_id AND j.replay_token = r.id
                   AND j.status IN ('pending','leased'))
              THEN 'completed'
              ELSE 'running'
            END,
            completed_at = CASE
              WHEN NOT EXISTS (
                SELECT 1 FROM fad_event_delivery_jobs j
                 WHERE j.organization_id = r.organization_id AND j.replay_token = r.id
                   AND j.status IN ('pending','leased'))
              THEN transaction_timestamp()
              ELSE NULL
            END
      WHERE organization_id = $1 AND id = $2`,
    [organizationId, replayId],
  );
}

async function replayView(client: PoolClient, organizationId: string, replayId: string): Promise<Record<string, unknown>> {
  const result = await client.query<{
    id: string;
    subscription_id: string;
    from_sequence_exclusive: string;
    through_sequence_inclusive: string;
    status: string;
    created_at: Date | string;
    completed_at: Date | string | null;
  }>(
    `SELECT id, subscription_id, from_sequence_exclusive::text, through_sequence_inclusive::text,
            status, created_at, completed_at
       FROM fad_event_replay_requests
      WHERE organization_id = $1 AND id = $2`,
    [organizationId, replayId],
  );
  const row = result.rows[0];
  if (!row) throw new EventServiceError(404, 'NOT_FOUND');
  return {
    id: row.id,
    subscription_id: row.subscription_id,
    after_sequence: Number(row.from_sequence_exclusive),
    through_sequence: Number(row.through_sequence_inclusive),
    status: row.status,
    created_at: iso(row.created_at),
    completed_at: row.completed_at ? iso(row.completed_at) : null,
  };
}

async function storePlain(
  client: PoolClient,
  actor: EventActor,
  method: 'POST' | 'PATCH',
  path: string,
  idempotencyKey: string,
  fingerprint: Buffer,
  etag: string,
  body: Record<string, unknown>,
): Promise<void> {
  await writeIdempotency(client, {
    organizationId: actor.organizationId,
    principalId: actor.principalId,
    method,
    resourcePath: path,
    idemKey: idempotencyKey,
    requestSha256: fingerprint,
    responseStatus: 200,
    responseHeaders: etag ? { etag } : {},
    responseBody: body,
    expiresAt: new Date(Date.now() + RETENTION_MS),
  });
}

function audit(actor: EventActor, action: string, targetId: string, details: Record<string, unknown>) {
  return {
    organizationId: actor.organizationId,
    actorPrincipalId: actor.principalId,
    action,
    targetType: 'event_subscription',
    targetId,
    outcome: 'success' as const,
    requestId: actor.requestId,
    details,
  };
}

function secretKey(): Buffer {
  const raw = process.env.FAD_EVENTS_SECRET_KEY ?? '';
  if (raw.length < 16) throw new EventServiceError(503, 'DEPENDENCY_UNAVAILABLE');
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return createHash('sha256').update(raw, 'utf8').digest();
}

function seal(plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}

class SealError extends Error {
  constructor() {
    super('seal');
    this.name = 'SealError';
  }
}

function openSeal(packed: Buffer): Buffer {
  const key = secretKey();
  if (!Buffer.isBuffer(packed) || packed.length < 29) throw new SealError();
  try {
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const data = packed.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch (error) {
    if (error instanceof EventServiceError) throw error;
    throw new SealError();
  }
}

async function bumpVerification(client: PoolClient, organizationId: string, subscriptionId: string): Promise<void> {
  await client.query(
    `UPDATE fad_event_subscriptions
        SET verification_attempts = verification_attempts + 1,
            updated_at = transaction_timestamp()
      WHERE organization_id = $1 AND id = $2 AND status = 'pending_verification'`,
    [organizationId, subscriptionId],
  );
}

function sameSecret(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest();
  const b = createHash('sha256').update(right).digest();
  return timingSafeEqual(a, b);
}

function echoChallenge(body: Buffer): string | null {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const challenge = (parsed as { challenge?: unknown }).challenge;
    return typeof challenge === 'string' ? challenge : null;
  } catch {
    return null;
  }
}

function scopeDigest(scopes: readonly string[]): string {
  return createHash('sha256').update([...scopes].sort().join('\n')).digest('hex');
}

function sealCursor(pepper: Buffer, claims: CursorClaims): string {
  const iv = randomBytes(12);
  const key = createHash('sha256').update(pepper).digest();
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(claims), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}

function openCursor(
  pepper: Buffer,
  token: string,
  actor: EventActor,
  kind: CursorClaims['kind'],
  filter: string,
  retention: number,
): CursorClaims {
  let packed: Buffer;
  try {
    packed = Buffer.from(token, 'base64url');
  } catch {
    throw new EventServiceError(400, 'INVALID_CURSOR');
  }
  if (packed.length < 29) throw new EventServiceError(400, 'INVALID_CURSOR');
  try {
    const key = createHash('sha256').update(pepper).digest();
    const decipher = createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12));
    decipher.setAuthTag(packed.subarray(12, 28));
    const json = Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8');
    const claims = JSON.parse(json) as CursorClaims;
    if (claims.v !== 1 || claims.kind !== kind) throw new EventServiceError(400, 'INVALID_CURSOR');
    if (claims.exp <= Date.now()) throw new EventServiceError(410, 'EVENT_CURSOR_EXPIRED');
    if (claims.org !== actor.organizationId || claims.principal !== actor.principalId || claims.scopes !== scopeDigest(actor.scopes) || claims.filter !== filter) {
      throw new EventServiceError(409, 'CURSOR_CONTEXT_CHANGED');
    }
    if (claims.retention !== retention) throw new EventServiceError(410, 'EVENT_CURSOR_EXPIRED');
    return claims;
  } catch (error) {
    if (error instanceof EventServiceError) throw error;
    throw new EventServiceError(400, 'INVALID_CURSOR');
  }
}

function leaseMs(): number {
  const raw = Number(process.env.FAD_EVENTS_LEASE_MS ?? '30000');
  if (!Number.isInteger(raw) || raw < 100 || raw > 120_000) return 30_000;
  return raw;
}

function backoffMs(attempt: number, retryAfterSeconds: number | null): number {
  const cap = 60 * 60 * 1000;
  if (retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(cap, Math.floor(retryAfterSeconds * 1000));
  }
  const exponential = Math.min(cap, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.random() * exponential);
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

export const EVENT_TYPE_CATALOG: readonly DirectoryEventType[] = DIRECTORY_EVENT_TYPES;
