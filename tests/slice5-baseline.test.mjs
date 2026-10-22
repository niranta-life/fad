import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { KNOWN_SCOPES } from '@fad/auth-core';
import { ENABLED_TOOL_NAMES } from '@fad/mcp-client';

const baseline = JSON.parse(readFileSync(new URL('./fixtures/slice4-baseline.json', import.meta.url), 'utf8'));
const openapi = parse(readFileSync(new URL('../contracts/openapi.yaml', import.meta.url), 'utf8'));
const sdkSource = readFileSync(new URL('../packages/sdk/src/index.ts', import.meta.url), 'utf8');
const catalog = readFileSync(new URL('../apps/api/src/mcp-catalog.ts', import.meta.url), 'utf8');

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exportNames(source) {
  return [...source.matchAll(/export (?:interface|type|class|function|const) ([A-Za-z0-9_]+)/g)].map((match) => match[1]);
}

test('slice 4 contracts stay present and policy contracts are additive', () => {
  if (baseline.openapi_version !== '1.4.0') throw new Error('baseline version moved');
  if (openapi.info.version !== '1.5.0') throw new Error(`live version ${openapi.info.version}`);
  for (const item of baseline.operations) {
    const live = openapi.paths?.[item.path]?.[item.method];
    if (!live) throw new Error(`removed ${item.method} ${item.path}`);
    if (!same(live, item.operation)) throw new Error(`changed ${item.method} ${item.path}`);
  }
  const added = [
    ['post', '/v1/policies'],
    ['get', '/v1/policies'],
    ['get', '/v1/policies/{policyId}'],
    ['put', '/v1/policies/{policyId}'],
    ['post', '/v1/policies/{policyId}/activate'],
    ['post', '/v1/policies/{policyId}/disable'],
    ['post', '/v1/authorization/evaluate'],
  ];
  for (const [method, path] of added) {
    if (openapi.paths?.[path]?.[method] == null) throw new Error(`missing ${method} ${path}`);
  }
  const names = exportNames(sdkSource);
  let cursor = -1;
  for (const name of baseline.sdk_exports) {
    const at = names.indexOf(name);
    if (at <= cursor) throw new Error(`sdk export missing or reordered: ${name}`);
    cursor = at;
  }
  if (sdkSource.includes('invokeAgent')) throw new Error('sdk treats evaluation as invocation');
  if (!sdkSource.includes('readonly policies') || !sdkSource.includes('readonly authorization')) {
    throw new Error('sdk policy surfaces are missing');
  }
  const tools = [...catalog.matchAll(/'(fad_[a-z0-9_]+)'/g)].map((match) => match[1]);
  if (!same(tools.slice(0, baseline.mcp_tools.length), baseline.mcp_tools)) throw new Error('mcp tool order changed');
  if (!same([...ENABLED_TOOL_NAMES], baseline.mcp_tools)) throw new Error('enabled mcp tools changed');
  const policyTools = ['fad_list_policies', 'fad_get_policy', 'fad_create_policy', 'fad_update_draft_policy', 'fad_activate_policy', 'fad_disable_policy', 'fad_evaluate_access'];
  if (!policyTools.every((name) => tools.includes(name))) throw new Error('policy tools are not approved');
  if (!same([...KNOWN_SCOPES].slice(0, baseline.scopes.length), baseline.scopes)) throw new Error('scope order changed');
  const policyScopes = ['policies:read', 'policies:write', 'policies:activate', 'policies:evaluate:self', 'policies:evaluate:any', 'policies:explain'];
  if (!policyScopes.every((scope) => KNOWN_SCOPES.includes(scope))) throw new Error('policy scopes missing');
});
