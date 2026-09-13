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
from .manifest import SLOTS, Assets, Geometry, Item, Manifest, Manufacturer, Skeleton

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


def attach_def(record: Record) -> dict | None:
    """The SAttachableComponentParams component, or None."""
    return F.component(record.data, F.ATTACHABLE)


def _attach(record: Record, paths: list[str], default: Any = None) -> Any:
    component = attach_def(record)
    return default if component is None else F.first(component, paths, default)


def slot_for(record: Record) -> str | None:
    """Map a record to one of the six slots, or None if it is not armor.

    ``AttachDef.Type`` is authoritative and uses the ``Char_Armor_*`` family
    (verified against build 1.0.191.55227). Class-name hints are a fallback so a
    renamed attach type cannot silently empty the catalog.
    """
    attach_type = _attach(record, F.ATTACH_TYPE)
    if isinstance(attach_type, str):
        direct = F.ARMOR_ATTACH_TYPES.get(attach_type)
        if direct:
            return direct
        if attach_type.lower().startswith("char_armor_"):
            suffix = attach_type.split("_")[-1].lower()
            for slot in SLOTS:
                if suffix.startswith(slot[:4]):
                    return slot

    name = record.class_name.lower()
    for needle, slot in F.SLOT_NAME_HINTS:
        if needle in name:
            return slot
    return None


def sub_slot_for(record: Record, slot: str) -> str | None:
    subtype = _attach(record, F.ATTACH_SUBTYPE)
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
    """light | medium | heavy | superheavy, from the class name or subtype.

    The DataCore also encodes it in the record's own path
    (``.../pu_armor/<weight>/<slot>/``), which :func:`weight_from_record_path`
    uses as a cross-check.
    """
    haystack = " ".join(
        str(v).lower()
        for v in (
            record.class_name,
            _attach(record, F.ATTACH_SUBTYPE),
            _attach(record, F.ATTACH_SIZE),
        )
        if v
    )
    for needle, value in F.WEIGHT_CLASS_HINTS:
        if needle in haystack:
            return value
    return weight_from_record_path(record)


def weight_from_record_path(record: Record) -> str | None:
    """Read the weight class out of the exported record's directory path."""
    if record.path is None:
        return None
    parts = {part.lower() for part in record.path.parts}
    for _, value in F.WEIGHT_CLASS_HINTS:
        if value in parts:
            return value
    return None


def manufacturer_for(
    record: Record, index: Index, loc: Localization | None = None
) -> Manufacturer:
    """Resolve the manufacturer, localizing its name.

    The reference is a ``file://`` path ending ``scitemmanufacturer.<code>.json``,
    so the code is recoverable even when the manufacturer record is missing from
    the export. The record's ``Name`` is a localization key
    (``@manufacturer_NameCDS``), not display text.
    """
    ref = _attach(record, F.MANUFACTURER_REF)
    resolved = index.resolve_ref(ref)
    derived = Index.ref_name(ref) if isinstance(ref, str) and ref else None
    if derived and _is_null_guid(derived):
        derived = None

    code = ""
    name = ""
    if resolved is not None:
        body = F.record_body(resolved.data)
        code = str(F.first(body, ["Code", "code", "ShortName"], "") or "")
        raw_name = F.first(body, ["Name", "name", "Localization.Name"], "") or ""
        if isinstance(raw_name, str) and raw_name:
            name = (loc.get(raw_name) if loc else None) or (
                "" if raw_name.startswith("@") else raw_name
            )

    if not code and derived:
        code = derived
    return Manufacturer(code=code.upper(), name=name)


def _is_null_guid(value: str) -> bool:
    return set(value.strip("{}")) <= {"0", "-"}


_SEPARATORS = re.compile(r"[\\/]+")


def _normalize_asset_path(path: str) -> str:
    """Windows separators to POSIX, collapsing repeats and any leading slash."""
    return _SEPARATORS.sub("/", path).lstrip("/")


def _side_of(path: str) -> str | None:
    """Left/right for paired limb meshes, else None."""
    stem = path.rsplit("/", 1)[-1].lower()
    if re.search(r"(^|[_-])(l|lt|left)([_.-]|$)", stem):
        return "left"
    if re.search(r"(^|[_-])(r|rt|right)([_.-]|$)", stem):
        return "right"
    return None


