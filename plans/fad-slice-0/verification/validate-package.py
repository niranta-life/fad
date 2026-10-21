#!/usr/bin/env python3
"""Static contract validation only; NOT a substitute for API/SQL runtime tests."""
import pathlib, sys, json, re
import yaml
from jsonschema import Draft202012Validator
ROOT = pathlib.Path(__file__).resolve().parents[1]
contract = yaml.safe_load((ROOT/'contracts/openapi.yaml').read_text())
assert contract['openapi'].startswith('3.1.'), 'OpenAPI 3.1 required'
assert set(contract['paths']) == {'/health/live','/health/ready','/v1/organizations/current'}
assert contract['components']['securitySchemes']['FadApiKey'] == {
  'type':'apiKey','in':'header','name':'X-FAD-API-Key',
  'description':contract['components']['securitySchemes']['FadApiKey']['description']
}
assert contract['paths']['/health/live']['get']['security'] == []
assert contract['paths']['/health/ready']['get']['security'] == []

def resolve(ref):
    assert ref.startswith('#/'), ref
    cur = contract
    for step in ref[2:].split('/'):
        cur = cur[step.replace('~1','/').replace('~0','~')]
    return cur

def visit(obj):
    if isinstance(obj, dict):
        if '$ref' in obj: resolve(obj['$ref'])
        for x in obj.values(): visit(x)
    elif isinstance(obj,list):
        for x in obj: visit(x)
visit(contract)
components = contract['components']['schemas']

# Unroll schema refs for jsonschema validation.
def convert(schema, seen=None):
    if isinstance(schema,dict):
        if '$ref' in schema:
            return convert(resolve(schema['$ref']))
        return {k:convert(v) for k,v in schema.items()}
    if isinstance(schema,list): return [convert(v) for v in schema]
    return schema

for name in ('OrganizationResponse','ErrorResponse','Readiness','Liveness'):
    schema = convert(components[name]); Draft202012Validator.check_schema(schema)

success=contract['paths']['/v1/organizations/current']['get']['responses']['200']['content']['application/json']['example']
Draft202012Validator(convert(components['OrganizationResponse'])).validate(success)
for resp in contract['components']['responses'].values():
    for med in resp.get('content',{}).values():
        if 'example' in med:
            Draft202012Validator(convert(med['schema'])).validate(med['example'])

ddl=(ROOT/'migrations/0001_foundation.up.sql').read_text()
for table in ['organizations','principals','api_credentials','audit_events','idempotency_records','schema_migrations']:
    assert re.search(r'CREATE TABLE '+table+r'\s*\(',ddl)
for table in ['organizations','principals','api_credentials','audit_events','idempotency_records']:
    assert f'ALTER TABLE {table} FORCE ROW LEVEL SECURITY;' in ddl
assert 'GRANT EXECUTE ON FUNCTION fad_lookup_api_credential(text) TO fad_app;' in ddl
assert 'GRANT SELECT ON api_credentials TO fad_app;' not in ddl
assert 'BEGIN;' not in ddl and 'COMMIT;' not in ddl, 'runner must own migration txn'

compose=yaml.safe_load((ROOT/'deploy/docker/compose.yaml').read_text())
assert 'postgres' in compose['services'] and 'api' in compose['services']
assert compose['services']['api']['environment']['NODE_ENV'] == 'development'

assert 'Slice 1' in (ROOT/'docs/SLICE1_HANDOFF.md').read_text()
print('PASS: OpenAPI YAML / local $refs / representative JSON Schema examples')
print('PASS: core tenant-scoped migration declarations and lookup grants (structural only)')
print('PASS: Docker Compose YAML and intended services (structural only)')
print('PASS: Slice 1 handoff document present')
