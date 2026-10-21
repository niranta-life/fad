import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../');
const document = parse(readFileSync(resolve(root, 'contracts/openapi.yaml'), 'utf8'));
const schemas = document.components.schemas;

function typeOf(schema, name) {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map((item) => JSON.stringify(item)).join(' | ');
  if (schema.type === 'string') return 'string';
  if (schema.type === 'integer' || schema.type === 'number') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.$ref) return schema.$ref.split('/').pop();
  if (schema.type === 'object') return name;
  return 'unknown';
}

const blocks = [
  '/* Generated from contracts/openapi.yaml by packages/contract/scripts/generate.mjs. Do not edit. */',
  '',
];
for (const [name, schema] of Object.entries(schemas)) {
  if (schema.type !== 'object') continue;
  const required = new Set(schema.required ?? []);
  const extra = schema.additionalProperties === true ? '  [key: string]: unknown;\n' : '';
  const fields = Object.entries(schema.properties ?? {}).map(([key, value]) => {
    const optional = required.has(key) ? '' : '?';
    const typeName = value.$ref ? value.$ref.split('/').pop() : typeOf(value, key);
    return `  ${key}${optional}: ${typeName};`;
  });
  blocks.push(`export interface ${name} {`);
  if (extra) blocks.push(extra.trimEnd());
  blocks.push(...fields);
  blocks.push('}');
  blocks.push('');
}
writeFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/generated.ts'), `${blocks.join('\n')}\n`);
