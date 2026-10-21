#!/usr/bin/env python3
"""Static JSON schema samples sanity test. Not a substitute for server tests."""
import yaml,json,jsonschema
from pathlib import Path
x=yaml.safe_load((Path(__file__).resolve().parents[1]/'contracts/openapi.yaml').read_text())
comp=x['components']['schemas']
from referencing import Registry, Resource
# jsonschema resolves local refs in full OpenAPI document using RefResolver (legacy)
resolver=jsonschema.RefResolver.from_schema(x)
examples=[
 ('CapabilityPublish',{'id':'finance.invoice.match','version':'1.0.0','display_name':'Invoice matching','input_schema':{'type':'object'},'output_schema':{'type':'object'}}),
 ('EndpointPut',{'protocol':'a2a','url':'https://ap.internal.example/a2a','auth_scheme':'oauth2','enabled':True}),
 ('BindingPut',{'version':'1.0.0','endpoint_key':'primary'}),
 ('DiscoveryRequest',{'capability':{'id':'finance.invoice.match','version':'1.0.0'},'tags':[{'namespace':'department','key':'name','operator':'eq','value':'finance'}],'protocols':['a2a'],'limit':25}),
]
for schema_name,example in examples:
 jsonschema.Draft202012Validator(comp[schema_name],resolver=resolver).validate(example)
 print('PASS_STATIC schema sample',schema_name)
for invalid in ['Finance.invoice.match','finance','finance.invoice.match!']:
 try: jsonschema.Draft202012Validator(comp['CapabilityId']).validate(invalid)
 except jsonschema.ValidationError:continue
 raise AssertionError(f'Invalid capability ID unexpectedly accepted: {invalid}')
print('PASS_STATIC invalid capability ids')
response=json.loads((Path(__file__).resolve().parents[1]/'examples/discovery-response.json').read_text())
jsonschema.Draft202012Validator(comp['DiscoveryResponse'],resolver=resolver).validate(response)
print('PASS_STATIC example discovery response')
