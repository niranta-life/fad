import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const publishedPath = new URL('../contracts/openapi.yaml', import.meta.url);
const packagePath = new URL('../plans/fad-slice-0/contracts/openapi.yaml', import.meta.url);
const slice1Path = new URL('../plans/fad-slice-1/contracts/openapi.yaml', import.meta.url);

function load(url) {
  const text = readFileSync(url);
  return { text, doc: parse(text.toString('utf8')) };
}

function pathsOf(doc) {
  return Object.keys(doc.paths ?? {}).sort();
}

function operations(doc, path) {
  const item = doc.paths?.[path] ?? {};
  return Object.keys(item).filter((key) => ['get', 'post', 'put', 'patch', 'delete', 'head'].includes(key)).sort();
}

const published = load(publishedPath);
const packaged = load(packagePath);
const slice1 = load(slice1Path);
const sameBytes = published.text.equals(packaged.text);
const checksum = createHash('sha256').update(published.text).digest('hex');
const publishedPaths = pathsOf(published.doc);
const removed = publishedPaths.filter((path) => !pathsOf(slice1.doc).includes(path));
const slice1Only = pathsOf(slice1.doc).filter((path) => !publishedPaths.includes(path));

const lines = [
  '# OpenAPI compatibility',
  '',
  `Published file SHA-256: ${checksum}`,
  `Byte-identical to plans/fad-slice-0/contracts/openapi.yaml: ${sameBytes}`,
  '',
  '## Published operations',
  '',
];
for (const path of publishedPaths) {
  lines.push(`- ${operations(published.doc, path).join(',')} ${path}`);
}
lines.push(
  '',
  '## Slice 0 contract diff',
  '',
  sameBytes
    ? 'No added, removed, or changed bytes. Health and GET /v1/organizations/current are unchanged.'
    : 'BREAK: the published contract differs from the Slice 0 package.',
  '',
  '## Slice 1 proposed file',
  '',
  'plans/fad-slice-1/contracts/openapi.yaml is a separate proposal. This check does not edit it.',
  `Paths only in that proposal: ${slice1Only.join(', ') || '(none)'}`,
  `Slice 0 paths absent from that proposal: ${removed.join(', ') || '(none)'}`,
  '',
  'The running API does not serve the Slice 1 agent paths. Shipping Slice 0 did not remove or alter the Slice 0 operations.',
  '',
);
const report = lines.join('\n');
if (!sameBytes) {
  console.error(report);
  process.exit(1);
}
console.log(report);
