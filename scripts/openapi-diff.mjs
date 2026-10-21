import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const publishedPath = new URL('../contracts/openapi.yaml', import.meta.url);
const packagePath = new URL('../plans/fad-slice-0/contracts/openapi.yaml', import.meta.url);
const slice1Path = new URL('../docs/releases/slice-1/contract-openapi.yaml', import.meta.url);
const SLICE0_SHA256 = 'bb5a6dc96ae93fb42ed6b69af1770cd435bba43809c8942b0702d9a748beb4cc';
const PARENT_COMMIT = '400c531d98685f8c93481ed3e527498c7b9d6fb3';
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head'];
const AGENT_OPERATIONS = [
  ['post', '/v1/agents'],
  ['get', '/v1/agents'],
  ['get', '/v1/agents/{agentId}'],
  ['patch', '/v1/agents/{agentId}'],
  ['post', '/v1/agents/{agentId}/suspend'],
  ['post', '/v1/agents/{agentId}/activate'],
  ['post', '/v1/agents/{agentId}/retire'],
];
const SLICE3_OPERATIONS = [
  ['post', '/v1/capabilities'],
  ['get', '/v1/capabilities'],
  ['get', '/v1/capabilities/{capabilityId}/versions/{version}'],
  ['get', '/v1/agents/{agentId}/endpoints'],
  ['get', '/v1/agents/{agentId}/endpoints/{endpointKey}'],
  ['put', '/v1/agents/{agentId}/endpoints/{endpointKey}'],
  ['delete', '/v1/agents/{agentId}/endpoints/{endpointKey}'],
  ['get', '/v1/agents/{agentId}/capabilities'],
  ['get', '/v1/agents/{agentId}/capabilities/{capabilityId}'],
  ['put', '/v1/agents/{agentId}/capabilities/{capabilityId}'],
  ['delete', '/v1/agents/{agentId}/capabilities/{capabilityId}'],
  ['post', '/v1/discovery/agents'],
];
const MCP_OPERATIONS = [
  ['post', '/mcp'],
  ['get', '/mcp'],
  ['delete', '/mcp'],
  ['get', '/.well-known/oauth-protected-resource/mcp'],
];
const POLICY_OPERATIONS = [
  ['post', '/v1/policies'],
  ['get', '/v1/policies'],
  ['get', '/v1/policies/{policyId}'],
  ['put', '/v1/policies/{policyId}'],
  ['post', '/v1/policies/{policyId}/activate'],
  ['post', '/v1/policies/{policyId}/disable'],
  ['post', '/v1/authorization/evaluate'],
];
const TAG_OPERATIONS = [
  ['post', '/v1/tag-definitions'],
  ['get', '/v1/tag-definitions'],
  ['get', '/v1/tag-definitions/{namespace}/{key}'],
  ['get', '/v1/agents/{agentId}/tags'],
  ['get', '/v1/agents/{agentId}/tags/{namespace}/{key}'],
  ['put', '/v1/agents/{agentId}/tags/{namespace}/{key}'],
  ['delete', '/v1/agents/{agentId}/tags/{namespace}/{key}'],
  ['post', '/v1/agents/search'],
];

function load(url) {
  const text = readFileSync(url);
  return { text, doc: parse(text.toString('utf8')) };
}

