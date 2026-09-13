"""DataCore field paths, and tolerant lookup over exported records.

Every field name in PLAN.md §3.1 is a *hypothesis* until checked against a real
StarBreaker export. They are collected here, as ordered candidate lists, so that
correcting them is a one-file change rather than a grep across the package.

Each entry is a list of dotted paths tried in order; the first that resolves to
a non-empty value wins. A path segment may be:

* a dict key
* ``[]``  — map over every element of a list and return the first hit
* ``*``   — try every value of a dict at that level

STATUS: UNVERIFIED. See CLAUDE.md -> "Verified facts".
"""

from __future__ import annotations

from typing import Any

MISSING = object()


def _walk(node: Any, segments: list[str]) -> Any:
    if not segments:
        return node
    head, rest = segments[0], segments[1:]

    if head == "[]":
        if not isinstance(node, list):
            return MISSING
        for element in node:
            found = _walk(element, rest)
            if found is not MISSING:
                return found
        return MISSING

    if head == "*":
        if not isinstance(node, dict):
            return MISSING
        for value in node.values():
            found = _walk(value, rest)
            if found is not MISSING:
                return found
        return MISSING

    if isinstance(node, dict):
        if head in node:
            return _walk(node[head], rest)
        # StarBreaker sometimes prefixes attribute names with '@' (CryXML) or
        # exports them lowercased; accept both without a second candidate path.
        for key in (f"@{head}", head.lower(), head[:1].lower() + head[1:]):
            if key in node:
                return _walk(node[key], rest)
        return MISSING

    if isinstance(node, list):
        # Implicit map over a list of components.
        for element in node:
            found = _walk(element, [head, *rest])
            if found is not MISSING:
                return found
        return MISSING

    return MISSING


def get(record: Any, path: str) -> Any:
    """Resolve one dotted path. Returns MISSING when absent."""
    return _walk(record, path.split("."))


def first(record: Any, paths: list[str], default: Any = None) -> Any:
    """Return the first of ``paths`` that resolves to a non-empty value."""
    for path in paths:
        value = get(record, path)
        if value is MISSING or value is None:
            continue
        if isinstance(value, str) and not value.strip():
            continue
        if isinstance(value, (list, dict)) and not value:
            continue
        return value
    return default


def collect(record: Any, paths: list[str]) -> list[Any]:
    """Return every non-empty resolution across ``paths`` (deduped, ordered)."""
    out: list[Any] = []
    for path in paths:
        value = get(record, path)
        if value is MISSING or value is None or value == "" or value == []:
            continue
        if value not in out:
            out.append(value)
    return out


# ---------------------------------------------------------------------------
# Record shape
# ---------------------------------------------------------------------------
# VERIFIED against a real export (sc-alpha-4.10.0, build 1.0.191.55227).
#
# A StarBreaker JSON record looks like:
#
#   {"_RecordName_": "EntityClassDefinition.cds_combat_light_helmet_02_02_01",
#    "_RecordId_":   "<guid>",
#    "_RecordTag_":  "Character",
#    "_RecordValue_": {"_Type_": "EntityClassDefinition",
#                      "Components": [ {"_Type_": "SAttachableComponentParams", ...},
#                                      {"_Type_": "SGeometryResourceParams", ...}, ... ]}}
#
# Components is a LIST whose members carry their type in "_Type_", not a dict
# keyed by type name. Look them up with :func:`component`, never by dotted path.

RECORD_NAME = "_RecordName_"
RECORD_ID = "_RecordId_"
RECORD_VALUE = "_RecordValue_"
RECORD_TAG = "_RecordTag_"
TYPE = "_Type_"


def record_body(record: Any) -> dict:
    """The record payload, tolerating both wrapped and already-unwrapped input."""
    if isinstance(record, dict):
        body = record.get(RECORD_VALUE)
        if isinstance(body, dict):
            return body
        return record
    return {}


def components(record: Any) -> list[dict]:
    body = record_body(record)
    found = body.get("Components")
    if isinstance(found, list):
        return [c for c in found if isinstance(c, dict)]
    if isinstance(found, dict):
        # Defensive: an exporter that keys components by type name.
        return [
            {TYPE: name, **value} for name, value in found.items() if isinstance(value, dict)
        ]
    return []


