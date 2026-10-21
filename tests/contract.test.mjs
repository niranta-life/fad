import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { compileContract, loadOpenApi } from '@fad/contract';
import { check } from './support.mjs';

function sha(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

test('OpenAPI, migration identity, and Slice 1 boundary', () => {
  const shipped = 'contracts/openapi.yaml';
  const baseline = 'plans/fad-slice-0/contracts/openapi.yaml';
  check('S0-C01-bytes', sha(shipped) === sha(baseline), 'shipped OpenAPI drifted from the package');
  check('S0-C01-migration', sha('db/migrations/0001_foundation.up.sql') === sha('plans/fad-slice-0/migrations/0001_foundation.up.sql'));
  const document = loadOpenApi();
  check('S0-C01-version', document.openapi.startsWith('3.1.'));
  check('S0-C01-paths', JSON.stringify(Object.keys(document.paths).sort()) === JSON.stringify(['/health/live', '/health/ready', '/v1/organizations/current']));
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
  let extraRejected = false;
  try {
    compiled.validate('OrganizationResponse', { ...success, extra: true });
  } catch {
    extraRejected = true;
  }
  check('S0-C01-closed', extraRejected);
  check('S0-C03-identical', sha(shipped) === sha(baseline));

  const migration = readFileSync('db/migrations/0001_foundation.up.sql', 'utf8');
  check('S0-C02-unique', migration.includes('CONSTRAINT principals_org_id_unique UNIQUE (organization_id, id)'));
  check('S0-C02-setting', migration.includes("current_setting('fad.org_id',true)"));
  check('S0-C02-function', migration.includes('fad_lookup_api_credential'));
  check('S0-C02-no-select', !migration.includes('GRANT SELECT ON api_credentials TO fad_app'));
  check('S0-C02-status', migration.includes("status IN ('active', 'revoked')"));

  const source = walk('apps').concat(walk('packages')).filter((path) => path.endsWith('.ts') || path.endsWith('.mjs') || path.endsWith('.js'));
  const hits = source.filter((path) => /\/v1\/agents\b|agents\.register/.test(readFileSync(path, 'utf8')));
  check('S0-C02-no-agent-routes', hits.length === 0, hits.join(','));
  const compose = readFileSync('deploy/docker/compose.yaml', 'utf8');
  check('S0-C01-compose-context', compose.includes('context: ../..') && compose.includes('dockerfile: deploy/docker/Dockerfile'));
});
