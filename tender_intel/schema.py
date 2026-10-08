"""Compile a tender type from the YAML packs into its ordered sections and fields.

Ported from Ergplan/tender_engine tender/services/packs.py compile_type (commit bd4959c),
simplified: no released-version signatures, no schema registry, no document roles. The
core pack (packs/core/common.yaml) holds the fields every tender has, the power pack
(packs/power/pack.yaml) the power fields every type shares, and one YAML per tender type
names the sections it includes and adds its own. packs/overlay.yaml holds FDRE-side
additions; an overlay field joins its section in every type that includes the section.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

PACKS_ROOT = Path(__file__).resolve().parent / "packs"
CORE_FILE = PACKS_ROOT / "core" / "common.yaml"
POWER_DIR = PACKS_ROOT / "power"
OVERLAY_FILE = PACKS_ROOT / "overlay.yaml"
DEFAULT_PROMPT_VERSION = "v1"
_PATH = re.compile(r"^[a-z0-9_]+(\.[a-z0-9_]+)+$")
_KEY = re.compile(r"^[a-z0-9_]+$")
# Run rules that need no database: every number of a structured value must be printed in
# that field's own quotes (core/structured.py, made stateless).
RUN_RULES = ("structured_numbers_quoted",)


class PackError(ValueError):
    """A pack file is malformed, or two definitions conflict."""


@dataclass(frozen=True)
class KeySpec:
    """One typed key of a record field; `keys` makes it a list of sub-records (its type
    is then "list")."""

    name: str
    label: str
    type: str
    unit: str | None = None
    enum: list[str] | None = None
    min: float | None = None
    max: float | None = None
    keys: list["KeySpec"] | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class FieldSpec:
    path: str
    key: str
    section: str
    label: str
    type: str
    unit: str | None = None
    required: bool = False
    help: str = ""
    enum: list[str] | None = None
    min: float | None = None
    max: float | None = None
    keys: list[KeySpec] | None = None
    item_keys: list[str] | None = None
    source: str = "tender_engine"

    def to_dict(self) -> dict[str, Any]:
        out = asdict(self)
        out.pop("section")
        return out


@dataclass(frozen=True)
class SectionSpec:
    name: str
    label: str
    prompt: str
    prompt_version: str
    max_pages: int | None
    keywords: list[str]
    section_kinds: list[str]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class TenderSchema:
    tender_type: str
    version: str
    sections: list[SectionSpec]
    fields: list[FieldSpec]
    cross_field_rules: list[str]
    run_rules: list[str] = field(default_factory=lambda: list(RUN_RULES))

    def fields_in(self, section: str) -> list[FieldSpec]:
        return [f for f in self.fields if f.section == section]

    def field(self, path: str) -> FieldSpec:
        for spec in self.fields:
            if spec.path == path:
                return spec
        raise KeyError(path)

    @property
    def paths(self) -> list[str]:
        return [f.path for f in self.fields]


def _load(path: Path) -> dict[str, Any]:
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception as exc:  # noqa: BLE001
        raise PackError(f"{path}: {exc}") from exc
    if not isinstance(data, dict):
        raise PackError(f"{path}: expected a mapping")
    return data


def _key_spec(name: str, raw: dict[str, Any]) -> KeySpec:
    if not _KEY.match(name):
        raise PackError(f"invalid key name {name!r}")
    subs = raw.get("keys")
    return KeySpec(
        name=name,
        label=raw.get("label") or name.replace("_", " ").capitalize(),
        type="list" if subs else raw.get("type", "text"),
        unit=raw.get("unit"),
        enum=list(raw["enum"]) if raw.get("enum") else None,
        min=raw.get("min"),
        max=raw.get("max"),
        keys=[_key_spec(sub, spec) for sub, spec in subs.items()] if subs else None,
    )


def _field_spec(path: str, raw: dict[str, Any], section: str, required: bool, source: str) -> FieldSpec:
    if not _PATH.match(path):
        raise PackError(f"invalid field path {path!r}")
    value_type = raw.get("type")
    if not value_type:
        raise PackError(f"{path}: no type")
    if value_type == "enum" and not raw.get("enum"):
        raise PackError(f"{path}: an enum without values")
    keys = raw.get("keys")
    return FieldSpec(
        path=path,
        key=path.rsplit(".", 1)[1],
        section=section,
        label=raw.get("label") or path.rsplit(".", 1)[1],
        type=value_type,
        unit=raw.get("unit"),
        required=bool(raw.get("required")) or required,
        help=raw.get("help", "") or "",
        enum=list(raw["enum"]) if raw.get("enum") else None,
        min=raw.get("min"),
        max=raw.get("max"),
        keys=[_key_spec(name, spec) for name, spec in keys.items()] if keys else None,
        item_keys=list(raw["item_keys"]) if raw.get("item_keys") else None,
        source=source,
    )


def _type_file(tender_type: str, seen: tuple[str, ...] = ()) -> dict[str, Any]:
    """A type file with the types it inherits folded in (packs.py _type_file)."""
    if tender_type in seen:
        raise PackError(f"type {tender_type!r} inherits itself")
    path = POWER_DIR / f"{tender_type}.yaml"
    if not path.is_file():
        raise PackError(f"no type file for {tender_type!r}")
    raw = _load(path)
    if raw.get("type") != tender_type:
        raise PackError(f"{path}: `type` must be {tender_type!r}")
    merged: dict[str, Any] = {
        "sections": {},
        "fields": {},
        "includes": [],
        "required": [],
        "excludes": [],
        "cross_field_rules": [],
    }
    for parent in [*raw.get("inherits", []), None]:
        source = _type_file(parent, (*seen, tender_type)) if parent else raw
        for name, value in (source.get("sections") or {}).items():
            if name in merged["sections"] and merged["sections"][name] != value:
                raise PackError(f"{path}: conflicting definitions of section {name!r}")
            merged["sections"].setdefault(name, value)
        for name, value in (source.get("fields") or {}).items():
            if name in merged["fields"] and merged["fields"][name] != value:
                raise PackError(f"{path}: conflicting definitions of field {name!r}")
            merged["fields"].setdefault(name, value)
        for listed in ("includes", "required", "excludes", "cross_field_rules"):
            merged[listed] += [n for n in source.get(listed, []) or [] if n not in merged[listed]]
    return merged


@lru_cache(maxsize=1)
def _power_pack() -> dict[str, Any]:
    return _load(POWER_DIR / "pack.yaml")


def _tender_types() -> list[str]:
    return [name for name in _power_pack().get("subdomains", []) if (POWER_DIR / f"{name}.yaml").is_file()]


TENDER_TYPES: list[str] = _tender_types()


@lru_cache(maxsize=32)
def compile_type(tender_type: str) -> TenderSchema:
    """Resolve one tender type against the core pack, the power pack and the overlay."""
    if tender_type not in TENDER_TYPES:
        raise LookupError(f"unknown tender type {tender_type!r}; one of {TENDER_TYPES}")
    core, pack, own, overlay = _load(CORE_FILE), _power_pack(), _type_file(tender_type), _load(OVERLAY_FILE)

    sections: dict[str, dict[str, Any]] = {}
    for raw in (core, pack, own):
        for name, section in (raw.get("sections") or {}).items():
            if name in sections:
                raise PackError(f"section {name!r} is defined twice")
            sections[name] = section
    missing = [name for name in own["includes"] if name not in sections]
    if missing:
        raise PackError(f"{tender_type!r} includes unknown section(s) {missing}")
    included = [*own["includes"], *(name for name in own["sections"] if name not in own["includes"])]

    sources = (
        (core, "tender_engine"),
        (pack, "tender_engine"),
        (own, "tender_engine"),
        (overlay, "fdre_overlay"),
    )
    fields: list[FieldSpec] = []
    seen: set[str] = set()
    for section_name in included:
        for raw, source in sources:
            for path, spec in (raw.get("fields") or {}).items():
                if spec.get("section") != section_name:
                    continue
                if path in own["excludes"] and raw is not own:
                    continue
                if path in seen:
                    raise PackError(f"field {path!r} is defined twice")
                seen.add(path)
                fields.append(_field_spec(path, spec, section_name, path in own["required"], source))
    for raw, _ in sources[:3]:
        stray = sorted({f.get("section") for f in (raw.get("fields") or {}).values()} - set(sections))
        if stray:
            raise PackError(f"field(s) name unknown section(s) {stray}")
    for section_name in included:
        keys = [f.key for f in fields if f.section == section_name]
        if len(set(keys)) != len(keys):
            raise PackError(f"section {section_name!r} has two fields with the same key")

    compiled_sections = [
        SectionSpec(
            name=name,
            label=sections[name].get("label", name),
            prompt=sections[name].get("prompt", "extract"),
            prompt_version=sections[name].get("prompt_version") or DEFAULT_PROMPT_VERSION,
            max_pages=sections[name].get("max_pages"),
            keywords=list(sections[name].get("keywords") or []),
            section_kinds=list(sections[name].get("section_kinds") or []),
        )
        for name in included
        if any(f.section == name for f in fields)
    ]
    rules = list(
        dict.fromkeys(
            [
                *(core.get("cross_field_rules") or []),
                *(pack.get("cross_field_rules") or []),
                *own["cross_field_rules"],
            ]
        )
    )
    return TenderSchema(
        tender_type=tender_type,
        version=str(pack.get("version") or "v1"),
        sections=compiled_sections,
        fields=fields,
        cross_field_rules=rules,
    )


def catalog(tender_type: str) -> dict[str, Any]:
    """The compiled type as JSON for the API: its sections, each with its fields."""
    schema = compile_type(tender_type)
    return {
        "tender_type": schema.tender_type,
        "schema_version": schema.version,
        "types": list(TENDER_TYPES),
        "sections": [
            {**section.to_dict(), "fields": [f.to_dict() for f in schema.fields_in(section.name)]}
            for section in schema.sections
        ],
        "cross_field_rules": list(schema.cross_field_rules),
        "run_rules": list(schema.run_rules),
        "field_count": len(schema.fields),
    }
