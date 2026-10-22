import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { EXCLUDED_OPERATIONS, PROTECTED_OPERATIONS } from '@fad/db';

const openapi = parse(readFileSync(new URL('../contracts/openapi.yaml', import.meta.url), 'utf8'));
const protectedIds = new Set(PROTECTED_OPERATIONS.map((item) => item.operationId));
const excluded = new Set(EXCLUDED_OPERATIONS);
// The published Slice 2 operationId differs from the Slice 6 map name. Do not rename it.
const aliases = new Map([['searchAgentsByTag', 'searchAgentsByTags']]);

test('every agent child route and discovery route is covered by the PEP map', () => {
  const missing = [];
  for (const [path, item] of Object.entries(openapi.paths ?? {})) {
    const covered = path === '/v1/agents' || path.startsWith('/v1/agents/') || path === '/v1/discovery/agents';
    if (!covered || item === null || typeof item !== 'object') continue;
    for (const [method, operation] of Object.entries(item)) {
      if (!['get', 'put', 'post', 'patch', 'delete'].includes(method)) continue;
      if (operation === null || typeof operation !== 'object') continue;
      const operationId = operation.operationId;
      if (typeof operationId !== 'string') {
        missing.push(`${method} ${path}`);
        continue;
      }
      const mapped = aliases.get(operationId) ?? operationId;
      if (!protectedIds.has(mapped) && !excluded.has(mapped)) missing.push(operationId);
    }
  }
  if (missing.length > 0) throw new Error(`uncovered agent routes: ${missing.join(', ')}`);
  if (!openapi.paths?.['/v1/enforcement/config']?.get) throw new Error('missing enforcement config read');
  if (!openapi.paths?.['/v1/enforcement/config']?.put) throw new Error('missing enforcement config write');
  if (!openapi.paths?.['/v1/enforcement/preflight']?.post) throw new Error('missing enforcement preflight');
  if (!openapi.paths?.['/v1/enforcement/decisions/{decisionId}']?.get) throw new Error('missing enforcement decision read');
  const decision = openapi.components?.schemas?.EvaluationDecision;
  if (decision?.properties?.enforcement?.const !== 'not_enforced') throw new Error('evaluation enforcement changed');
});
