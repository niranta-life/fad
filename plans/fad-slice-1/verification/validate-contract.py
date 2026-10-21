#!/usr/bin/env python3
"""Static integrity check for the proposed Slice 1 contract; not a full OAS validator."""
from pathlib import Path
import sys
import yaml
root = Path(__file__).resolve().parents[1]
p = root / 'contracts' / 'openapi.yaml'
doc = yaml.safe_load(p.read_text())
assert doc['openapi'].startswith('3.1.'), 'Unexpected OAS version'
assert doc['security'] == [{'ApiKeyAuth': []}]
paths = doc['paths']
expected = {
    ('/v1/agents','post'), ('/v1/agents','get'),
    ('/v1/agents/{agentId}','get'), ('/v1/agents/{agentId}','patch'),
    ('/v1/agents/{agentId}/suspend','post'),
    ('/v1/agents/{agentId}/activate','post'),
    ('/v1/agents/{agentId}/retire','post'),
}
actual = {(path,method) for path,item in paths.items() for method in item if method in ('get','post','patch','put','delete')}
assert actual == expected, (actual, expected)
for path, method in actual:
    operation = paths[path][method]
    assert 'responses' in operation
    if method in ('post','patch'):
        params = paths[path].get('parameters', []) + operation.get('parameters', [])
        refs = {param.get('$ref','') for param in params}
        assert '#/components/parameters/IdempotencyKey' in refs
        if path != '/v1/agents':
            assert '#/components/parameters/IfMatch' in refs

def refs(obj):
    if isinstance(obj, dict):
        for k,v in obj.items():
            if k=='$ref': yield v
            else: yield from refs(v)
    elif isinstance(obj, list):
        for v in obj: yield from refs(v)

for ref in refs(doc):
    assert ref.startswith('#/'), f'External ref not allowed in self-contained contract: {ref}'
    node = doc
    for component in ref[2:].split('/'):
        node = node[component.replace('~1','/').replace('~0','~')]
print('PASS: parsed YAML, 7 exact operations, mutation guards, all local refs resolvable')
print('NOTE: validate with a full OpenAPI 3.1 validator and breaking-change checker in implementation CI')
