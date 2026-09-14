"""StarEngine ``.mtl`` parsing.

Parsing lives here rather than in the Blender script so it is testable without
bpy, and so the pipeline can resolve textures and composite the tint palette
(:mod:`sc_extract.tint`) before Blender is ever started. Blender then consumes
finished descriptors.

CryEngine addresses textures by numbered slot, not by role name. Verified on
build 1.0.191.55227 against ``LayerBlend_V2`` armor materials.
"""

from __future__ import annotations

import logging
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger(__name__)

TEX_SLOTS = {
    "texslot1": "base_color",
    "texslot2": "specular",
    "texslot3": "normal",
    "texslot4": "environment",
    "texslot5": "detail",
    "texslot6": "opacity",
    "texslot7": "decal",
    "texslot8": "subsurface",
    "texslot9": "decal",
    "texslot11": "wear",
    "texslot12": "blend",
    "texslot13": "hal",
}

# Fallback when a material names no slot.
SUFFIX_ROLES = {
    "_diff": "base_color",
    "_ddna": "normal",
    "_ddn": "normal",
    "_spec": "specular",
    "_blend": "blend",
    "_wear": "wear",
    "_hal": "hal",
    "_decal": "decal",
    "_mask": "tint_mask",
    "_emis": "emissive",
}

LAYER_BLEND_SHADER = "LayerBlend_V2"

_EXT = re.compile(r"\.(tif|dds|png|tga)(\.\d+[ab]?)?$", re.IGNORECASE)
_SEPARATORS = re.compile(r"[\\/]+")


def normalize(path: str) -> str:
    return _SEPARATORS.sub("/", path).lstrip("/")


def classify(texture_path: str, slot: str | None = None) -> str | None:
    """Role for a texture, preferring the explicit slot over the filename."""
    if slot:
        role = TEX_SLOTS.get(slot.strip().lower())
        if role:
            return role
    stem = _EXT.sub("", Path(texture_path).name.lower())
    for suffix, role in SUFFIX_ROLES.items():
        if stem.endswith(suffix):
            return role
    return None


def _color(value: str | None, default: tuple[float, float, float]) -> tuple[float, float, float]:
    if not value:
        return default
    try:
        parts = tuple(float(p) for p in value.split(","))
    except ValueError:
        return default
    return parts if len(parts) == 3 else default  # type: ignore[return-value]


def _scalar(value: str | None, default: float) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


@dataclass
class MatLayer:
    """One ``<MatLayers><Layer>`` entry of a LayerBlend_V2 submaterial.

    This is the shader input v2 ignored entirely, and the reason armour
    rendered in the wrong colours with no surface detail. Each layer names a
    tiling detail material under ``Materials/Layers`` and carries its own
    colour. ``palette_tint`` decides where that colour comes from:

    * ``0`` - use this layer's own baked ``tint_color`` (17332 of 19981
      layers across the male armour set, i.e. 87%)
    * ``1``/``2``/``3`` - take it from palette entry A/B/C

    Applying the palette to every layer, as v2 did, repainted the 87% that
    the artist had already coloured.
    """

    name: str = ""
    path: str = ""
    tint_color: tuple[float, float, float] = (1.0, 1.0, 1.0)
    wear_tint: tuple[float, float, float] = (1.0, 1.0, 1.0)
    gloss_mult: float = 1.0
    wear_gloss: float = 1.0
    uv_tiling: float = 1.0
    palette_tint: int = 0

    @property
    def is_wear(self) -> bool:
        return self.name.lower().startswith("wear")

    @property
    def metallic(self) -> bool:
        """Layers under ``Materials/Layers/metal`` are bare metal."""
        return "/metal/" in normalize(self.path).lower()

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "path": self.path,
            "tint_color": list(self.tint_color),
            "gloss_mult": self.gloss_mult,
            "uv_tiling": self.uv_tiling,
            "palette_tint": self.palette_tint,
            "metallic": self.metallic,
        }


