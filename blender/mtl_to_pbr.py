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

# CryEngine addresses textures by numbered slot, not by role name. VERIFIED in
# build 1.0.191.55227 against LayerBlend_V2 armor materials.
TEX_SLOTS = {
    "texslot1": "base_color",
    "texslot2": "specular",
    "texslot3": "normal",  # "_ddn" / "_ddna"
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

# Filename suffixes, used when a material names no slot.
CHANNEL_SUFFIXES = {
    "_diff": "base_color",
    "_ddna": "normal",
    "_ddn": "normal",
    "_spec": "specular",
    "_disp": "displacement",
    "_blend": "blend",
    "_wear": "wear",
    "_hal": "hal",
    "_decal": "decal",
    "_mask": "tint_mask",
    "_emis": "emissive",
}

_MIP = re.compile(r"\.(tif|dds)(\.\d+[ab]?)?$", re.IGNORECASE)


def classify(texture_path: str, slot: str | None = None) -> str | None:
    """Role for a texture, preferring the explicit slot over the filename."""
    if slot:
        role = TEX_SLOTS.get(slot.strip().lower())
        if role:
            return role
    stem = _MIP.sub("", Path(texture_path).name.lower())
    for suffix, role in CHANNEL_SUFFIXES.items():
        if stem.endswith(suffix):
            return role
    return None


def _color(value: str | None, default=(0.6, 0.6, 0.62)):
    """A CryEngine "r,g,b" attribute (0-1 floats) to a tuple."""
    if not value:
        return default
    try:
        parts = tuple(float(p) for p in value.split(","))
    except ValueError:
        return default
    return parts if len(parts) == 3 else default


def _hex_to_rgb(value: str | None):
    if not isinstance(value, str) or not value.startswith("#") or len(value) != 7:
        return None
    return tuple(int(value[i : i + 2], 16) / 255.0 for i in (1, 3, 5))


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
            role = classify(file_attr, tex.get("Map")) or (tex.get("Map") or "").lower()
            if role:
                textures[role] = file_attr.replace("\\", "/").lstrip("/")
        out.append({
            "name": name,
            "shader": node.get("Shader") or "",
            "textures": textures,
            "diffuse": _color(node.get("Diffuse")),
            "specular": _color(node.get("Specular"), (0.0, 0.0, 0.0)),
            "shininess": float(node.get("Shininess") or 10.0),
            # LayerBlend_V2 armor ships no albedo; its colour comes from the
            # item's tint palette, applied by the caller.
            "tintable": node.get("Shader") == "LayerBlend_V2"
            or bool(textures.get("tint_mask"))
            or "tint" in name.lower(),
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


def build_material(descriptor: dict, texture_dir: Path, tint: dict | None = None):
    """Create a Blender material from one submaterial descriptor.

    Armor here uses the ``LayerBlend_V2`` shader, which ships **no albedo
    texture**: base colour comes from the item's tint palette, composited over
    three layers. v1 takes the first layer's tint colour, its specular colour
    and its glossiness, and adds the real normal map. The wear, blend and
    "hal" layer masks are carried in materials.json but not yet composited.
    """
    layers = (tint or {}).get("layers") or []
    layer = layers[0] if layers else {}
    base = _hex_to_rgb(layer.get("color")) or descriptor.get("diffuse") or (0.6, 0.6, 0.62)
    glossiness = layer.get("glossiness")
    if glossiness is None:
        # Shininess is 0-255 in CryEngine materials.
        glossiness = min(max(descriptor.get("shininess", 10.0) / 255.0, 0.0), 1.0)
    roughness = 1.0 - float(glossiness)
    # A fully glossy palette entry still is not a mirror; keep some roughness.
    roughness = min(max(roughness, 0.18), 0.95)

    material = C.make_material(
        descriptor["name"], color=(*base, 1.0), roughness=roughness, metallic=0.0
    )
    tree = material.node_tree
    bsdf = tree.nodes.get("Principled BSDF")
    if bsdf is None:
        return material
    textures = descriptor.get("textures", {})

    spec_rgb = _hex_to_rgb(layer.get("spec"))
    if spec_rgb:
        # Bright specular colour reads as metal in a PBR approximation.
        C.set_bsdf(bsdf, "metallic", min(max(sum(spec_rgb) / 3.0 * 1.4, 0.0), 1.0))

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

    if "normal" in textures:
        node = image_node(textures["normal"], non_color=True)
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

    if "wear" in textures:
        # Wear darkens and roughens edges; a cheap stand-in for the real blend.
        node = image_node(textures["wear"], non_color=True)
        socket = C.bsdf_input(bsdf, "roughness")
        if node and socket:
            mix = tree.nodes.new("ShaderNodeMath")
            mix.operation = "MULTIPLY_ADD"
            mix.inputs[1].default_value = 0.35
            mix.inputs[2].default_value = roughness
            luminance = tree.nodes.new("ShaderNodeRGBToBW")
            tree.links.new(node.outputs["Color"], luminance.inputs[0])
            tree.links.new(luminance.outputs[0], mix.inputs[0])
            tree.links.new(mix.outputs[0], socket)

    if "emissive" in textures:
        node = image_node(textures["emissive"], non_color=False)
        socket = C.bsdf_input(bsdf, "emission")
        if node and socket:
            tree.links.new(node.outputs["Color"], socket)
            C.set_bsdf(bsdf, "emission_strength", 1.0)

    return material


def apply_materials(
    obj, mtl_path: Path, texture_dir: Path, tint: dict | None = None
) -> list[dict]:
    """Replace an object's material slots from a .mtl. Returns slot metadata.

    Submaterial order in the .mtl matches the mesh's material slot order, so a
    mesh with several slots (shell, interior, metal, ...) keeps them distinct.
    """
    descriptors = parse_mtl(mtl_path)
    if not descriptors:
        return []
    obj.data.materials.clear()
    meta: list[dict] = []
    for descriptor in descriptors:
        obj.data.materials.append(build_material(descriptor, texture_dir, tint))
        meta.append({
            "name": descriptor["name"],
            "tintable": descriptor["tintable"],
            "shader": descriptor.get("shader", ""),
            "textures": descriptor.get("textures", {}),
        })
    return meta