# Base skeletons, verified present in build 1.0.191.55227.
SKELETON_CHR = {
    "male": "Data/Objects/Characters/Human/male_v7/export/bhm_skeleton_v7.chr",
    "female": "Data/Objects/Characters/Human/female_v2/export/bhf_skeleton_v2.chr",
}

# Skeleton name -> the P4K directory that holds that gender's wearables.
SKELETON_ROOTS = {"male": "male_v7", "female": "female_v2"}

MESH_SUFFIXES = (".skin", ".cdf", ".cga", ".cgf", ".chr")
SKINNED_SUFFIXES = (".skin",)
RIGID_SUFFIXES = (".cga", ".cgf")

_LOD = re.compile(r"_lod\d+(?=\.[a-z]+$)", re.IGNORECASE)
# The dropped/carried world model, not the worn mesh.
_PROP = re.compile(r"(carry_prop|_prop)(?=\.[a-z]+$)", re.IGNORECASE)
# Shared first-person visor meshes, offered per aspect ratio under every helmet.
_VISOR = re.compile(r"/shared/visor/", re.IGNORECASE)


@dataclass
class GeoNode:
    """One node of an SGeometryResourceParams geometry tree."""

    path: str
    material: str | None
    depth: int
    palette: str | None = None

    @property
    def suffix(self) -> str:
        return "." + self.path.rsplit(".", 1)[-1].lower() if "." in self.path else ""

    @property
    def is_lod(self) -> bool:
        return bool(_LOD.search(self.path))

    @property
    def is_prop(self) -> bool:
        return bool(_PROP.search(self.path))

    @property
    def is_visor(self) -> bool:
        return bool(_VISOR.search(self.path))


def walk_geometry(record: Record) -> list[GeoNode]:
    """Flatten the geometry tree of SGeometryResourceParams.

    Shape verified against build 1.0.191.55227: the component holds a root
    ``Geometry`` node; each node carries ``Geometry.Geometry.path`` plus
    ``Geometry.Material.path``, and children in ``SubGeometry``. The root is the
    carry prop; the worn meshes hang off ``SubGeometry``, one per gender.
    """
    component = F.component(record.data, F.GEOMETRY_COMPONENT)
    if component is None:
        return []

    out: list[GeoNode] = []
    seen: set[str] = set()

    def visit(node: Any, depth: int) -> None:
        if not isinstance(node, dict):
            return
        path = F.first(node, F.NODE_PATH)
        if isinstance(path, str) and path:
            normalized = _normalize_asset_path(path)
            key = normalized.lower()
            if key not in seen:
                seen.add(key)
                material = F.first(node, F.NODE_MATERIAL)
                palette = F.first(node, F.NODE_PALETTE)
                out.append(
                    GeoNode(
                        path=normalized,
                        material=_normalize_asset_path(material)
                        if isinstance(material, str)
                        else None,
                        depth=depth,
                        palette=palette if isinstance(palette, str) and palette else None,
                    )
                )
        for child in node.get(F.NODE_CHILDREN) or []:
            visit(child, depth + 1)

    visit(component.get(F.GEOMETRY_ROOT), 0)
    return out


def select_wearables(nodes: list[GeoNode], skeleton: str) -> list[GeoNode]:
    """Pick the meshes actually worn on ``skeleton`` from a geometry tree.

    Drops LODs, carry props and the shared visor meshes, and prefers the
    gendered ``.skin`` over anything else. Falls back to a ``.cdf`` (which names
    the real mesh indirectly) and finally to a rigid ``.cga``/``.cgf``, which is
    how backpacks ship.
    """
    root = SKELETON_ROOTS.get(skeleton, skeleton)
    usable = [n for n in nodes if not n.is_lod and not n.is_visor and n.suffix in MESH_SUFFIXES]

    def for_this_skeleton(node: GeoNode) -> bool:
        lowered = node.path.lower()
        other = [r for name, r in SKELETON_ROOTS.items() if name != skeleton]
        if f"/{root}/" in lowered:
            return True
        # Backpacks and other shared props live outside the gendered trees.
        return not any(f"/{o}/" in lowered for o in other)

    scoped = [n for n in usable if for_this_skeleton(n)]

    skins = [n for n in scoped if n.suffix in SKINNED_SUFFIXES and not n.is_prop]
    if skins:
        return skins

    cdfs = [n for n in scoped if n.suffix == ".cdf"]
    if cdfs:
        return cdfs[:1]

    rigid = [n for n in scoped if n.suffix in RIGID_SUFFIXES and not n.is_prop]
    if rigid:
        return rigid[:1]

    # Everything left is a prop; better to report no geometry than a crate.
    return []


