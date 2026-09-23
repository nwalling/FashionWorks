"""Gear and holsters: what a character carries, and where it hangs. LOADOUT.md.

Two things come out of the DataCore here.

**Armour ports.** Every armour record carries
``SItemPortContainerComponentParams.Ports``, and each port that hangs an item
off a bone is a holster: the bone it hangs from, the item types and sizes it
accepts, and the locator *on the item* that meets the bone. The count follows
the torso's weight class exactly across all 1,741 armour records -- a light core
carries one rifle holster, two grenade and four magazine points; a heavy one
two, four and eight -- so it is read, not tabled.

**Gear items.** Weapons, knives, grenades, magazines, pens and gadgets live
under ``entities/scitem/weapons/`` and ``entities/scitem/consumables/``, not
under ``characters/human``. Their geometry tree is the opposite of armour's:
the **root** node is the item (a ``.cdf`` for most weapons, a ``.cgf`` for
knives and magazines) carrying the record's own colourway ``.mtl`` or palette,
and the tagged ``SubGeometry`` children are alternates *for other records* --
``Green01``, ``Mr01``, ``tableDisplay`` -- which must be ignored.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from . import fields as F
from .catalog import (
    GeoNode,
    _attach,
    _normalize_asset_path,
    canonical_key,
    flags_for,
    manufacturer_for,
    tags_for,
    tint_for,
)
from .dcb import Index, Record
from .localization import Localization
from .manifest import GearItem, Geometry

PORT_COMPONENT = "SItemPortContainerComponentParams"
BONE_IMPLEMENTATION = "SItemPortDefAttachmentImplementationBone"
LOADOUT_COMPONENT = "SEntityComponentDefaultLoadoutParams"

# Where gear records live. Ship-mounted guns and the dev folder are not gear.
GEAR_SCOPES = ("entities/scitem/weapons/", "entities/scitem/consumables/")
GEAR_EXCLUDED = ("/weapon_mounted/", "/dev/")

# ``AttachDef`` type and subtype to the slot a visitor browses. Hacking chips
# and keycards are ``FPS_Consumable:Hacking`` and ``RemovableChip``, and are out.
_WEAPON_SLOTS = {
    "medium": "primary",
    "large": "primary",
    "small": "sidearm",
    "knife": "knife",
    "gadget": "gadget",
    "grenade": "grenade",
}
_CONSUMABLE_SUBTYPES = {"medpack", "medical", "oxygencap"}

# The animation set that holds an item, from its tags, most specific first.
_ANIM_SETS = ("stocked", "pistol", "knife", "multitool", "grenade")
_ANIM_BY_SLOT = {"primary": "stocked", "sidearm": "pistol", "knife": "knife", "grenade": "grenade"}


def _types(port: dict) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for entry in port.get("Types") or []:
        if not isinstance(entry, dict):
            continue
        kind = entry.get("Type")
        if not isinstance(kind, str) or not kind:
            continue
        subtypes = [s for s in entry.get("SubTypes") or [] if isinstance(s, str) and s]
        out.append({"type": kind, "subtypes": subtypes})
    return out


def ports_for(record: Record) -> list[dict[str, Any]]:
    """The ports a record declares that hang an item off a bone.

    Skin-implemented ports -- an undersuit's ``Armor_Arms`` and friends -- are
    how armour layers onto the body, not holsters, and are left out.
    """
    component = F.component(record.data, PORT_COMPONENT)
    if component is None:
        return []
    out: list[dict[str, Any]] = []
    for port in component.get("Ports") or []:
        if not isinstance(port, dict):
            continue
        implementation = port.get("AttachmentImplementation") or {}
        if implementation.get("_Type_") != BONE_IMPLEMENTATION:
            continue
        helper = ((implementation.get("Helper") or {}).get("Helper")) or {}
        extension = port.get("Extension") or {}
        out.append(
            {
                "name": port.get("Name") or "",
                "types": _types(port),
                "min_size": int(port.get("MinSize") or 0),
                "max_size": int(port.get("MaxSize") or 0),
                "helper": helper.get("Name") or None,
                "offset": helper.get("ItemOffsetHelperName") or None,
                "select_tag": extension.get("SelectTag") or None,
            }
        )
    return out


def gear_slot_for(attach_type: str | None, subtype: str | None) -> str | None:
    kind = (attach_type or "").lower()
    sub = (subtype or "").lower()
    if kind == "weaponpersonal":
        return _WEAPON_SLOTS.get(sub)
    if kind == "weaponattachment":
        return "magazine" if sub == "magazine" else None
    if kind == "fps_consumable":
        return "consumable" if sub in _CONSUMABLE_SUBTYPES else None
    if kind == "gadget":
        return "gadget"
    return None


def anim_set_for(slot: str, tags: list[str]) -> str | None:
    lowered = {t.lower() for t in tags}
    for name in _ANIM_SETS:
        if name in lowered:
            return name
    return _ANIM_BY_SLOT.get(slot)


def default_children_for(record: Record) -> list[dict[str, str]]:
    """What the item ships with, by port: a rifle's magazine."""
    component = F.component(record.data, LOADOUT_COMPONENT)
    loadout = (component or {}).get("loadout") or {}
    out: list[dict[str, str]] = []
    for entry in loadout.get("entries") or []:
        if not isinstance(entry, dict):
            continue
        port = entry.get("itemPortName")
        child = entry.get("entityClassName")
        if isinstance(port, str) and port and isinstance(child, str) and child:
            out.append({"port": port, "class_name": child})
    return out


WEAPON_COMPONENT = "SCItemWeaponComponentParams"


