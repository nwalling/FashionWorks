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


@dataclass
class SubMaterial:
    """One entry of a .mtl's SubMaterials list, in slot order."""

    name: str
    shader: str = ""
    textures: dict[str, str] = field(default_factory=dict)
    diffuse: tuple[float, float, float] = (1.0, 1.0, 1.0)
    specular: tuple[float, float, float] = (0.0, 0.0, 0.0)
    shininess: float = 10.0

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
        out.append(
            SubMaterial(
                name=node.get("Name") or path.stem,
                shader=node.get("Shader") or "",
                textures=textures,
                diffuse=_color(node.get("Diffuse"), (1.0, 1.0, 1.0)),
                specular=_color(node.get("Specular"), (0.0, 0.0, 0.0)),
                shininess=float(node.get("Shininess") or 10.0),
            )
        )
    return out
