"""Checks every JSON file in pbip/ against the Microsoft schema its "$schema" names.

Run after build.mjs, with a local copy of github.com/microsoft/json-schemas:
    git clone --depth 1 https://github.com/microsoft/json-schemas.git ../json-schemas
    python -I powerplatform/powerbi/validate.py ../json-schemas
Needs the jsonschema package (pip install jsonschema). Exits 1 if any file fails or names no schema.
"""
import json
import sys
from pathlib import Path

from jsonschema import Draft7Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT7

BASE = "https://developer.microsoft.com/json-schemas/"
schemas_root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("../json-schemas")
pbip = Path(__file__).resolve().parent / "pbip"

# Each schema is registered under its path on the site and under its own $id (some differ, e.g. schema.embedded.json),
# so relative and in-document references both resolve.
resources = []
for path in (schemas_root / "fabric").rglob("*.json"):
    doc = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(doc, dict):
        continue
    res = Resource.from_contents(doc, default_specification=DRAFT7)
    url = BASE + path.relative_to(schemas_root).as_posix()
    resources.append((url, res))
    if isinstance(doc.get("$id"), str) and doc["$id"] != url:
        resources.append((doc["$id"], res))
registry = Registry().with_resources(resources)

failures = 0
files = sorted(p for p in pbip.rglob("*") if p.is_file() and (p.suffix in (".json", ".pbir", ".pbism", ".pbip") or p.name == ".platform"))
for path in files:
    if "BaseThemes" in path.parts:
        continue  # Microsoft's own theme file, copied unchanged
    doc = json.loads(path.read_text(encoding="utf-8"))
    ref = doc.get("$schema")
    rel = path.relative_to(pbip).as_posix()
    if not ref:
        print(f"NO SCHEMA {rel}")
        failures += 1
        continue
    schema = registry.contents(ref)
    errors = sorted(Draft7Validator(schema, registry=registry).iter_errors(doc), key=lambda e: list(e.path))
    for e in errors[:5]:
        print(f"FAIL {rel}: {'/'.join(map(str, e.path))}: {e.message[:300]}")
    failures += bool(errors)

print(f"{len(files)} files checked, {failures} failed")
sys.exit(1 if failures else 0)