@dataclass
class SubMaterial:
    """One entry of a .mtl's SubMaterials list, in slot order."""

    name: str
    shader: str = ""
    textures: dict[str, str] = field(default_factory=dict)
    diffuse: tuple[float, float, float] = (1.0, 1.0, 1.0)
    specular: tuple[float, float, float] = (0.0, 0.0, 0.0)
    shininess: float = 10.0
    layers: list[MatLayer] = field(default_factory=list)

    @property
    def base_layers(self) -> list[MatLayer]:
        """BaseLayer1..4, in slot order. The blend mask picks between them."""
        return [layer for layer in self.layers if not layer.is_wear]

    @property
    def wear_layers(self) -> list[MatLayer]:
        return [layer for layer in self.layers if layer.is_wear]

    @property
    def wear_pairs(self) -> list[MatLayer | None]:
        """The wear layer for each base layer, aligned with :attr:`base_layers`.

        ``WearLayerN`` is what ``BaseLayerN`` looks like once it has worn
        through, matched on the trailing slot number. The RSI utility suit
        states it plainly: its four base layers are ``painted_metal_04/07/10/11``
        and its four wear layers are ``aluminum_scratched_02``,
        ``anodized_metal_01``, ``steel_dark_01`` and ``iron_scratched_dark`` --
        paint over the bare metal underneath, index for index.

        An entry is ``None`` where the material opts out. Artists disable wear
        for a layer by pointing its wear entry at the same material as the
        base, which is 29% of all pairs (2744 of 9436); the cloth body of that
        same suit sets all four that way.
        """
        wear = {layer.name[-1:]: layer for layer in self.wear_layers}
        out: list[MatLayer | None] = []
        for layer in self.base_layers:
            match = wear.get(layer.name[-1:])
            out.append(None if match is None or match.path == layer.path else match)
        return out

    @property
    def tintable(self) -> bool:
        """LayerBlend_V2 has no albedo; its colour comes from the tint palette."""
        return self.shader == LAYER_BLEND_SHADER or "tint" in self.name.lower()

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "shader": self.shader,
            "textures": dict(self.textures),
            "diffuse": list(self.diffuse),
            "specular": list(self.specular),
            "shininess": self.shininess,
            "tintable": self.tintable,
            "layers": [layer.as_dict() for layer in self.layers],
        }


def parse(path: Path) -> list[SubMaterial]:
    """Parse a converted (CryXML -> XML) .mtl into submaterials, in order."""
    if not path.is_file():
        return []
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as exc:
        log.warning("unparseable material %s: %s", path, exc)
        return []

    nodes = [n for n in root.findall(".//Material") if n.get("Name")] or [root]
    out: list[SubMaterial] = []
    for node in nodes:
        textures: dict[str, str] = {}
        for tex in node.findall(".//Texture"):
            file_attr = tex.get("File") or tex.get("file")
            if not file_attr:
                continue
            role = classify(file_attr, tex.get("Map"))
            if role and role not in textures:
                textures[role] = normalize(file_attr)
        layers: list[MatLayer] = []
        for block in node.findall("MatLayers"):
            for entry in block.findall("Layer"):
                layers.append(
                    MatLayer(
                        name=entry.get("Name") or "",
                        path=normalize(entry.get("Path") or ""),
                        tint_color=_color(entry.get("TintColor"), (1.0, 1.0, 1.0)),
                        wear_tint=_color(entry.get("WearTint"), (1.0, 1.0, 1.0)),
                        gloss_mult=_scalar(entry.get("GlossMult"), 1.0),
                        wear_gloss=_scalar(entry.get("WearGloss"), 1.0),
                        uv_tiling=_scalar(entry.get("UVTiling"), 1.0),
                        palette_tint=int(_scalar(entry.get("PaletteTint"), 0.0)),
                    )
                )
        out.append(
            SubMaterial(
                name=node.get("Name") or path.stem,
                shader=node.get("Shader") or "",
                textures=textures,
                diffuse=_color(node.get("Diffuse"), (1.0, 1.0, 1.0)),
                specular=_color(node.get("Specular"), (0.0, 0.0, 0.0)),
                shininess=float(node.get("Shininess") or 10.0),
                layers=layers,
            )
        )
    return out