def geometry_for(
    record: Record, skeleton: str = "male"
) -> tuple[list[Geometry], list[str], list[GeoNode]]:
    """Return worn geometry, its material paths, and the nodes they came from."""
    nodes = walk_geometry(record)
    chosen = select_wearables(nodes, skeleton)
    geometry = [Geometry(source=n.path, side=_side_of(n.path)) for n in chosen]
    materials: list[str] = []
    for node in chosen:
        if node.material and node.material not in materials:
            materials.append(node.material)
    return geometry, materials, chosen


def _srgb(entry: Any, key: str) -> str | None:
    """An SRGB8 sub-object to a #rrggbb string."""
    if not isinstance(entry, dict):
        return None
    colour = entry.get(key)
    if not isinstance(colour, dict):
        return None
    try:
        r, g, b = (int(colour[k]) for k in ("r", "g", "b"))
    except (KeyError, TypeError, ValueError):
        return None
    return f"#{r:02x}{g:02x}{b:02x}"


def tint_for(nodes: list[GeoNode], index: Index) -> dict[str, Any] | None:
    """Resolve an item's tint palette.

    Armor in this build has no albedo texture. Its shader (``LayerBlend_V2``)
    composites three tint layers, and the colours live in a ``TintPaletteTree``
    record referenced per geometry node. Each of ``entryA``/``entryB``/``entryC``
    carries a tint colour, a specular colour and a glossiness.
    """
    ref = next((n.palette for n in nodes if n.palette), None)
    if not ref:
        return None
    record = index.resolve_ref(ref)
    if record is None:
        return {"palette_ref": Index.ref_name(ref)}

    root = F.first(F.record_body(record.data), ["root"])
    if not isinstance(root, dict):
        return {"palette_ref": Index.ref_name(ref)}

    layers = []
    for key in ("entryA", "entryB", "entryC"):
        entry = root.get(key)
        if not isinstance(entry, dict):
            continue
        glossiness = entry.get("glossiness")
        layers.append(
            {
                "color": _srgb(entry, "tintColor"),
                "spec": _srgb(entry, "specColor"),
                "glossiness": (float(glossiness) / 255.0)
                if isinstance(glossiness, (int, float))
                else None,
            }
        )

    return {
        "palette_ref": Index.ref_name(ref),
        "layers": layers,
        "colors": [layer["color"] for layer in layers if layer["color"]],
        "glass": _srgb(root, "glassColor"),
    }


def bind_mode_for(geometry: list[Geometry]) -> str:
    """Rigid meshes attach to a socket; skinned ones bind to the skeleton."""
    if geometry and all(g.source.lower().endswith(RIGID_SUFFIXES) for g in geometry):
        return "socket"
    return "skinned"


def materials_for(record: Record, skeleton: str = "male") -> list[str]:
    """Material paths for the worn meshes (colour variants live in mtl_var/)."""
    return geometry_for(record, skeleton)[1]


def stats_for(record: Record) -> dict[str, Any]:
    params = F.component(record.data, F.CLOTHING) or F.component(record.data, F.SUIT_ARMOR)
    if not isinstance(params, dict):
        return {}
    return {k: v for k, v in params.items() if k in F.CLOTHING_STAT_KEYS}


def tags_for(record: Record, index: Index) -> list[str]:
    """Tags for an item.

    ``AttachDef.Tags`` in this build is a single space-separated string, e.g.
    ``"Marine_Light Set_02 Color_02 SM_Marine"``. Older shapes (a list of
    record references) are still handled.
    """
    raw = _attach(record, F.TAGS)
    if raw is None:
        raw = F.first(F.record_body(record.data), ["tags", "Tags"])

    if isinstance(raw, str):
        return [tag for tag in raw.split() if tag]

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