function operations(doc, path) {
  const item = doc.paths?.[path] ?? {};
  return METHODS.filter((method) => item[method] != null);
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const published = load(publishedPath);
const packaged = load(packagePath);
const slice1 = load(slice1Path);
const packageSha = createHash('sha256').update(packaged.text).digest('hex');
const publishedSha = createHash('sha256').update(published.text).digest('hex');
const breaking = [];

if (packageSha !== SLICE0_SHA256) {
  breaking.push('plans/fad-slice-0/contracts/openapi.yaml bytes changed');
}

const slice0Paths = Object.keys(packaged.doc.paths ?? {}).sort();
for (const path of slice0Paths) {
  if (published.doc.paths?.[path] == null) {
    breaking.push(`removed path ${path}`);
    continue;
  }
  for (const method of operations(packaged.doc, path)) {
    if (published.doc.paths[path][method] == null) {
      breaking.push(`removed ${method} ${path}`);
      continue;
    }
    if (!same(packaged.doc.paths[path][method], published.doc.paths[path][method])) {
      breaking.push(`changed ${method} ${path}`);
    }
  }
}

if (!same(packaged.doc.security, published.doc.security)) breaking.push('changed top-level security');
if (!same(packaged.doc.servers, published.doc.servers)) breaking.push('changed servers');

for (const section of ['schemas', 'responses', 'headers', 'securitySchemes']) {
  const before = packaged.doc.components?.[section] ?? {};
  const after = published.doc.components?.[section] ?? {};
  for (const key of Object.keys(before)) {
    if (!same(before[key], after[key])) breaking.push(`changed components.${section}.${key}`);
  }
}

const scheme = published.doc.components?.securitySchemes?.FadApiKey;
if (scheme?.type !== 'apiKey' || scheme.in !== 'header' || scheme.name !== 'X-FAD-API-Key') {
  breaking.push('credential header is not X-FAD-API-Key');
}

const slice1Paths = Object.keys(slice1.doc.paths ?? {}).sort();
for (const path of slice1Paths) {
  if (published.doc.paths?.[path] == null) {
    breaking.push(`removed slice1 path ${path}`);
    continue;
  }
  for (const method of operations(slice1.doc, path)) {
    if (published.doc.paths[path][method] == null) {
      breaking.push(`removed slice1 ${method} ${path}`);
      continue;
    }
    if (!same(slice1.doc.paths[path][method], published.doc.paths[path][method])) {
      breaking.push(`changed slice1 ${method} ${path}`);
    }
  }
}
for (const section of ['schemas', 'responses', 'headers', 'parameters', 'securitySchemes']) {
  const before = slice1.doc.components?.[section] ?? {};
  const after = published.doc.components?.[section] ?? {};
  for (const key of Object.keys(before)) {
    if (!same(before[key], after[key])) breaking.push(`changed slice1 components.${section}.${key}`);
  }
}

const slice1Present = [];
for (const [method, path] of AGENT_OPERATIONS) {
  if (published.doc.paths?.[path]?.[method] == null) breaking.push(`missing ${method} ${path}`);
  else slice1Present.push(`${method} ${path}`);
}
const added = [];
for (const [method, path] of TAG_OPERATIONS) {
  if (published.doc.paths?.[path]?.[method] == null) breaking.push(`missing ${method} ${path}`);
  else added.push(`${method} ${path}`);
}

const parentText = execFileSync('git', ['show', `${PARENT_COMMIT}:contracts/openapi.yaml`], { cwd: repoRoot });
const parentDoc = parse(parentText.toString('utf8'));
const preexisting = [];
for (const path of Object.keys(parentDoc.paths ?? {}).sort()) {
  for (const method of operations(parentDoc, path)) {
    const live = published.doc.paths?.[path]?.[method];
    if (live == null) {
      breaking.push(`removed parent ${method} ${path}`);
      continue;
    }
    if (!same(parentDoc.paths[path][method], live)) breaking.push(`changed parent ${method} ${path}`);
    else preexisting.push(`${method} ${path}`);
  }
}
const parentNew = [];
for (const path of Object.keys(published.doc.paths ?? {}).sort()) {
  for (const method of operations(published.doc, path)) {
    if (parentDoc.paths?.[path]?.[method] == null) parentNew.push(`${method} ${path}`);
  }
}
const expectedNew = TAG_OPERATIONS.map(([method, path]) => `${method} ${path}`).sort();
const expectedSlice3 = SLICE3_OPERATIONS.map(([method, path]) => `${method} ${path}`).sort();
const expectedSlice4 = [...expectedSlice3, ...MCP_OPERATIONS.map(([method, path]) => `${method} ${path}`)].sort();
const expectedSlice5 = [...expectedSlice4, ...POLICY_OPERATIONS.map(([method, path]) => `${method} ${path}`)].sort();
const parentNewSorted = [...parentNew].sort();
if (!same(parentNewSorted, expectedSlice5)) {
  breaking.push(`parent new operations are not exactly the slice 3, MCP, and policy routes: ${parentNew.join(', ')}`);
}
const slice3Present = [];
for (const [method, path] of SLICE3_OPERATIONS) {
  if (published.doc.paths?.[path]?.[method] == null) breaking.push(`missing ${method} ${path}`);
  else slice3Present.push(`${method} ${path}`);
}
for (const key of ['openapi', 'servers', 'security']) {
  if (!same(parentDoc[key], published.doc[key])) breaking.push(`changed parent ${key}`);
}
for (const section of ['schemas', 'responses', 'headers', 'parameters', 'securitySchemes']) {
  const before = parentDoc.components?.[section] ?? {};
  const after = published.doc.components?.[section] ?? {};
  for (const key of Object.keys(before)) {
    if (!same(before[key], after[key])) breaking.push(`changed parent components.${section}.${key}`);
  }
}
const documentChanges = [];
if (!same(parentDoc.info, published.doc.info)) documentChanges.push('info');
if (!same(parentDoc.tags, published.doc.tags)) documentChanges.push('tags');
const parentPreexistingDeepEqual = preexisting.length > 0
  && !breaking.some((item) => item.startsWith('changed parent') || item.startsWith('removed parent'));

const preserved = [];
for (const path of slice0Paths) {
  for (const method of operations(packaged.doc, path)) preserved.push(`${method} ${path}`);
}

const report = {
  ok: breaking.length === 0,
  slice0_package_sha256: packageSha,
  slice0_package_unchanged: packageSha === SLICE0_SHA256,
  published_sha256: publishedSha,
  parent_commit: PARENT_COMMIT,
  parent_preexisting_operations: preexisting,
  parent_preexisting_deep_equal: parentPreexistingDeepEqual,
  parent_new_operations: parentNewSorted,
  parent_new_operations_are_only_tag_routes: same(parentNewSorted, expectedNew),
  parent_new_operations_are_only_slice3_routes: same(parentNewSorted, expectedSlice3),
  document_changes: documentChanges,
  preserved_operations: preserved,
  slice1_operations: slice1Present,
  added_operations: added,
  slice3_operations: slice3Present,
  breaking,
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
