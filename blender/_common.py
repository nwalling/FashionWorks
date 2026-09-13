"""Shared helpers for the headless Blender scripts.

Written to run on both Blender 3.3+ and 4.x: anything that changed between
those versions is behind a capability check rather than a version number, so a
point release cannot silently break the batch.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import bpy  # type: ignore[import-not-found]

BLENDER_VERSION = bpy.app.version
IS_4X = BLENDER_VERSION[0] >= 4


def script_args(argv: list[str] | None = None) -> list[str]:
    """Return the arguments after ``--`` that Blender passes to the script."""
    argv = list(sys.argv if argv is None else argv)
    return argv[argv.index("--") + 1 :] if "--" in argv else []


def parser(description: str) -> argparse.ArgumentParser:
    return argparse.ArgumentParser(prog="blender-script", description=description)


def reset_scene() -> None:
    """Empty the scene and purge orphans, so batches cannot leak between items."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for _ in range(3):
        bpy.ops.outliner.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)


def new_collection_scene() -> None:
    """Lighter alternative to a full factory reset: delete every object."""
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)


# ---------------------------------------------------------------------------
# Materials
# ---------------------------------------------------------------------------

# Principled BSDF renamed several inputs in Blender 4.0.
_INPUT_ALIASES = {
    "specular": ("Specular IOR Level", "Specular"),
    "emission": ("Emission Color", "Emission"),
    "emission_strength": ("Emission Strength",),
    "base_color": ("Base Color",),
    "roughness": ("Roughness",),
    "metallic": ("Metallic",),
    "normal": ("Normal",),
    "alpha": ("Alpha",),
}


def bsdf_input(node, role: str):
    """Return a Principled BSDF input socket by role, across Blender versions."""
    for name in _INPUT_ALIASES.get(role, (role,)):
        if name in node.inputs:
            return node.inputs[name]
    return None


def set_bsdf(node, role: str, value) -> bool:
    socket = bsdf_input(node, role)
    if socket is None:
        return False
    socket.default_value = value
    return True


def make_material(name: str, color=(0.6, 0.6, 0.62, 1.0), roughness=0.55, metallic=0.0):
    """Create a Principled BSDF material with the given base values."""
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        set_bsdf(bsdf, "base_color", tuple(color))
        set_bsdf(bsdf, "roughness", roughness)
        set_bsdf(bsdf, "metallic", metallic)
    return material


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


def abspath(path: Path | str) -> Path:
    """Blender's operators reject relative paths, so resolve everything."""
    return Path(path).expanduser().resolve()


def strip_vertex_colors(mesh_obj) -> int:
    """Remove colour attributes from a mesh. Returns how many were dropped.

    CryEngine stores layer-blend masks in vertex colour. glTF multiplies
    ``COLOR_0`` into base colour and three.js honours that, so leaving them in
    renders armor in vivid magenta and yellow instead of its real tint.
    """
    data = mesh_obj.data
    removed = 0
    attributes = getattr(data, "color_attributes", None)  # Blender 3.2+
    if attributes is not None:
        while len(attributes):
            attributes.remove(attributes[0])
            removed += 1
        return removed
    legacy = getattr(data, "vertex_colors", None)
    while legacy and len(legacy):
        legacy.remove(legacy[0])
        removed += 1
    return removed


def export_glb(path: Path, *, draco: bool = False, selected_only: bool = False) -> Path:
    """Export the scene to a .glb with skins, no animations.

    Unsupported keyword arguments are dropped rather than raising, so the same
    call works on 3.3 and 4.x.
    """
    path = abspath(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    kwargs = {
        "filepath": str(path),
        "export_format": "GLB",
        "export_apply": True,
        "export_skins": True,
        "export_animations": False,
        "export_image_format": "AUTO",
        "export_yup": True,
        "use_selection": selected_only,
        "export_draco_mesh_compression_enable": bool(draco),
    }
    supported = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
    filtered = {k: v for k, v in kwargs.items() if k in supported}
    dropped = sorted(set(kwargs) - set(filtered))
    if dropped:
        print(f"[glb] dropped unsupported export args on Blender "
              f"{'.'.join(str(v) for v in BLENDER_VERSION)}: {dropped}")
    bpy.ops.export_scene.gltf(**filtered)
    return path


def write_json(path: Path, data) -> Path:
    path = abspath(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return path