def component(record: Any, type_name: str) -> dict | None:
    """Return the component with ``_Type_ == type_name``, or None."""
    for entry in components(record):
        if entry.get(TYPE) == type_name:
            return entry
    return None


def class_name_of(record: Any) -> str | None:
    """``EntityClassDefinition.foo_bar`` -> ``foo_bar``."""
    name = record.get(RECORD_NAME) if isinstance(record, dict) else None
    if not isinstance(name, str) or not name:
        return None
    return name.split(".", 1)[1] if "." in name else name


def record_type_of(record: Any) -> str | None:
    name = record.get(RECORD_NAME) if isinstance(record, dict) else None
    if isinstance(name, str) and "." in name:
        return name.split(".", 1)[0]
    body = record_body(record)
    value = body.get(TYPE)
    return value if isinstance(value, str) else None


# ---------------------------------------------------------------------------
# Component field paths (relative to the component dict)
# ---------------------------------------------------------------------------

ATTACHABLE = "SAttachableComponentParams"
GEOMETRY_COMPONENT = "SGeometryResourceParams"
CLOTHING = "SCItemClothingParams"
SUIT_ARMOR = "SCItemSuitArmorParams"
TAGS_COMPONENT = "STagsComponentParams"

ATTACH_TYPE = ["AttachDef.Type", "AttachDef.type"]
ATTACH_SUBTYPE = ["AttachDef.SubType"]
ATTACH_SIZE = ["AttachDef.Size"]
MANUFACTURER_REF = ["AttachDef.Manufacturer"]
NAME_KEY = ["AttachDef.Localization.Name"]
DESCRIPTION_KEY = ["AttachDef.Localization.Description"]
TAGS = ["AttachDef.Tags", "tags", "Tags"]

# Inside SGeometryResourceParams, the tree root is `Geometry`; each node has
# `Geometry.Geometry.path` plus `Geometry.Material.path`, and children in
# `SubGeometry`. See :func:`sc_extract.catalog.walk_geometry`.
GEOMETRY_ROOT = "Geometry"
NODE_PATH = ["Geometry.Geometry.path", "Geometry.path"]
NODE_MATERIAL = ["Geometry.Material.path", "Material.path"]
NODE_CHILDREN = "SubGeometry"
NODE_PALETTE = ["Geometry.Palette.RootRecord", "Palette.RootRecord"]

CLOTHING_STAT_KEYS = (
    "TemperatureResistance",
    "RadiationResistance",
    "Flight",
    "Chunks",
)

# Values of ATTACH_TYPE that mark an item as wearable FPS armor.
# HYPOTHESIS — confirm against the real export before trusting the slot counts.
ARMOR_ATTACH_TYPES = {
    "Char_Armor_Helmet": "helmet",
    "Char_Armor_Torso": "torso",
    "Char_Armor_Arms": "arms",
    "Char_Armor_Legs": "legs",
    "Char_Armor_Backpack": "backpack",
    "Char_Armor_Undersuit": "undersuit",
}

# Fallback slot inference when AttachDef.Type is absent or unrecognised: match
# these substrings against the class name, most specific first.
SLOT_NAME_HINTS: list[tuple[str, str]] = [
    ("undersuit", "undersuit"),
    ("backpack", "backpack"),
    ("_bag", "backpack"),
    ("helmet", "helmet"),
    ("_hel_", "helmet"),
    ("torso", "torso"),
    ("_tor_", "torso"),
    ("core", "torso"),  # VERIFIED: CIG calls the torso slot "core"
    ("chest", "torso"),
    ("arms", "arms"),
    ("_arm", "arms"),
    ("legs", "legs"),
    ("_leg", "legs"),
]

# Longest first: "superheavy" must not be matched as "heavy".
WEIGHT_CLASS_HINTS: list[tuple[str, str]] = [
    ("superheavy", "superheavy"),
    ("heavy", "heavy"),
    ("medium", "medium"),
    ("light", "light"),
]
