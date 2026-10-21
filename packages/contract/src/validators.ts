import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const require = createRequire(import.meta.url);
interface SchemaError {
  instancePath?: string;
  message?: string;
}
interface Validator {
  (data: unknown): boolean;
  errors?: SchemaError[] | null;
}
interface AjvLike {
  compile: (schema: object) => Validator;
}
const Ajv = require('ajv/dist/2020.js') as new (options?: Record<string, unknown>) => AjvLike;
const addFormats = require('ajv-formats') as (ajv: AjvLike) => void;

export interface OpenApiDocument {
  openapi: string;
  paths: Record<string, unknown>;
  components: {
    schemas: Record<string, Record<string, unknown>>;
    responses: Record<string, unknown>;
    securitySchemes: Record<string, Record<string, unknown>>;
  };
}

const STRIP = new Set(['example', 'examples', 'description', 'summary', 'xml', 'discriminator']);
const KEY_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (KEY_MAPS.has(key) && inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
        const map: Record<string, unknown> = {};
        for (const [name, schema] of Object.entries(inner)) map[name] = strip(schema);
        out[key] = map;
        continue;
      }
      if (!STRIP.has(key)) out[key] = strip(inner);
    }
    return out;
  }
  return value;
}

function resolveRef(document: OpenApiDocument, ref: string): unknown {
  if (!ref.startsWith('#/')) throw new Error(`Unsupported ref ${ref}`);
  let current: unknown = document;
  for (const part of ref.slice(2).split('/')) {
    if (current === null || typeof current !== 'object') throw new Error(`Broken ref ${ref}`);
    current = (current as Record<string, unknown>)[part.replaceAll('~1', '/').replaceAll('~0', '~')];
  }
  if (current === undefined) throw new Error(`Broken ref ${ref}`);
  return current;
}

function dereference(document: OpenApiDocument, schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map((item) => dereference(document, item));
  if (schema !== null && typeof schema === 'object') {
    const record = schema as Record<string, unknown>;
    if (typeof record.$ref === 'string') return dereference(document, resolveRef(document, record.$ref));
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) out[key] = dereference(document, value);
    return out;
  }
  return schema;
}

export function openApiPath(): string {
  if (process.env.FAD_OPENAPI_PATH && process.env.FAD_OPENAPI_PATH.length > 0) {
    return process.env.FAD_OPENAPI_PATH;
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../contracts/openapi.yaml');
}

export function loadOpenApi(path = openApiPath()): OpenApiDocument {
  return parse(readFileSync(path, 'utf8')) as OpenApiDocument;
}

export interface CompiledContract {
  document: OpenApiDocument;
  validate(schemaName: string, value: unknown): void;
}

export function compileContract(document = loadOpenApi()): CompiledContract {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validators = new Map<string, ReturnType<typeof ajv.compile>>();
  for (const [name, schema] of Object.entries(document.components.schemas)) {
    const dereferenced = strip(dereference(document, schema));
    validators.set(name, ajv.compile(dereferenced as object));
  }
  return {
    document,
    validate(schemaName: string, value: unknown): void {
      const validator = validators.get(schemaName);
      if (!validator) throw new Error(`Unknown schema ${schemaName}`);
      if (!validator(value)) {
        const detail = (validator.errors ?? []).map((error) => `${error.instancePath} ${error.message}`).join('; ');
        throw new Error(`Response does not match ${schemaName}: ${detail}`);
      }
    },
  };
}

let cached: CompiledContract | undefined;

export function contract(): CompiledContract {
  cached ??= compileContract();
  return cached;
}