def geometry_tags(record: Record) -> list[str]:
    """The tags a weapon selects its colourway by.

    ``SCItemWeaponComponentParams.geometryTags`` names the ``SubGeometry``
    child a record wears: ``behr_rifle_ballistic_01_tint01`` says ``Tint01``,
    and the child tagged ``Tint01`` carries its black palette. 309 gear records
    set it and 297 find their child; the rest carry the colourway on the root.
    """
    component = F.component(record.data, WEAPON_COMPONENT)
    raw = (component or {}).get("geometryTags")
    return raw.split() if isinstance(raw, str) else []


def selected_node(record: Record) -> GeoNode | None:
    """The geometry node a gear record wears: the tagged child its
    ``geometryTags`` names, else the root. A child that leaves a field empty
    takes the root's."""
    component = F.component(record.data, F.GEOMETRY_COMPONENT)
    if component is None:
        return None
    root = component.get(F.GEOMETRY_ROOT)
    if not isinstance(root, dict):
        return None

    def read(node: dict) -> tuple[str | None, str | None, str | None]:
        path = F.first(node, F.NODE_PATH)
        material = F.first(node, F.NODE_MATERIAL)
        palette = F.first(node, F.NODE_PALETTE)
        return (
            _normalize_asset_path(path) if isinstance(path, str) and path else None,
            _normalize_asset_path(material) if isinstance(material, str) and material else None,
            palette if isinstance(palette, str) and palette else None,
        )

    path, material, palette = read(root)
    wanted = {t.lower() for t in geometry_tags(record)}
    if wanted:
        for child in root.get(F.NODE_CHILDREN) or []:
            if not isinstance(child, dict):
                continue
            tag = child.get("Tags")
            if isinstance(tag, str) and tag.lower() in wanted:
                c_path, c_material, c_palette = read(child)
                path = c_path or path
                material = c_material or material
                palette = c_palette or palette
                break
    if not path:
        return None
    return GeoNode(path=path, material=material, depth=0, palette=palette)


def in_scope(record: Record) -> bool:
    path = str(record.path).replace("\\", "/").lower()
    return any(s in path for s in GEAR_SCOPES) and not any(x in path for x in GEAR_EXCLUDED)


def build_gear_item(record: Record, index: Index, loc: Localization) -> GearItem | None:
    attach_type = _attach(record, ["AttachDef.Type"])
    subtype = _attach(record, ["AttachDef.SubType"])
    slot = gear_slot_for(
        attach_type if isinstance(attach_type, str) else None,
        subtype if isinstance(subtype, str) else None,
    )
    if slot is None:
        return None

    # The root is the item, and its tagged children are colourways, of which
    # this record wears the one its `geometryTags` names.
    node = selected_node(record)
    roots = [node] if node else []
    geometry = [Geometry(source=n.path) for n in roots]
    materials = [n.material for n in roots if n.material]

    name_key = _attach(record, F.NAME_KEY)
    desc_key = _attach(record, F.DESCRIPTION_KEY)
    name = loc.get(name_key) if isinstance(name_key, str) else None
    flags = flags_for(record, geometry, name or record.class_name)

    raw_tags = _attach(record, ["AttachDef.Tags"])
    attach_tags = raw_tags.split() if isinstance(raw_tags, str) else []
    size = _attach(record, ["AttachDef.Size"])

    return GearItem(
        id=record.id,
        class_name=record.class_name,
        name=name or record.class_name,
        slot=slot,
        name_key=name_key if isinstance(name_key, str) else None,
        description=loc.get(desc_key) if isinstance(desc_key, str) else None,
        description_key=desc_key if isinstance(desc_key, str) else None,
        manufacturer=manufacturer_for(record, index, loc),
        attach={
            "type": attach_type if isinstance(attach_type, str) else "",
            "subtype": subtype if isinstance(subtype, str) else "",
            "size": int(size) if isinstance(size, (int, float)) else 0,
            "tags": attach_tags,
        },
        anim_set=anim_set_for(slot, attach_tags),
        tint=tint_for(roots, index),
        geometry=geometry,
        materials=materials,
        default_children=default_children_for(record),
        ports=ports_for(record),
        flags=flags,
        tags=tags_for(record, index),
    )


def link_gear_variants(items: list[GearItem]) -> None:
    """Colourways are one mesh in one slot.

    Not armour's product-name key: a weapon's edition sits in the middle of its
    name in quotes -- ``P4-AR "Blacklist" Rifle`` -- so the words before a slot
    word are the whole name, and every colourway became its own family. The
    mesh is the item; the listing groups wider, by product, above this.
    """
    groups: dict[tuple[str, str], list[GearItem]] = defaultdict(list)
    for item in items:
        source = item.geometry[0].source.lower() if item.geometry else canonical_key(item.class_name)
        groups[(item.slot, source)].append(item)
    for item in items:
        item.variant_of = None
        item.variants = []
    for group in groups.values():
        if len(group) < 2:
            continue
        group.sort(key=lambda i: (len(i.class_name), i.class_name))
        canonical, rest = group[0], group[1:]
        canonical.variants = [i.id for i in rest]
        for item in rest:
            item.variant_of = canonical.id


def build_gear(index: Index, loc: Localization) -> list[GearItem]:
    items: list[GearItem] = []
    for record in index.records:
        if record.record_type != "EntityClassDefinition" or not in_scope(record):
            continue
        item = build_gear_item(record, index, loc)
        if item is None or not item.geometry:
            continue
        items.append(item)
    items.sort(key=lambda i: (i.slot, i.name.lower(), i.class_name))
    link_gear_variants(items)
    return items

