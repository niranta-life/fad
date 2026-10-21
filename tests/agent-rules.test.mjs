import test from 'node:test';
import {
  AgentServiceError,
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
} from '@fad/db';
import { check } from './support.mjs';

const pepper = Buffer.from('fad-unit-pepper-0123456789-ABCDEFGH-not-secret', 'utf8');
const org = '059b581e-2145-476d-b5c5-4eb5b6eab527';
const agentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function fails(status, fn) {
  try {
    fn();
    return false;
  } catch (error) {
    return error instanceof AgentServiceError && error.status === status && error.code === 'VALIDATION_ERROR';
  }
}

test('agent field rules, state machine, and cursors', () => {
  check('rule-nfc', normalizeName('  Cafe\u0301  ') === 'Caf\u00e9');
  check('rule-emoji', normalizeName('🤖'.repeat(160)) === '🤖'.repeat(160) && codePointLength('🤖'.repeat(160)) === 160);
  check('rule-long', fails(422, () => normalizeName('a'.repeat(161))));
  check('rule-blank', fails(422, () => normalizeName('   ')));
  check('rule-control', fails(422, () => normalizeName('bad\u0000name')));
  check('rule-desc-create-null', fails(422, () => normalizeDescription(null, 'create')));
  check('rule-desc-patch-null', normalizeDescription(null, 'patch') === null);
  check('rule-desc-tab', normalizeDescription('line\n\tok', 'create') === 'line\n\tok');
  check('rule-desc-control', fails(422, () => normalizeDescription('bad\u0007', 'patch')));
  check('rule-reason', normalizeReason('  review  ') === 'review');
  check('rule-reason-blank', fails(422, () => normalizeReason('  ')));
  const created = parseCreateBody({ name: '  Agent  ', owner_principal_id: agentId });
  check('rule-create', created.name === 'Agent' && created.description === '' && created.ownerPrincipalId === agentId);
  check('rule-create-unknown', fails(422, () => parseCreateBody({ name: 'A', owner_principal_id: agentId, organization_id: org })));
  check('rule-create-status', fails(422, () => parseCreateBody({ name: 'A', owner_principal_id: agentId, status: 'retired' })));
  const cleared = parsePatchBody({ description: null });
  check('rule-clear', cleared.description === null && cleared.name === undefined);
  check('rule-empty-patch', fails(422, () => parsePatchBody({})));
  check('rule-patch-unknown', fails(422, () => parsePatchBody({ global_id: 'urn:fad:agent:x:y' })));
  check('rule-lifecycle', parseLifecycleBody({ reason: 'Security review' }) === 'Security review');
  check('rule-key', parseIdempotencyKey('agent-key-01') === 'agent-key-01');
  check('rule-key-short', fails(400, () => parseIdempotencyKey('short')));
  check('rule-etag-missing', parseEtag(undefined).kind === 'missing');
  check('rule-etag-star', parseEtag('*').kind === 'malformed');
  check('rule-etag-weak', parseEtag('W/"agent-v1"').kind === 'malformed');
  const etag = parseEtag('"agent-v12"');
  check('rule-etag-ok', etag.kind === 'ok' && etag.revision === 12);
  check('rule-active-suspend', nextStatus('active', 'suspend').kind === 'change');
  check('rule-active-activate', nextStatus('active', 'activate').kind === 'noop');
  check('rule-active-retire', nextStatus('active', 'retire').status === 'retired');
  check('rule-suspended-suspend', nextStatus('suspended', 'suspend').kind === 'noop');
  check('rule-suspended-activate', nextStatus('suspended', 'activate').status === 'active');
  check('rule-retired-activate', nextStatus('retired', 'activate').kind === 'conflict');
  check('rule-retired-suspend', nextStatus('retired', 'suspend').kind === 'conflict');
  check('rule-retired-retire', nextStatus('retired', 'retire').kind === 'noop');
  const now = Date.parse('2026-10-20T00:00:00.000Z');
  const cursor = encodeCursor(pepper, { org, status: 'active', at: '2026-10-20T00:00:00.000Z', id: agentId }, now);
  const decoded = decodeCursor(pepper, cursor, { org, status: 'active' }, now + 1000);
  check('rule-cursor', decoded.id === agentId && decoded.at === '2026-10-20T00:00:00.000Z');
  check('rule-cursor-tamper', fails(400, () => decodeCursor(pepper, `${cursor}x`, { org, status: 'active' }, now + 1000)));
  check('rule-cursor-filter', fails(400, () => decodeCursor(pepper, cursor, { org, status: null }, now + 1000)));
  check('rule-cursor-tenant', fails(400, () => decodeCursor(pepper, cursor, { org: '04935950-2b06-4f92-a2f4-5ca70d4d5ccb', status: 'active' }, now + 1000)));
  check('rule-cursor-expiry', fails(400, () => decodeCursor(pepper, cursor, { org, status: 'active' }, now + 24 * 60 * 60 * 1000 + 1)));
});
