"""Catalog construction: DataCore records -> manifest (PLAN.md §3).

Filtering, slot normalization, set grouping and variant linking. Pure functions
over already-loaded records, so it is testable against JSON fixtures without a
game install.
"""

from __future__ import annotations

import logging
import re
from collections import defaultdict
from dataclasses import dataclass
from typing import Any

from . import fields as F
from .dcb import Index, Record
from .localization import Localization
from .manifest import Assets, Geometry, Item, Manifest, Manufacturer

log = logging.getLogger(__name__)

# Sub-slots kept as metadata but never used as the slot enum (PLAN.md §3.3).
SUB_SLOT_HINTS: list[tuple[str, str]] = [
    ("shoulder", "shoulders"),
    ("chest", "chest_plate"),
    ("_l_", "left"),
    ("_r_", "right"),
    ("_left", "left"),
    ("_right", "right"),
]

TEST_PATTERNS = re.compile(r"(^|_)(test|debug|placeholder|template|wip|dev)(_|$)", re.IGNORECASE)
NPC_PATTERNS = re.compile(r"(^|_)(npc|ai|crew_ai)(_|$)", re.IGNORECASE)


@dataclass
class CatalogStats:
    considered: int = 0
    matched: int = 0
    skipped_no_slot: int = 0
    unresolved_names: int = 0

    def as_dict(self) -> dict[str, int]:
        return {
            "considered": self.considered,
            "matched": self.matched,
            "skipped_no_slot": self.skipped_no_slot,
            "unresolved_names": self.unresolved_names,
        }


# ---------------------------------------------------------------------------
# Field derivation
# ---------------------------------------------------------------------------


def slot_for(record: Record) -> str | None:
    """Map a record to one of the six slots, or None if it is not armor.

    Prefers ``AttachDef.Type``; falls back to class-name hints so a renamed
    attach type does not silently empty the catalog.
    """
    attach_type = record.get(F.ATTACH_TYPE)
    if isinstance(attach_type, str):
        direct = F.ARMOR_ATTACH_TYPES.get(attach_type)
        if direct:
            return direct
        # Accept an unseen Char_Armor_* member by its suffix.
        if attach_type.lower().startswith("char_armor_"):
            suffix = attach_type.split("_")[-1].lower()
            for slot in ("helmet", "torso", "arms", "legs", "backpack", "undersuit"):
                if suffix.startswith(slot[:4]):
                    return slot

    name = record.class_name.lower()
    for needle, slot in F.SLOT_NAME_HINTS:
        if needle in name:
            return slot
    return None


def sub_slot_for(record: Record, slot: str) -> str | None:
    subtype = record.get(F.ATTACH_SUBTYPE)
    if isinstance(subtype, str) and subtype:
        cleaned = subtype.split("_")[-1].lower()
        if cleaned and cleaned != slot:
            return cleaned
    name = record.class_name.lower()
    for needle, value in SUB_SLOT_HINTS:
        if needle in name:
            return value
    return None


def weight_class_for(record: Record) -> str | None:
    haystack = " ".join(
        str(v).lower()
        for v in (record.class_name, record.get(F.ATTACH_SUBTYPE), record.get(F.ATTACH_SIZE))
        if v
    )
    for needle, value in F.WEIGHT_CLASS_HINTS:
        if needle in haystack:
            return value
    return None


def manufacturer_for(record: Record, index: Index) -> Manufacturer:
    ref = record.get(F.MANUFACTURER_REF)
    resolved = index.resolve_ref(ref)
    if resolved is None:
        if isinstance(ref, str) and ref and not _is_null_guid(ref):
            return Manufacturer(code=ref[:16], name="")
        return Manufacturer()
    code = F.first(resolved.data, ["Code", "code", "ShortName"], "") or ""
    name = F.first(resolved.data, ["Name", "name", "Localization.Name"], "") or ""
    return Manufacturer(code=str(code), name=str(name))


def _is_null_guid(value: str) -> bool:
    return set(value.strip("{}")) <= {"0", "-"}


def geometry_for(record: Record) -> list[Geometry]:
    """Collect geometry paths, one entry per mesh, with a side when paired."""
    out: list[Geometry] = []

    primary = record.get(F.GEOMETRY_PATH)
    if isinstance(primary, str) and primary:
        out.append(Geometry(source=_normalize_asset_path(primary), side=_side_of(primary)))

    subs = record.get(F.SUB_GEOMETRY)
    for entry in subs if isinstance(subs, list) else []:
        path = F.first(entry, ["Geometry.path", "path", "Geometry.Geometry.path"])
        if isinstance(path, str) and path:
            normalized = _normalize_asset_path(path)
            if all(g.source != normalized for g in out):
                out.append(Geometry(source=normalized, side=_side_of(path)))
    return out


def _side_of(path: str) -> str | None:
    stem = path.replace("\\", "/").rsplit("/", 1)[-1].lower()
    if re.search(r"(^|[_-])(l|lt|left)([_.-]|$)", stem):
        return "left"
    if re.search(r"(^|[_-])(r|rt|right)([_.-]|$)", stem):
        return "right"
    return None


_SEPARATORS = re.compile(r"[\\/]+")


def _normalize_asset_path(path: str) -> str:
    """Windows separators to POSIX, collapsing repeats and any leading slash."""
    return _SEPARATORS.sub("/", path).lstrip("/")


