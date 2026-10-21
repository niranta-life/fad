#!/usr/bin/env python3
"""Static baseline compatibility: verifies exact Slices 0-2 path/component structures.
Does not prove runtime conformance. Requires PyYAML and mounted adjacent slice-2.
"""
import sys,json,hashlib
from pathlib import Path
try:
 import yaml
except ImportError:
 sys.exit('pip install PyYAML')
HERE=Path(__file__).resolve().parents[1]
OLD=HERE.parent/'fad-slice-2/contracts/openapi.yaml'
NEW=HERE/'contracts/openapi.yaml'
if not OLD.exists(): sys.exit('Place adjacent fad-slice-2/contracts/openapi.yaml for baseline comparison')
old=yaml.safe_load(OLD.read_text()); new=yaml.safe_load(NEW.read_text())
assert str(new['openapi']).startswith('3.1.'), 'OpenAPI version drift'
assert old['security']==new['security'], 'Global security changed'
for path,value in old['paths'].items():
 assert path in new['paths'] and new['paths'][path]==value, f'Existing path modified: {path}'
for category,data in old.get('components',{}).items():
 for name,value in data.items():
  assert name in new['components'].get(category,{}) and new['components'][category][name]==value, f'Existing {category}/{name} changed'
# local JSON ref resolution check
import re
as_text=json.dumps(new)
for component in re.findall(r'"\$ref": "#/components/([^/]+)/([^"/]+)"',as_text):
 cat,name=component
 assert name in new['components'][cat], f'Unresolved $ref {cat}/{name}'
assert len(new['paths'])-len(old['paths'])==7
assert all(new['paths'][k]==old['paths'][k] for k in old['paths'])
print(json.dumps({'result':'PASS_STATIC','old_paths':len(old['paths']),'new_paths':len(new['paths']),'old_sha256':hashlib.sha256(OLD.read_bytes()).hexdigest(),'new_sha256':hashlib.sha256(NEW.read_bytes()).hexdigest()},indent=2))
