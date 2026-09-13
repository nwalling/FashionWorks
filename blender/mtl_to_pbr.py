"""StarEngine ``.mtl`` -> Principled BSDF mapping (PLAN.md §4.3 step 6).

Channel mapping, with the parts that are guesses called out:

* ``_diff``  -> Base Color
* ``_ddna``  -> Normal from RGB (DirectX-style, so green is inverted), and
                gloss from alpha, converted as ``roughness = 1 - gloss``
* ``_spec``  -> approximated as Specular tint plus an optional metallic mask
* ``_disp`` / ``_blend`` -> ignored for v1
* ``_mask``  -> kept as a tint mask on a material slot named ``tint_<n>``

UNVERIFIED: the exact ``_ddna`` gloss encoding and ``_spec`` semantics. Confirm
against a known-good in-game reference before treating output as final.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from pathlib import Path

import bpy  # type: ignore[import-not-found]

import _common as C

CHANNEL_SUFFIXES = {
    "_diff": "base_color",
    "_ddna": "normal_gloss",
    "_spec": "specular",
    "_disp": "displacement",
    "_blend": "blend",
    "_mask": "tint_mask",
    "_emis": "emissive",
}

_MIP = re.compile(r"\.dds(\.\d+[ab]?)?$", re.IGNORECASE)


def classify(texture_path: str) -> str | None:
    stem = _MIP.sub("", Path(texture_path).name.lower())
    for suffix, role in CHANNEL_SUFFIXES.items():
        if stem.endswith(suffix):
            return role
    return None


def parse_mtl(path: Path) -> list[dict]:
    """Parse a converted (CryXML -> XML) .mtl into submaterial descriptors."""
    if not path.is_file():
        return []
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError:
        return []

    nodes = root.findall(".//Material") or [root]
    out: list[dict] = []
    for node in nodes:
        name = node.get("Name") or node.get("name") or path.stem
        textures: dict[str, str] = {}
        for tex in node.findall(".//Texture"):
            file_attr = tex.get("File") or tex.get("file")
            if not file_attr:
                continue
            role = classify(file_attr) or (tex.get("Map") or "").lower()
            if role:
                textures[role] = file_attr.replace("\\", "/").lstrip("/")
        out.append({
            "name": name,
            "textures": textures,
            "tintable": bool(textures.get("tint_mask")) or "tint" in name.lower(),
        })
    return out


def _load_image(texture_dir: Path, relative: str):
    """Find a converted PNG for a DDS reference, or return None."""
    candidate = texture_dir / Path(_MIP.sub("", relative)).with_suffix(".png")
    if not candidate.is_file():
        stem = Path(relative).stem
        matches = list(texture_dir.rglob(f"{Path(stem).stem}.png"))
        if not matches:
            return None
        candidate = matches[0]
    try:
        return bpy.data.images.load(str(candidate), check_existing=True)
    except RuntimeError:
        return None


def build_material(descriptor: dict, texture_dir: Path):
    """Create a Blender material from one submaterial descriptor."""
    material = C.make_material(descriptor["name"])
    tree = material.node_tree
    bsdf = tree.nodes.get("Principled BSDF")
    if bsdf is None:
        return material
    textures = descriptor.get("textures", {})

    def image_node(relative: str, non_color: bool):
        image = _load_image(texture_dir, relative)
        if image is None:
            return None
        node = tree.nodes.new("ShaderNodeTexImage")
        node.image = image
        if non_color:
            node.image.colorspace_settings.name = "Non-Color"
        return node

    if "base_color" in textures:
        node = image_node(textures["base_color"], non_color=False)
        if node:
            tree.links.new(node.outputs["Color"], C.bsdf_input(bsdf, "base_color"))

    if "normal_gloss" in textures:
        node = image_node(textures["normal_gloss"], non_color=True)
        if node:
            # DirectX-style normal map: invert green.
            separate = tree.nodes.new("ShaderNodeSeparateColor")
            combine = tree.nodes.new("ShaderNodeCombineColor")
            invert = tree.nodes.new("ShaderNodeMath")
            invert.operation = "SUBTRACT"
            invert.inputs[0].default_value = 1.0
            normal_map = tree.nodes.new("ShaderNodeNormalMap")

            tree.links.new(node.outputs["Color"], separate.inputs[0])
            tree.links.new(separate.outputs[1], invert.inputs[1])
            tree.links.new(separate.outputs[0], combine.inputs[0])
            tree.links.new(invert.outputs[0], combine.inputs[1])
            tree.links.new(separate.outputs[2], combine.inputs[2])
            tree.links.new(combine.outputs[0], normal_map.inputs["Color"])
            tree.links.new(normal_map.outputs["Normal"], C.bsdf_input(bsdf, "normal"))

            # Gloss lives in alpha: roughness = 1 - gloss.
            gloss_invert = tree.nodes.new("ShaderNodeMath")
            gloss_invert.operation = "SUBTRACT"
            gloss_invert.inputs[0].default_value = 1.0
            tree.links.new(node.outputs["Alpha"], gloss_invert.inputs[1])
            tree.links.new(gloss_invert.outputs[0], C.bsdf_input(bsdf, "roughness"))

    if "specular" in textures:
        node = image_node(textures["specular"], non_color=True)
        socket = C.bsdf_input(bsdf, "specular")
        if node and socket:
            # Approximation: drive scalar specular from the spec map's luminance.
            luminance = tree.nodes.new("ShaderNodeRGBToBW")
            tree.links.new(node.outputs["Color"], luminance.inputs[0])
            tree.links.new(luminance.outputs[0], socket)

    if "emissive" in textures:
        node = image_node(textures["emissive"], non_color=False)
        socket = C.bsdf_input(bsdf, "emission")
        if node and socket:
            tree.links.new(node.outputs["Color"], socket)
            C.set_bsdf(bsdf, "emission_strength", 1.0)

    return material


def apply_materials(obj, mtl_path: Path, texture_dir: Path) -> list[dict]:
    """Replace an object's material slots from a .mtl. Returns slot metadata."""
    descriptors = parse_mtl(mtl_path)
    if not descriptors:
        return []
    obj.data.materials.clear()
    meta: list[dict] = []
    for i, descriptor in enumerate(descriptors):
        if descriptor["tintable"]:
            descriptor = {**descriptor, "name": f"tint_{i}"}
        obj.data.materials.append(build_material(descriptor, texture_dir))
        meta.append({
            "name": descriptor["name"],
            "tintable": descriptor["tintable"],
            "textures": descriptor.get("textures", {}),
        })
    return meta
