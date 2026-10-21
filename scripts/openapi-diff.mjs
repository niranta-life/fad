import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const publishedPath = new URL('../contracts/openapi.yaml', import.meta.url);
const packagePath = new URL('../plans/fad-slice-0/contracts/openapi.yaml', import.meta.url);
const SLICE0_SHA256 = 'bb5a6dc96ae93fb42ed6b69af1770cd435bba43809c8942b0702d9a748beb4cc';
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

const added = [];
for (const [method, path] of AGENT_OPERATIONS) {
  if (published.doc.paths?.[path]?.[method] == null) breaking.push(`missing ${method} ${path}`);
  else added.push(`${method} ${path}`);
}

const preserved = [];
for (const path of slice0Paths) {
  for (const method of operations(packaged.doc, path)) preserved.push(`${method} ${path}`);
}

const report = {
  ok: breaking.length === 0,
  slice0_package_sha256: packageSha,
  slice0_package_unchanged: packageSha === SLICE0_SHA256,
  published_sha256: publishedSha,
  preserved_operations: preserved,
  added_operations: added,
  breaking,
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