_SET_TAG = re.compile(r"^Set_(\w+)$", re.IGNORECASE)
_COLOR_TAG = re.compile(r"^Color_(\w+)$", re.IGNORECASE)


def tag_value(tags: list[str], pattern: re.Pattern[str]) -> str | None:
    for tag in tags:
        match = pattern.match(tag)
        if match:
            return match.group(1).lower()
    return None


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
    """Derive a set id.

    This build tags items with ``Set_<n>`` and a manufacturer, which is an exact
    grouping. Items without a set tag fall back to shared geometry path prefix
    plus manufacturer plus weight class.
    """
    set_tag = tag_value(item.tags, _SET_TAG)
    if set_tag:
        bits = [item.manufacturer.code or "", item.weight_class or "", f"set{set_tag}"]
        return "_".join(b for b in bits if b).lower()

    prefix = ""
    if item.geometry:
        parts = item.geometry[0].source.split("/")
        if len(parts) >= 3:
            prefix = "/".join(parts[:-2])
    bits = [p for p in (prefix, item.manufacturer.code, item.weight_class) if p]
    if not bits:
        return canonical_key(item.class_name)
    return "|".join(bits).lower()


def link_variants(items: list[Item]) -> None:
    """Group colour variants so the viewer shows one entry with swatches.

    Items in the same set and slot that differ only by their ``Color_<n>`` tag
    are variants of one another. Items without colour tags fall back to
    stripping a colour-ish suffix from the class name.
    """
    groups: dict[tuple[str, str, str], list[Item]] = defaultdict(list)
    for item in items:
        set_tag = tag_value(item.tags, _SET_TAG)
        key = (
            (item.set or "", item.slot, "tagged")
            if set_tag
            else (canonical_key(item.class_name), item.slot, "name")
        )
        groups[key].append(item)

    for group in groups.values():
        for member in group:
            member.variant_of = None
            member.variants = []
        if len(group) < 2:
            continue
        group.sort(key=lambda i: (tag_value(i.tags, _COLOR_TAG) or "", i.class_name))
        canonical, *rest = group
        canonical.variants = [i.id for i in rest]
        for other in rest:
            other.variant_of = canonical.id


def assign_sets(items: list[Item]) -> None:
    for item in items:
        item.set = set_key(item)


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------


def build_item(
    record: Record, index: Index, loc: Localization, *, skeleton: str = "male"
) -> Item | None:
    slot = slot_for(record)
    if slot is None:
        return None

    geometry, materials, nodes = geometry_for(record, skeleton)
    name_key = _attach(record, F.NAME_KEY)
    desc_key = _attach(record, F.DESCRIPTION_KEY)
    name = loc.get(name_key) if isinstance(name_key, str) else None

    flags = flags_for(record, geometry)
    if any(g.source.lower().endswith(".cdf") for g in geometry):
        # The mesh is named indirectly; `scx extract` resolves it.
        flags.append("cdf")

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
        manufacturer=manufacturer_for(record, index, loc),
        tint=tint_for(nodes, index),
        stats=stats_for(record),
        tags=tags_for(record, index),
        geometry=geometry,
        materials=materials,
        bind_mode=bind_mode_for(geometry),
        assets=Assets(glb=None, thumb=None),
        flags=flags,
    )


def build(
    index: Index,
    loc: Localization,
    *,
    game_version: str = "unknown",
    include_npc: bool = False,
    skeleton: str = "male",
) -> tuple[Manifest, CatalogStats]:
    """Build a manifest from a loaded record index."""
    stats = CatalogStats()
    items: list[Item] = []

    for record in index.records:
        stats.considered += 1
        item = build_item(record, index, loc, skeleton=skeleton)
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

    manifest = Manifest(
        game_version=game_version,
        skeletons={skeleton: Skeleton(chr=SKELETON_CHR.get(skeleton), glb=f"base/{skeleton}.glb")},
        items=items,
    )
    return manifest, stats
