import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { KNOWN_SCOPES } from '@fad/auth-core';
import { ENABLED_TOOL_NAMES } from '@fad/mcp-client';
import { scratch } from './support.mjs';

const frozen = JSON.parse(readFileSync(new URL('./fixtures/slice5-operations.json', import.meta.url), 'utf8'));
const openapi = parse(readFileSync(new URL('../contracts/openapi.yaml', import.meta.url), 'utf8'));
const catalog = readFileSync(new URL('../apps/api/src/mcp-catalog.ts', import.meta.url), 'utf8');
const sdk = readFileSync(new URL('../packages/sdk/src/index.ts', import.meta.url), 'utf8');
const methods = ['get', 'put', 'post', 'patch', 'delete'];
const eventPaths = [
  '/v1/events',
  '/v1/events/{eventId}',
  '/v1/event-subscriptions',
  '/v1/event-subscriptions/{subscriptionId}',
  '/v1/event-subscriptions/{subscriptionId}/rotate-secret',
  '/v1/event-subscriptions/{subscriptionId}/replays',
  '/v1/event-subscriptions/{subscriptionId}/replays/{replayId}',
  '/v1/event-subscriptions/{subscriptionId}/deliveries',
];
const eventOps = [
  ['get', '/v1/events'],
  ['get', '/v1/events/{eventId}'],
  ['post', '/v1/event-subscriptions'],
  ['get', '/v1/event-subscriptions'],
  ['get', '/v1/event-subscriptions/{subscriptionId}'],
  ['patch', '/v1/event-subscriptions/{subscriptionId}'],
  ['post', '/v1/event-subscriptions/{subscriptionId}/rotate-secret'],
  ['post', '/v1/event-subscriptions/{subscriptionId}/replays'],
  ['get', '/v1/event-subscriptions/{subscriptionId}/replays/{replayId}'],
  ['get', '/v1/event-subscriptions/{subscriptionId}/deliveries'],
];
const eventTools = [
  'fad_list_events', 'fad_get_event', 'fad_create_event_subscription', 'fad_list_event_subscriptions',
  'fad_get_event_subscription', 'fad_update_event_subscription', 'fad_rotate_event_subscription_secret',
  'fad_replay_events', 'fad_get_event_replay', 'fad_list_event_deliveries',
];

test('slice 7 contracts are additive', () => {
  const lines = [];
  const note = (name, ok, detail) => lines.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
  if (openapi.info.version !== '1.5.0') throw new Error(`version ${openapi.info.version}`);
  note('VERSION', true, openapi.info.version);
  for (const item of frozen.operations) {
    const live = openapi.paths?.[item.path]?.[item.method];
    if (!live || JSON.stringify(live) !== JSON.stringify(item.operation)) {
      throw new Error(`changed ${item.method} ${item.path}`);
    }
  }
  note('SLICE5_OPS', true, String(frozen.operations.length));
  const evaluate = openapi.paths?.['/v1/authorization/evaluate']?.post;
  if (openapi.components?.schemas?.EvaluationDecision?.properties?.enforcement?.const !== 'not_enforced') {
    throw new Error('evaluation enforcement changed');
  }
  note('EVALUATE', evaluate?.responses?.['200'] != null, 'not_enforced');
  for (const [method, path] of eventOps) {
    if (openapi.paths?.[path]?.[method] == null) throw new Error(`missing ${method} ${path}`);
  }
  let liveOps = 0;
  for (const item of Object.values(openapi.paths)) {
    for (const method of methods) if (item?.[method]) liveOps += 1;
  }
  if (liveOps !== 55) throw new Error(`operation count ${liveOps}`);
  note('OPS', true, String(liveOps));
  const tools = [...catalog.matchAll(/'(fad_[a-z0-9_]+)'/g)].map((match) => match[1]);
  if (tools.slice(-eventTools.length).join(',') !== eventTools.join(',')) throw new Error(tools.slice(-12).join(','));
  if (ENABLED_TOOL_NAMES.length !== 14) throw new Error('enabled tool count changed');
  if (!sdk.includes('verifyFadWebhookSignature') || !sdk.includes('readonly events')) throw new Error('sdk events surface missing');
  if (!sdk.includes('@fad/sdk/0.5.0')) throw new Error('sdk user agent changed');
  const scopes = ['events:read', 'events:subscribe', 'events:manage', 'events:replay', 'events:delivery:read', 'events:restricted:read'];
  if (!scopes.every((scope) => KNOWN_SCOPES.includes(scope))) throw new Error('event scopes missing');
  note('PATHS', true, eventPaths.join(','));
  note('TOOLS', true, eventTools.join(','));
  writeFileSync(join(scratch, 'contract-diff.log'), `${lines.join('\n')}\n`);
});
