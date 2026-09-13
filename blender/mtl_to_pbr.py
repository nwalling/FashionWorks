"""Build Blender materials from descriptors prepared by the pipeline.

Parsing and tint compositing happen in Python before Blender starts, in
``sc_extract.material`` and ``sc_extract.tint``. This module only turns the
resulting descriptors into Principled BSDF node graphs, so nothing here has to
know the ``.mtl`` format.

Armor uses the ``LayerBlend_V2`` shader and ships **no albedo texture**: three
palette layers are composited through the material's blend mask. The pipeline
bakes that into an albedo image plus a packed occlusion/roughness/metallic
image, because glTF cannot carry a node graph.
"""

from __future__ import annotations

from pathlib import Path

import bpy  # type: ignore[import-not-found]

import _common as C


def _load_image(path: str | None, *, non_color: bool):
    if not path:
        return None
    file = Path(path)
    if not file.is_file():
        return None
    try:
        image = bpy.data.images.load(str(file), check_existing=True)
    except RuntimeError:
        return None
    if non_color:
        image.colorspace_settings.name = "Non-Color"
    return image


def build_material(descriptor: dict):
    """Create one Blender material from a prepared descriptor."""
    composed = descriptor.get("composed") or {}
    resolved = descriptor.get("resolved") or {}
    diffuse = descriptor.get("diffuse") or [0.6, 0.6, 0.62]

    material = C.make_material(descriptor.get("name", "material"), color=(*diffuse, 1.0))
    tree = material.node_tree
    bsdf = tree.nodes.get("Principled BSDF")
    if bsdf is None:
        return material

    def image_node(path: str | None, *, non_color: bool):
        image = _load_image(path, non_color=non_color)
        if image is None:
            return None
        node = tree.nodes.new("ShaderNodeTexImage")
        node.image = image
        return node

    # Base colour: the composited palette when there is one, else any albedo
    # the material actually shipped.
    base = image_node(composed.get("base_color") or resolved.get("base_color"), non_color=False)
    if base:
        tree.links.new(base.outputs["Color"], C.bsdf_input(bsdf, "base_color"))

    # Packed occlusion/roughness/metallic, glTF's layout: R unused here, G
    # roughness, B metallic.
    orm = image_node(composed.get("orm"), non_color=True)
    if orm:
        separate = tree.nodes.new("ShaderNodeSeparateColor")
        tree.links.new(orm.outputs["Color"], separate.inputs[0])
        rough = C.bsdf_input(bsdf, "roughness")
        metal = C.bsdf_input(bsdf, "metallic")
        if rough:
            tree.links.new(separate.outputs[1], rough)
        if metal:
            tree.links.new(separate.outputs[2], metal)

    normal = image_node(resolved.get("normal"), non_color=True)
    if normal:
        # DirectX-style normal map: green is inverted.
        separate = tree.nodes.new("ShaderNodeSeparateColor")
        combine = tree.nodes.new("ShaderNodeCombineColor")
        invert = tree.nodes.new("ShaderNodeMath")
        invert.operation = "SUBTRACT"
        invert.inputs[0].default_value = 1.0
        normal_map = tree.nodes.new("ShaderNodeNormalMap")

        tree.links.new(normal.outputs["Color"], separate.inputs[0])
        tree.links.new(separate.outputs[1], invert.inputs[1])
        tree.links.new(separate.outputs[0], combine.inputs[0])
        tree.links.new(invert.outputs[0], combine.inputs[1])
        tree.links.new(separate.outputs[2], combine.inputs[2])
        tree.links.new(combine.outputs[0], normal_map.inputs["Color"])
        tree.links.new(normal_map.outputs["Normal"], C.bsdf_input(bsdf, "normal"))

    emissive = image_node(resolved.get("emissive"), non_color=False)
    if emissive:
        socket = C.bsdf_input(bsdf, "emission")
        if socket:
            tree.links.new(emissive.outputs["Color"], socket)
            C.set_bsdf(bsdf, "emission_strength", 1.0)

    return material


def apply_materials(obj, descriptors: list[dict]) -> list[dict]:
    """Replace an object's material slots. Submaterial order is slot order."""
    if not descriptors:
        return []
    obj.data.materials.clear()
    meta: list[dict] = []
    for descriptor in descriptors:
        obj.data.materials.append(build_material(descriptor))
        meta.append(
            {
                "name": descriptor.get("name"),
                "shader": descriptor.get("shader", ""),
                "tintable": bool(descriptor.get("tintable")),
                "composited": bool(descriptor.get("composed")),
                "textures": sorted((descriptor.get("resolved") or {}).keys()),
            }
        )
    return meta
