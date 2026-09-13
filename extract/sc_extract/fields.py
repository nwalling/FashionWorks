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
# Candidate paths
# ---------------------------------------------------------------------------

COMPONENTS = "Components"

ATTACH_TYPE = [
    "Components.SAttachableComponentParams.AttachDef.Type",
    "SAttachableComponentParams.AttachDef.Type",
    "Components.[].SAttachableComponentParams.AttachDef.Type",
    "AttachDef.Type",
]

ATTACH_SUBTYPE = [
    "Components.SAttachableComponentParams.AttachDef.SubType",
    "SAttachableComponentParams.AttachDef.SubType",
    "Components.[].SAttachableComponentParams.AttachDef.SubType",
    "AttachDef.SubType",
]

ATTACH_SIZE = [
    "Components.SAttachableComponentParams.AttachDef.Size",
    "SAttachableComponentParams.AttachDef.Size",
    "Components.[].SAttachableComponentParams.AttachDef.Size",
]

MANUFACTURER_REF = [
    "Components.SAttachableComponentParams.AttachDef.Manufacturer",
    "SAttachableComponentParams.AttachDef.Manufacturer",
    "Components.[].SAttachableComponentParams.AttachDef.Manufacturer",
    "Manufacturer",
]

NAME_KEY = [
    "Components.SAttachableComponentParams.AttachDef.Localization.Name",
    "SAttachableComponentParams.AttachDef.Localization.Name",
    "Components.[].SAttachableComponentParams.AttachDef.Localization.Name",
    "Localization.Name",
]

DESCRIPTION_KEY = [
    "Components.SAttachableComponentParams.AttachDef.Localization.Description",
    "SAttachableComponentParams.AttachDef.Localization.Description",
    "Components.[].SAttachableComponentParams.AttachDef.Localization.Description",
    "Localization.Description",
]

# The nesting depth of Geometry is the single most uncertain field in the plan.
# List every plausible depth; the spike prunes this to the one that is real.
GEOMETRY_PATH = [
    "Components.SGeometryResourceParams.Geometry.Geometry.Geometry.path",
    "Components.SGeometryResourceParams.Geometry.Geometry.path",
    "Components.SGeometryResourceParams.Geometry.path",
    "SGeometryResourceParams.Geometry.Geometry.Geometry.path",
    "SGeometryResourceParams.Geometry.Geometry.path",
    "SGeometryResourceParams.Geometry.path",
    "Components.[].SGeometryResourceParams.Geometry.Geometry.Geometry.path",
    "Components.[].SGeometryResourceParams.Geometry.Geometry.path",
]

# Sub-geometry lists (L/R limb pairs, visor sub-meshes).
SUB_GEOMETRY = [
    "Components.SGeometryResourceParams.Geometry.Geometry.SubGeometry",
    "Components.SGeometryResourceParams.Geometry.SubGeometry",
    "SGeometryResourceParams.Geometry.Geometry.SubGeometry",
]

TINT_PALETTE = [
    "Components.SGeometryResourceParams.Geometry.Geometry.Geometry.Tint",
    "Components.SGeometryResourceParams.Geometry.Geometry.Tint",
    "Components.SGeometryResourceParams.Palette",
    "SGeometryResourceParams.Geometry.Geometry.Geometry.Tint",
]

MATERIAL_PATH = [
    "Components.SGeometryResourceParams.Geometry.Geometry.Material.path",
    "Components.SGeometryResourceParams.Geometry.Material.path",
    "SGeometryResourceParams.Geometry.Geometry.Material.path",
]

ARMOR_PARAMS = [
    "Components.SCItemClothingParams",
    "Components.SCItemArmorParams",
    "SCItemClothingParams",
    "SCItemArmorParams",
]

TAGS = [
    "Components.STagsComponentParams.tags",
    "Components.SAttachableComponentParams.AttachDef.Tags",
    "tags",
    "Tags",
]

CLASS_NAME = ["ClassName", "className", "__class", "Name", "name"]

RECORD_ID = ["__ref", "Reference", "reference", "id", "GUID", "guid"]

RECORD_TYPE = ["__type", "__polymorphicType", "type", "Type"]

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
    ("core", "torso"),
    ("chest", "torso"),
    ("arms", "arms"),
    ("_arm", "arms"),
    ("legs", "legs"),
    ("_leg", "legs"),
]

WEIGHT_CLASS_HINTS: list[tuple[str, str]] = [
    ("heavy", "heavy"),
    ("medium", "medium"),
    ("light", "light"),
]
