"""Manifest schema (PLAN.md §3.4) as dataclasses, plus (de)serialization.

The viewer validates the same shape with zod (``viewer/src/manifest.ts``).
Bump ``SCHEMA_VERSION`` and both sides together.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

SCHEMA_VERSION = 5

Slot = Literal[
    "helmet", "torso", "arms", "legs", "backpack", "undersuit",
    "hat", "shirt", "jacket", "accessory", "gloves", "trousers", "footwear", "pack",
]
SLOTS: tuple[str, ...] = ("helmet", "torso", "arms", "legs", "backpack", "undersuit")

# Clothing: what the body wears when no undersuit does. CLOTHING.md. The two
# outfits are exclusive in the game -- 215 of 222 undersuits hide every clothing
# port -- so a slot belongs to exactly one of them, and the slot says which.
CLOTHING_SLOTS: tuple[str, ...] = (
    "hat", "shirt", "jacket", "accessory", "gloves", "trousers", "footwear", "pack",
)
ALL_SLOTS: tuple[str, ...] = SLOTS + CLOTHING_SLOTS

Outfit = Literal["armour", "clothing"]


def outfit_of(slot: str) -> str:
    return "clothing" if slot in CLOTHING_SLOTS else "armour"

BindMode = Literal["skinned", "socket"]

# Gear: what a character carries rather than wears. LOADOUT.md.
GearSlot = Literal["primary", "sidearm", "knife", "gadget", "grenade", "magazine", "consumable"]
GEAR_SLOTS: tuple[str, ...] = (
    "primary", "sidearm", "knife", "gadget", "grenade", "magazine", "consumable",
)


@dataclass
class Manufacturer:
    code: str = ""
    name: str = ""


@dataclass
class Geometry:
    source: str
    side: str | None = None


@dataclass
class MaterialOverride:
    """Textures a colour variant swaps onto the shared canonical mesh.

    Colour variants reuse their canonical item's GLB, which is right for the
    geometry and wrong for the surface: 1626 of 2081 variants name their own
    ``.mtl`` under ``mtl_var/`` and 876 of those carry no tint palette at all,
    so there was nothing for the viewer to re-apply and every Odyssey undersuit
    rendered the same colour. Re-converting the mesh per variant would cost
    hours and 12 GB for geometry that is byte-identical, so only the composited
    textures are baked and the viewer swaps them by submaterial name.
    """

    name: str
    base_color: str | None = None
    orm: str | None = None
    # The same surface composited with the wear blend skipped, so the viewer can
    # show a piece as it left the factory. Optional: a build made before this
    # existed, or one run with --no-unworn, simply has none and the toggle is
    # hidden rather than broken.
    base_color_unworn: str | None = None
    orm_unworn: str | None = None


@dataclass
class Assets:
    glb: str | None = None
    thumb: str | None = None


@dataclass
class Item:
    id: str
    class_name: str
    name: str
    slot: str
    name_key: str | None = None
    description: str | None = None
    description_key: str | None = None
    sub_slot: str | None = None
    weight_class: str | None = None
    manufacturer: Manufacturer = field(default_factory=Manufacturer)
    set: str | None = None
    variant_of: str | None = None
    variants: list[str] = field(default_factory=list)
    tint: dict[str, Any] | None = None
    stats: dict[str, Any] = field(default_factory=dict)
    bind_mode: str = "skinned"
    socket: str | None = None
    # How far this piece shifts each attachment point from the canonical rig,
    # in glTF axes. A heavy torso mounts a backpack further out than a thin
    # undersuit does, so a rigid piece has to follow whatever is worn.
    socket_offsets: dict[str, list[float]] = field(default_factory=dict)
    geometry: list[Geometry] = field(default_factory=list)
    materials: list[str] = field(default_factory=list)
    # Per-variant surface, swapped onto the shared canonical mesh at load.
    material_overrides: list[MaterialOverride] = field(default_factory=list)
    # Representative colour for the picker swatch. The palette's first entry is
    # not it: 876 variants have no palette, and where one exists the material
    # may tint from entry B or C rather than A.
    swatch: str | None = None
    assets: Assets = field(default_factory=Assets)
    flags: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    # The holsters this piece declares: ``SItemPortContainerComponentParams``
    # ports that hang an item off a bone. See ``gear.ports_for``.
    ports: list[dict[str, Any]] = field(default_factory=list)
    # Which outfit the slot belongs to. See ``outfit_of``.
    outfit: str = "armour"
    # ``SCItemClothingParams.Chunks``: the body zones this piece covers, the
    # layer it covers them at, and the layers it leaves drawn beneath (``[0]``
    # on the last zone a sleeve reaches). ``{zone, layer, visible}``.
    chunks: list[dict[str, Any]] = field(default_factory=list)
    # ``SCItemClothingParams.HiddenParts``: the ports this piece hides while
    # worn -- an undersuit the clothing ports, a jacket the shirt, a helmet the
    # hat and hair.
    hidden: list[str] = field(default_factory=list)


@dataclass
class GearItem:
    """A weapon, knife, pen, grenade, magazine or gadget."""

    id: str
    class_name: str
    name: str
    slot: str
    name_key: str | None = None
    description: str | None = None
    description_key: str | None = None
    manufacturer: Manufacturer = field(default_factory=Manufacturer)
    # ``AttachDef``: what a port checks an item against.
    attach: dict[str, Any] = field(default_factory=dict)
    # Which animation set holds it: stocked, pistol, knife, multitool, grenade.
    anim_set: str | None = None
    variant_of: str | None = None
    variants: list[str] = field(default_factory=list)
    tint: dict[str, Any] | None = None
    geometry: list[Geometry] = field(default_factory=list)
    materials: list[str] = field(default_factory=list)
    # What it ships with: a rifle's magazine.
    default_children: list[dict[str, str]] = field(default_factory=list)
    ports: list[dict[str, Any]] = field(default_factory=list)
    flags: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)


@dataclass
class Skeleton:
    chr: str | None = None
    glb: str | None = None


@dataclass
class Manifest:
    game_version: str = "unknown"
    schema_version: int = SCHEMA_VERSION
    generated_at: str = ""
    skeletons: dict[str, Skeleton] = field(default_factory=dict)
    sockets: list[str] = field(default_factory=list)
    items: list[Item] = field(default_factory=list)
    gear: list[GearItem] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.generated_at:
            self.generated_at = datetime.now(UTC).isoformat(timespec="seconds")

    # -- counts ---------------------------------------------------------
    def counts_by_slot(self) -> dict[str, int]:
        counts = dict.fromkeys(ALL_SLOTS, 0)
        for item in self.items:
            counts[item.slot] = counts.get(item.slot, 0) + 1
        return counts

    def by_id(self) -> dict[str, Item]:
        return {item.id: item for item in self.items}

    def armour(self) -> list[Item]:
        """The armour outfit's items: what the Blender pipeline converts.

        Clothing is catalogued for the web kitbasher, which draws it live. The
        local viewer is armour-only by decision, as it is gear-free.
        """
        return [item for item in self.items if item.outfit == "armour"]

    # -- io -------------------------------------------------------------
    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "game_version": self.game_version,
            "generated_at": self.generated_at,
            "skeletons": {k: asdict(v) for k, v in self.skeletons.items()},
            "sockets": list(self.sockets),
            "items": [asdict(item) for item in self.items],
            "gear": [asdict(item) for item in self.gear],
        }

    def write(self, path: Path) -> Path:
        # Always stamp the current version. Reading an older manifest and
        # writing it back used to preserve its number, so a stage that added
        # new fields shipped them under the old version and the viewer, which
        # refuses a mismatch, rejected a manifest it could actually read.
        self.schema_version = SCHEMA_VERSION
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict(), indent=2) + "\n", encoding="utf-8")
        return path

    @classmethod
    def read(cls, path: Path) -> Manifest:
        return cls.from_dict(json.loads(path.read_text(encoding="utf-8")))

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Manifest:
        items: list[Item] = []
        for raw in data.get("items", []):
            raw = dict(raw)
            raw["manufacturer"] = Manufacturer(**(raw.get("manufacturer") or {}))
            raw["assets"] = Assets(**(raw.get("assets") or {}))
            raw["geometry"] = [Geometry(**g) for g in raw.get("geometry", [])]
            raw["material_overrides"] = [
                MaterialOverride(**o) for o in raw.get("material_overrides") or []
            ]
            known = {f for f in Item.__dataclass_fields__}
            items.append(Item(**{k: v for k, v in raw.items() if k in known}))
        gear: list[GearItem] = []
        for raw in data.get("gear", []) or []:
            raw = dict(raw)
            raw["manufacturer"] = Manufacturer(**(raw.get("manufacturer") or {}))
            raw["geometry"] = [Geometry(**g) for g in raw.get("geometry", [])]
            known = {f for f in GearItem.__dataclass_fields__}
            gear.append(GearItem(**{k: v for k, v in raw.items() if k in known}))
        return cls(
            schema_version=int(data.get("schema_version", SCHEMA_VERSION)),
            game_version=str(data.get("game_version", "unknown")),
            generated_at=str(data.get("generated_at", "")),
            skeletons={k: Skeleton(**v) for k, v in (data.get("skeletons") or {}).items()},
            sockets=list(data.get("sockets") or []),
            items=items,
            gear=gear,
        )
