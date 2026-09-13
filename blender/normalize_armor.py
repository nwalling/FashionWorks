"""Normalize converted armor geometry into per-item GLBs (PLAN.md §4.3).

Processes a batch spec written by ``sc_extract.pipeline`` so one Blender start
covers many items. For each item:

1. load the cached canonical armature, so joint order is identical everywhere
2. import the converted geometry
3. apply the scale / up-axis correction from the verified facts
4. skinned pieces: keep the imported vertex groups, drop the imported armature,
   parent to the canonical one; never use automatic weights
5. rigid pieces: no armature, origin placed at the socket rest transform
6. map the .mtl to Principled BSDF
7. clean up (extra UV maps, 4-influence limit, triangulate)
8. export item.glb and materials.json

Run::

    blender -b -P blender/normalize_armor.py -- --spec data/interim/batch-<id>.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import bpy  # type: ignore[import-not-found]

import _common as C
import mtl_to_pbr
from build_base_rig import IMPORTERS, apply_scale_fix, find_armature, meshes


def import_any(path: Path) -> bool:
    importer = IMPORTERS.get(path.suffix.lower())
    if importer is None or not path.is_file():
        return False
    importer(path)
    return True


def load_canonical_rig(base_dir: Path, skeleton: str):
    """Append the cached canonical armature. Falls back to whatever is present."""
    blend = base_dir / f"{skeleton}.blend"
    if blend.is_file():
        with bpy.data.libraries.load(str(blend), link=False) as (src, dst):
            dst.objects = [n for n in src.objects if n.endswith("_rig")] or src.objects[:1]
        for obj in dst.objects:
            if obj is not None:
                bpy.context.collection.objects.link(obj)
        return find_armature()
    return None


def rebind(mesh, armature, *, log: list[str]) -> None:
    """Parent a mesh to the canonical armature by vertex group name."""
    bone_names = {b.name for b in armature.data.bones}
    unknown = [g.name for g in mesh.vertex_groups if g.name not in bone_names]
    if unknown:
        log.append(f"vertex groups absent from the canonical armature: {sorted(unknown)}")

    for modifier in list(mesh.modifiers):
        if modifier.type == "ARMATURE":
            mesh.modifiers.remove(modifier)
    modifier = mesh.modifiers.new("Armature", "ARMATURE")
    modifier.object = armature
    mesh.parent = armature
    mesh.matrix_parent_inverse.identity()


def cleanup(mesh) -> None:
    """Strip extra UV maps, limit to 4 influences, triangulate."""
    uvs = mesh.data.uv_layers
    while len(uvs) > 1:
        uvs.remove(uvs[-1])

    bpy.context.view_layer.objects.active = mesh
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)

    if mesh.vertex_groups:
        try:
            bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
        except RuntimeError as exc:
            print(f"[normalize] vertex_group_limit_total skipped: {exc}")

    modifier = mesh.modifiers.new("Triangulate", "TRIANGULATE")
    modifier.quad_method = "SHORTEST_DIAGONAL"
    modifier.keep_custom_normals = True


def socket_origin(armature, socket: str | None):
    if not socket or armature is None:
        return (0.0, 0.0, 0.0)
    bone = armature.data.bones.get(socket)
    return tuple(bone.head_local) if bone else (0.0, 0.0, 0.0)


def process_item(item: dict, spec: dict, *, errors: dict[str, str]) -> None:
    item_id = item["id"]
    out_dir = Path(spec["out_dir"]) / "items" / item_id
    interim = Path(spec["interim_dir"])
    base_dir = Path(spec["base_dir"])
    texture_dir = interim / "textures"
    notes: list[str] = []

    C.reset_scene()
    armature = load_canonical_rig(base_dir, spec["skeleton"])
    if armature is None and item.get("bind_mode", "skinned") == "skinned":
        errors[item_id] = f"no canonical rig at {base_dir / (spec['skeleton'] + '.blend')}"
        return

    imported = 0
    for geometry in item.get("geometry", []):
        source = Path(geometry["source"])
        for suffix in (".gltf", ".glb", ".dae"):
            candidate = interim / source.with_suffix(suffix)
            if import_any(candidate):
                imported += 1
                break

    if imported == 0:
        errors[item_id] = "no converted geometry found in interim"
        return

    apply_scale_fix(float(spec.get("scale", 1.0)), spec.get("up_axis", "z"))

    # Remove any armature the converter brought along; only the canonical one stays.
    for obj in list(bpy.context.scene.objects):
        if obj.type == "ARMATURE" and obj is not armature:
            bpy.data.objects.remove(obj, do_unlink=True)

    material_meta: list[dict] = []
    mesh_objects = meshes()
    if not mesh_objects:
        errors[item_id] = "import produced no meshes"
        return

    for mesh in mesh_objects:
        for mtl in item.get("materials", []):
            meta = mtl_to_pbr.apply_materials(mesh, Path(spec["raw_dir"]) / mtl, texture_dir)
            material_meta.extend(meta)

        if item.get("bind_mode", "skinned") == "skinned":
            rebind(mesh, armature, log=notes)
        else:
            origin = socket_origin(armature, item.get("socket"))
            mesh.location = (-origin[0], -origin[1], -origin[2])
            bpy.context.view_layer.objects.active = mesh
            bpy.ops.object.select_all(action="DESELECT")
            mesh.select_set(True)
            bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)

        cleanup(mesh)

    if item.get("bind_mode", "skinned") != "skinned" and armature is not None:
        bpy.data.objects.remove(armature, do_unlink=True)

    C.export_glb(out_dir / "item.glb", draco=bool(spec.get("draco")))
    C.write_json(
        out_dir / "materials.json",
        {"slots": material_meta, "notes": notes, "bind_mode": item.get("bind_mode", "skinned")},
    )
    print(f"[normalize] {item_id}: {len(mesh_objects)} mesh(es), {len(material_meta)} material(s)")
    if notes:
        for note in notes:
            print(f"[normalize] {item_id}: {note}")


def main() -> None:
    ap = C.parser("Normalize a batch of armor items into per-item GLBs.")
    ap.add_argument("--spec", required=True, help="batch spec JSON from sc_extract.pipeline")
    args = ap.parse_args(C.script_args())

    spec = json.loads(Path(args.spec).read_text())
    errors: dict[str, str] = {}
    for item in spec.get("items", []):
        try:
            process_item(item, spec, errors=errors)
        except Exception as exc:  # noqa: BLE001 - one bad item must not kill the batch
            errors[item["id"]] = repr(exc)
            print(f"[normalize] FAILED {item['id']}: {exc!r}")

    if errors:
        C.write_json(Path(spec["interim_dir"]) / f"{Path(args.spec).stem}.errors.json", errors)
    print(f"[normalize] batch done: {len(spec.get('items', []))} items, {len(errors)} failed")


if __name__ == "__main__":
    main()
