#!/usr/bin/env python3
"""Static contract guard. Runtime API/DB tests are STILL required."""
from pathlib import Path
import yaml
from jsonschema import Draft202012Validator

root=Path(__file__).resolve().parents[1]
s0=yaml.safe_load((root/'contracts/baselines/slice0.yaml').read_text())
s1=yaml.safe_load((root/'contracts/baselines/slice1.yaml').read_text())
s2=yaml.safe_load((root/'contracts/openapi.yaml').read_text())
assert s2['openapi']=='3.1.0'

def check_refs(n):
  if isinstance(n,dict):
    for k,v in n.items():
      if k=='$ref':
        assert v.startswith('#/'),v
        target=s2
        for segment in v[2:].split('/'):
          target=target[segment.replace('~1','/').replace('~0','~')]
      else:check_refs(v)
  elif isinstance(n,list):
    for x in n:check_refs(x)
check_refs(s2)
# Previously published Slice 1 components and paths remain EXACTLY unchanged.
for path,old in s1['paths'].items():assert s2['paths'][path]==old,path
for category,entries in s1['components'].items():
  for name,old in entries.items(): assert s2['components'][category][name]==old,(category,name)

# Slice 0 path ref changes may only be internal namespace renames to avoid collisions.
collisions={cat:set(s0['components'].get(cat,{})) & set(s1['components'].get(cat,{})) for cat in s0['components']}
def rewrite_refs(n):
  if isinstance(n,dict):
    out={}
    for k,v in n.items():
      if k=='$ref' and isinstance(v,str) and v.startswith('#/components/'):
        parts=v.split('/')
        if len(parts)==4 and parts[3] in collisions.get(parts[2],set()):v=f'#/components/{parts[2]}/Foundation{parts[3]}'
        out[k]=v
      else:out[k]=rewrite_refs(v)
    return out
  if isinstance(n,list):return [rewrite_refs(x) for x in n]
  return n
for path,old in s0['paths'].items():assert s2['paths'][path]==rewrite_refs(old),path
for cat,entries in s0['components'].items():
  for name,val in entries.items():
    dst=('Foundation'+name) if name in collisions.get(cat,set()) else name
    assert s2['components'][cat][dst] == rewrite_refs(val), (cat,name)

# Validate new JSON Schemas per OpenAPI 3.1 / JSON Schema 2020-12.
for name in ['TagScalar','TagAssignmentPut','TagAssignment','TagDefinition','TagDefinitionCreate','TagPredicate','AgentTagSearch']:
  Draft202012Validator.check_schema(s2['components']['schemas'][name])
for path in ['/v1/tag-definitions','/v1/tag-definitions/{namespace}/{key}','/v1/agents/{agentId}/tags','/v1/agents/{agentId}/tags/{namespace}/{key}','/v1/agents/search']:
  assert path in s2['paths']
assert '422' in s2['paths']['/v1/agents/{agentId}/tags/{namespace}/{key}']['delete']['responses']
print('PASS: OpenAPI YAML, local refs, example schemas, Slice 0+1 unchanged contracts, Slice 2 routes.')
