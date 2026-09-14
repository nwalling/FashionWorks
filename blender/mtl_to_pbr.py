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

    # Packed occlusion/roughness/metallic, glTF's layout: R occlusion, G
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
        _wire_occlusion(tree, separate.outputs[0])

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


def _wire_occlusion(tree, socket) -> None:
    """Route baked occlusion into the glTF exporter.

    Principled BSDF has no occlusion input, so Blender's glTF exporter reads
    it from a group node that must be named exactly "glTF Material Output"
    with an "Occlusion" input. Without this the red channel of the ORM map is
    written but never reaches the .glb, and the cavity shading recovered from
    the material's _hal control map is silently lost.
    """
    name = "glTF Material Output"
    group = bpy.data.node_groups.get(name)
    if group is None:
        group = bpy.data.node_groups.new(name, "ShaderNodeTree")
        try:
            group.interface.new_socket(
                "Occlusion", in_out="INPUT", socket_type="NodeSocketFloat"
            )
        except AttributeError:  # Blender < 4.0
            group.inputs.new("NodeSocketFloat", "Occlusion")
        group.nodes.new("NodeGroupInput")
    node = tree.nodes.new("ShaderNodeGroup")
    node.node_tree = group
    node.name = node.label = name
    tree.links.new(socket, node.inputs["Occlusion"])


def _slot_for(obj, name: str) -> int | None:
    """Index of the imported material slot a submaterial belongs to.

    Collada names each slot ``<mtl stem>_mtl_<submaterial>``, so the
    submaterial name is a suffix. Matching on it survives any difference
    between the order the .mtl lists submaterials in and the order the
    exporter wrote the triangle groups.
    """
    wanted = (name or "").strip().lower()
    if not wanted:
        return None
    slots = [(m.name or "").strip().lower() for m in obj.data.materials]
    for index, slot in enumerate(slots):
        if slot.endswith("_mtl_" + wanted) or slot == wanted:
            return index
    for index, slot in enumerate(slots):
        if wanted and wanted in slot:
            return index
    return None


def apply_materials(obj, descriptors: list[dict]) -> list[dict]:
    """Replace an object's material slots, keeping each face on its own slot.

    This used to call ``obj.data.materials.clear()`` and append. That silently
    reset every polygon's ``material_index`` to 0 -- Blender clears the
    assignment along with the slots -- so a mesh imported with ten correctly
    assigned material groups exported as **one** material and the whole piece
    rendered with whatever the first submaterial happened to be. On the Artimex
    arms that was ``fingerarmor_m``, whose base layer is polished anodized
    metal, which is why armour came out chrome instead of matte black. 195 of
    200 sampled items were affected.

    Slots are replaced in place instead, matched by name so a mismatch between
    .mtl order and Collada order cannot mis-assign them.
    """
    if not descriptors:
        return []

    existing = len(obj.data.materials)

    # Name matches first, positional fallback second. Doing it in one pass let
    # an unmatched descriptor take a slot by position that a later, correctly
    # named descriptor needed. The Defiance legs are the case: the mesh is CDS
    # with slots pads_straps_m, clips_m, thighs_m, shoes_m, sole_m,
    # thigh_panels_m, glows_m, while the .mtl the record names is a whole-body
    # slaver material listing shoulderpads_m, arm_base_m and the rest in
    # between. shoulderpads_m grabbed the clips_m slot, arm_base_m grabbed
    # thighs_m, and by the time the real thighs_m descriptor came round its
    # slot was gone -- so the gold accent layers were painted onto the wrong
    # parts, or onto no part at all.
    assigned: dict[int, dict] = {}
    leftover: list[dict] = []
    for descriptor in descriptors:
        index = _slot_for(obj, descriptor.get("name", ""))
        if index is None or index in assigned:
            leftover.append(descriptor)
        else:
            assigned[index] = descriptor

    free = [i for i in range(existing) if i not in assigned]
    for descriptor in leftover:
        if free:
            assigned[free.pop(0)] = descriptor
        else:
            assigned[len(assigned) + existing] = descriptor

    meta: list[dict] = []
    for index in sorted(assigned):
        descriptor = assigned[index]
        material = build_material(descriptor)
        if index < len(obj.data.materials):
            obj.data.materials[index] = material
        else:
            obj.data.materials.append(material)
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
