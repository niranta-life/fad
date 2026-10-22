import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { ENABLED_TOOL_NAMES } from '@fad/mcp-client';

const frozen = JSON.parse(readFileSync(new URL('./fixtures/slice5-operations.json', import.meta.url), 'utf8'));
const openapi = parse(readFileSync(new URL('../contracts/openapi.yaml', import.meta.url), 'utf8'));
const catalog = readFileSync(new URL('../apps/api/src/mcp-catalog.ts', import.meta.url), 'utf8');
const methods = ['get', 'put', 'post', 'patch', 'delete'];
const priorTools = [
  'fad_list_agents', 'fad_get_agent', 'fad_register_agent', 'fad_update_agent',
  'fad_suspend_agent', 'fad_activate_agent', 'fad_list_agent_tags', 'fad_put_agent_tag',
  'fad_search_agents_by_tags', 'fad_list_capabilities', 'fad_publish_capability',
  'fad_put_endpoint', 'fad_put_binding', 'fad_discover_agents', 'fad_list_policies',
  'fad_get_policy', 'fad_create_policy', 'fad_update_draft_policy', 'fad_activate_policy',
  'fad_disable_policy', 'fad_evaluate_access',
];
const addedTools = [
  'fad_get_enforcement_config', 'fad_preflight_enforcement',
  'fad_set_enforcement_config', 'fad_get_enforcement_decision',
];

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

test('slice 5 paths and the deployed MCP catalog stay unchanged except four enforcement tools', () => {
  if (frozen.path_count !== 27 || frozen.operation_count !== 41) throw new Error('slice 5 freeze moved');
  if (openapi.info.version !== '1.5.0') throw new Error(`version ${openapi.info.version}`);
  for (const item of frozen.operations) {
    const live = openapi.paths?.[item.path]?.[item.method];
    if (!live) throw new Error(`removed ${item.method} ${item.path}`);
    if (!same(live, item.operation)) throw new Error(`changed ${item.method} ${item.path}`);
  }
  const livePaths = Object.keys(openapi.paths);
  const extraPaths = livePaths.filter((path) => !frozen.paths.includes(path)).sort();
  if (!same(extraPaths, ['/v1/enforcement/config', '/v1/enforcement/decisions/{decisionId}', '/v1/enforcement/preflight'])) {
    throw new Error(`unexpected paths ${extraPaths.join(',')}`);
  }
  const evaluate = openapi.paths?.['/v1/authorization/evaluate']?.post;
  if (evaluate?.responses?.['200'] == null) throw new Error('evaluate response missing');
  if (openapi.components?.schemas?.EvaluationDecision?.properties?.enforcement?.const !== 'not_enforced') {
    throw new Error('evaluation enforcement changed');
  }
  let liveOps = 0;
  for (const item of Object.values(openapi.paths)) {
    for (const method of methods) if (item?.[method]) liveOps += 1;
  }
  if (liveOps !== 45) throw new Error(`operation count ${liveOps}`);
  const tools = [...catalog.matchAll(/'(fad_[a-z0-9_]+)'/g)].map((match) => match[1]);
  if (!same(tools, [...priorTools, ...addedTools])) throw new Error(`mcp catalog ${tools.join(',')}`);
  if (!same([...ENABLED_TOOL_NAMES], priorTools.slice(0, ENABLED_TOOL_NAMES.length))) {
    throw new Error('mcp client enabled tools changed');
  }
  if (ENABLED_TOOL_NAMES.length !== 14) throw new Error('mcp client tool count changed');
});
