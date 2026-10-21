import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { compileContract, loadOpenApi } from '@fad/contract';
import { check } from './support.mjs';

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

function sha(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('OpenAPI, migration identity, and Slice 1 boundary', () => {
  const shipped = 'contracts/openapi.yaml';
  const baseline = 'plans/fad-slice-0/contracts/openapi.yaml';
  check('S0-C01-package', sha(baseline) === SLICE0_SHA256, 'Slice 0 package OpenAPI was edited');
  check('S0-C01-migration', sha('db/migrations/0001_foundation.up.sql') === sha('plans/fad-slice-0/migrations/0001_foundation.up.sql'));
  const document = loadOpenApi();
  const baselineDoc = parse(readFileSync(baseline, 'utf8'));
  check('S0-C01-version', document.openapi.startsWith('3.1.'));
  const slice0Paths = ['/health/live', '/health/ready', '/v1/organizations/current'];
  for (const path of slice0Paths) {
    check(`S0-C01-path-${path}`, document.paths[path] != null);
    for (const method of METHODS) {
      if (baselineDoc.paths[path][method] == null) continue;
      check(
        `S0-C01-op-${method}-${path}`,
        JSON.stringify(document.paths[path][method]) === JSON.stringify(baselineDoc.paths[path][method]),
      );
    }
  }
  for (const section of ['schemas', 'responses', 'headers', 'securitySchemes']) {
    for (const key of Object.keys(baselineDoc.components[section] ?? {})) {
      check(
        `S0-C01-component-${section}-${key}`,
        JSON.stringify(document.components[section][key]) === JSON.stringify(baselineDoc.components[section][key]),
      );
    }
  }
  for (const [method, path] of AGENT_OPERATIONS) {
    check(`S1-C01-${method}-${path}`, document.paths[path]?.[method] != null);
  }
  check('S1-C01-scheme', document.components.securitySchemes.ApiKeyAuth == null);
  const scheme = document.components.securitySchemes.FadApiKey;
  check('S0-C01-header', scheme?.type === 'apiKey' && scheme.in === 'header' && scheme.name === 'X-FAD-API-Key');
  const compiled = compileContract(document);
  const success = document.paths['/v1/organizations/current'].get.responses['200'].content['application/json'].example;
  compiled.validate('OrganizationResponse', success);
  compiled.validate('Liveness', { status: 'ok' });
  compiled.validate('Readiness', { status: 'ready' });
  compiled.validate('HealthUnavailable', { status: 'not_ready' });
  compiled.validate('ErrorResponse', {
    error: { code: 'UNAUTHORIZED', message: 'Invalid or missing API credential.' },
    meta: { request_id: '3b0fb35b-3c4c-489a-90fa-17232c7b8fda', api_version: 'v1' },
  });
  compiled.validate('AgentResponse', {
    data: {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      global_id: 'urn:fad:agent:cccccccc-cccc-4ccc-8ccc-cccccccccccc:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      organization_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      name: 'Accounts Payable Agent',
      description: 'Manages supplier invoice workflow',
      owner_principal_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'active',
      revision: 1,
      created_at: '2026-10-20T20:00:00.000Z',
      updated_at: '2026-10-20T20:00:00.000Z',
      created_by: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      updated_by: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
    meta: { request_id: '3b0fb35b-3c4c-489a-90fa-17232c7b8fda', api_version: 'v1' },
  });
  compiled.validate('AgentListResponse', {
    data: [],
    meta: {
      request_id: '3b0fb35b-3c4c-489a-90fa-17232c7b8fda',
      api_version: 'v1',
      limit: 25,
      next_cursor: null,
    },
  });
  let extraRejected = false;
  try {
    compiled.validate('OrganizationResponse', { ...success, extra: true });
  } catch {
    extraRejected = true;
  }
  check('S0-C01-closed', extraRejected);
  let agentExtraRejected = false;
  try {
    compiled.validate('AgentCreate', { name: 'A', owner_principal_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', organization_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
  } catch {
    agentExtraRejected = true;
  }
  check('S1-C01-closed-create', agentExtraRejected);

  const migration = readFileSync('db/migrations/0001_foundation.up.sql', 'utf8');
  check('S0-C02-unique', migration.includes('CONSTRAINT principals_org_id_unique UNIQUE (organization_id, id)'));
  check('S0-C02-setting', migration.includes("current_setting('fad.org_id',true)"));
  check('S0-C02-function', migration.includes('fad_lookup_api_credential'));
  check('S0-C02-no-select', !migration.includes('GRANT SELECT ON api_credentials TO fad_app'));
  check('S0-C02-status', migration.includes("status IN ('active', 'revoked')"));

  check('S0-C03-operations', slice0Paths.every((path) => document.paths[path] != null));
  const compose = readFileSync('deploy/docker/compose.yaml', 'utf8');
  check('S0-C01-compose-context', compose.includes('context: ../..') && compose.includes('dockerfile: deploy/docker/Dockerfile'));
});