def materials_for(record: Record) -> list[str]:
    value = record.get(F.MATERIAL_PATH)
    return [_normalize_asset_path(value)] if isinstance(value, str) and value else []


def stats_for(record: Record) -> dict[str, Any]:
    params = record.get(F.ARMOR_PARAMS)
    if not isinstance(params, dict):
        return {}
    keep = (
        "damageResistances",
        "DamageResistances",
        "TemperatureResistance",
        "temperatureResistance",
        "CarryCapacity",
        "carryCapacity",
        "Volume",
        "armorRating",
    )
    return {k: v for k, v in params.items() if k in keep}


def tags_for(record: Record, index: Index) -> list[str]:
    raw = record.get(F.TAGS)
    entries = raw if isinstance(raw, list) else ([raw] if raw else [])
    out: list[str] = []
    for entry in entries:
        resolved = index.resolve_ref(entry)
        label = None
        if resolved is not None:
            label = F.first(resolved.data, ["tagName", "TagName", "Name", "name"])
        elif isinstance(entry, str) and not _is_null_guid(entry):
            label = entry
        if isinstance(label, str) and label and label not in out:
            out.append(label)
    return out


def flags_for(record: Record, geometry: list[Geometry]) -> list[str]:
    flags: list[str] = []
    name = record.class_name
    if TEST_PATTERNS.search(name):
        flags.append("test")
    if NPC_PATTERNS.search(name):
        flags.append("npc")
    if not geometry:
        flags.append("no_geometry")
    return flags


# ---------------------------------------------------------------------------
# Set grouping and variants
# ---------------------------------------------------------------------------

_VARIANT_SUFFIX = re.compile(
    r"[_-](black|white|grey|gray|red|blue|green|orange|yellow|tan|sand|brown|olive|navy|"
    r"slate|charcoal|steel|rust|bone|ash|khaki|forest|crimson|azure|"
    r"desert|arctic|jungle|urban|snow|camo|default|base|\d{2})$",
    re.IGNORECASE,
)


def canonical_key(class_name: str) -> str:
    """Strip a trailing colour/variant suffix to get the canonical item key."""
    key = class_name.lower()
    while True:
        stripped = _VARIANT_SUFFIX.sub("", key)
        if stripped == key:
            return key
        key = stripped


def set_key(item: Item) -> str:
    """Derive a set id from shared path prefix + manufacturer + weight class.

    Exposed as a function so the grouping rule can be tuned in one place
    (PLAN.md §3.4).
    """
    prefix = ""
    if item.geometry:
        parts = item.geometry[0].source.split("/")
        # Drop the filename and the per-slot leaf directory.
        if len(parts) >= 3:
            prefix = "/".join(parts[:-2])
    bits = [p for p in (prefix, item.manufacturer.code, item.weight_class) if p]
    if not bits:
        return canonical_key(item.class_name)
    return "|".join(bits).lower()


def link_variants(items: list[Item]) -> None:
    """Group colour variants: the first item of a group becomes canonical."""
    groups: dict[tuple[str, str], list[Item]] = defaultdict(list)
    for item in items:
        groups[(item.slot, canonical_key(item.class_name))].append(item)

    for group in groups.values():
        if len(group) < 2:
            continue
        group.sort(key=lambda i: (len(i.class_name), i.class_name))
        canonical, *rest = group
        canonical.variants = [i.id for i in rest]
        for other in rest:
            other.variant_of = canonical.id
            other.variants = []


def assign_sets(items: list[Item]) -> None:
    for item in items:
        item.set = set_key(item)


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------


def build_item(record: Record, index: Index, loc: Localization) -> Item | None:
    slot = slot_for(record)
    if slot is None:
        return None

    geometry = geometry_for(record)
    name_key = record.get(F.NAME_KEY)
    desc_key = record.get(F.DESCRIPTION_KEY)
    name = loc.get(name_key) if isinstance(name_key, str) else None

    return Item(
        id=record.id,
        class_name=record.class_name,
        name=name or record.class_name,
        name_key=name_key if isinstance(name_key, str) else None,
        description=loc.get(desc_key) if isinstance(desc_key, str) else None,
        description_key=desc_key if isinstance(desc_key, str) else None,
        slot=slot,
        sub_slot=sub_slot_for(record, slot),
        weight_class=weight_class_for(record),
        manufacturer=manufacturer_for(record, index),
        stats=stats_for(record),
        tags=tags_for(record, index),
        geometry=geometry,
        materials=materials_for(record),
        bind_mode="socket" if slot == "backpack" and not geometry else "skinned",
        assets=Assets(glb=None, thumb=None),
        flags=flags_for(record, geometry),
    )


def build(
    index: Index,
    loc: Localization,
    *,
    game_version: str = "unknown",
    include_npc: bool = False,
) -> tuple[Manifest, CatalogStats]:
    """Build a manifest from a loaded record index."""
    stats = CatalogStats()
    items: list[Item] = []

    for record in index.records:
        stats.considered += 1
        item = build_item(record, index, loc)
        if item is None:
            stats.skipped_no_slot += 1
            continue
        if "npc" in item.flags and not include_npc:
            continue
        items.append(item)
        stats.matched += 1
        if item.name_key and item.name == item.class_name:
            stats.unresolved_names += 1

    items.sort(key=lambda i: (i.slot, i.name.lower(), i.class_name))
    assign_sets(items)
    link_variants(items)

    manifest = Manifest(game_version=game_version, items=items)
    return manifest, stats
