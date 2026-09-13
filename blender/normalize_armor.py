"""Normalize converted armor into per-item GLBs (PLAN.md §4.3).

Processes a batch spec written by ``sc_extract.pipeline`` so one Blender start
covers many items. Per item:

1. append the cached canonical armature, so joint order is identical everywhere
2. import the converted geometry
3. rebind meshes to the canonical armature **by vertex-group name**
4. map the .mtl to Principled BSDF
5. clean up, then export item.glb and materials.json

Why the rebind is the whole point (verified, build 1.0.191.55227): a converted
armor mesh carries only the bones it references, in its own order. One torso
exported 41 joints of which 16 exist in the 220-bone base skeleton; the other 25
are ``*_override`` equipment attachment points the piece introduces, and they
carry **0.0000%** of the vertex weight. Blender binds vertex groups to bones by
name, so re-exporting against the canonical armature both drops the strays and
restores a single shared joint order, which is what lets the viewer bind an item
onto the base skeleton without rewriting buffers.

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
    """Append the cached canonical armature built by build_base_rig.py."""
    blend = C.abspath(base_dir / f"{skeleton}.blend")
    if not blend.is_file():
        return None
    with bpy.data.libraries.load(str(blend), link=False) as (src, dst):
        wanted = [n for n in src.objects if n.endswith("_rig")]
        dst.objects = wanted or list(src.objects)
    for obj in dst.objects:
        if obj is not None and obj.type == "ARMATURE":
            bpy.context.collection.objects.link(obj)
    return find_armature()


def rebind(mesh, armature, *, log: list[str]) -> None:
    """Parent a mesh to the canonical armature, matching vertex groups by name.

    Groups with no matching bone fall into two kinds:

    * equipment attachment points (``*_override``) which carry no weight, and
    * simulation chains (``CC_fabric_*``, ``*_Skel_Sim``) which do.

    Dropping the second kind outright leaves those vertices unweighted, and
    Blender's exporter then invents a ``neutral_bone`` for them, pinning that
    part of the mesh to the origin. On one torso that was 1080 of 30901
    vertices. So stray weight is moved onto the piece's dominant bone first,
    which keeps the cloth travelling with the body instead of being left behind.
    """
    bone_names = {b.name for b in armature.data.bones}
    groups = mesh.vertex_groups
    unknown = {g.index: g.name for g in groups if g.name not in bone_names}

    if unknown:
        totals: dict[int, float] = {}
        for vertex in mesh.data.vertices:
            for entry in vertex.groups:
                if entry.group not in unknown:
                    totals[entry.group] = totals.get(entry.group, 0.0) + entry.weight

        if totals:
            fallback = groups[max(totals, key=lambda k: totals[k])]
            moved = 0
            for vertex in mesh.data.vertices:
                stray = sum(e.weight for e in vertex.groups if e.group in unknown)
                if stray > 0.0:
                    fallback.add([vertex.index], stray, "ADD")
                    moved += 1
            if moved:
                log.append(f"moved stray weight on {moved} vertices to {fallback.name}")
        else:
            log.append("no valid vertex groups; mesh will export unweighted")

        log.append(
            f"{len(unknown)} group(s) absent from the rig, e.g. {sorted(unknown.values())[:3]}"
        )
        for name in list(unknown.values()):
            groups.remove(groups[name])

    for modifier in list(mesh.modifiers):
        if modifier.type == "ARMATURE":
            mesh.modifiers.remove(modifier)
    modifier = mesh.modifiers.new("Armature", "ARMATURE")
    modifier.object = armature
    mesh.parent = armature
    mesh.matrix_parent_inverse.identity()


def cleanup(mesh) -> None:
    """Strip vertex colours and extra UVs, limit to 4 influences, triangulate."""
    dropped = C.strip_vertex_colors(mesh)
    if dropped:
        print(f"[normalize] dropped {dropped} colour attribute(s) from {mesh.name}")

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


def socket_origin(armature, socket: str | None):
    if not socket or armature is None:
        return (0.0, 0.0, 0.0)
    bone = armature.data.bones.get(socket)
    return tuple(bone.head_local) if bone else (0.0, 0.0, 0.0)


# Collada first, deliberately. VERIFIED (build 1.0.191.55227): cgf-converter's
# glTF output for a .skin carries skin weights, but Blender does not apply its
# inverse bind matrices, so the mesh imports at the wrong height (one arms piece
# landed at Z 2.60-3.21 on a 1.745 m skeleton). The same asset through Collada
# imports at Z 1.15-1.76, which is correct. Collada files are far larger; that
# is the price of a mesh that lands on the body.
CONVERTED_SUFFIXES = (".dae", ".gltf", ".glb")


def find_converted(interim: Path, source: str) -> Path | None:
    """Locate the converted mesh for a P4K source path.

    cgf-converter output is flat in interim/ and named after the source stem.
    """
    stem = Path(source).stem
    for suffix in CONVERTED_SUFFIXES:
        candidate = interim / f"{stem}{suffix}"
        if candidate.is_file():
            return candidate
    for suffix in CONVERTED_SUFFIXES:
        matches = sorted(interim.rglob(f"{stem}{suffix}"))
        if matches:
            return matches[0]
    return None


def process_item(item: dict, spec: dict, *, errors: dict[str, str]) -> None:
    item_id = item["id"]
    out_dir = C.abspath(Path(spec["out_dir"]) / "items" / item_id)
    interim = C.abspath(spec["interim_dir"])
    base_dir = C.abspath(spec["base_dir"])
    raw_dir = C.abspath(spec["raw_dir"])
    texture_dir = raw_dir / "Data"
    notes: list[str] = []
    bind_mode = item.get("bind_mode", "skinned")

    C.reset_scene()
    armature = load_canonical_rig(base_dir, spec["skeleton"])
    if armature is None and bind_mode == "skinned":
        errors[item_id] = f"no canonical rig at {base_dir / (spec['skeleton'] + '.blend')}"
        return
    rig_name = armature.name if armature else None

    imported = 0
    for geometry in item.get("geometry", []):
        converted = find_converted(interim, geometry["source"])
        if converted and import_any(converted):
            imported += 1
        else:
            notes.append(f"no converted mesh for {geometry['source']}")

    if imported == 0:
        errors[item_id] = "no converted geometry found in interim"
        return

    apply_scale_fix(float(spec.get("scale", 1.0)), spec.get("up_axis", "z"))

    # Drop any armature the converter brought along; only the canonical one stays.
    for obj in list(bpy.context.scene.objects):
        if obj.type == "ARMATURE" and obj.name != rig_name:
            bpy.data.objects.remove(obj, do_unlink=True)

    mesh_objects = meshes()
    if not mesh_objects:
        errors[item_id] = "import produced no meshes"
        return

    material_meta: list[dict] = []
    for mesh in mesh_objects:
        for mtl in item.get("materials", []):
            meta = mtl_to_pbr.apply_materials(
                mesh, raw_dir / "Data" / mtl, texture_dir, item.get("tint")
            )
            material_meta.extend(meta)

        if bind_mode == "skinned":
            rebind(mesh, armature, log=notes)
        else:
            origin = socket_origin(armature, item.get("socket"))
            mesh.parent = None
            mesh.location = (-origin[0], -origin[1], -origin[2])
            bpy.context.view_layer.objects.active = mesh
            bpy.ops.object.select_all(action="DESELECT")
            mesh.select_set(True)
            bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)

        cleanup(mesh)

    if bind_mode != "skinned" and armature is not None:
        bpy.data.objects.remove(armature, do_unlink=True)

    C.export_glb(out_dir / "item.glb", draco=bool(spec.get("draco")))
    C.write_json(
        out_dir / "materials.json",
        {"slots": material_meta, "notes": notes, "bind_mode": bind_mode},
    )
    print(f"[normalize] {item_id}: {len(mesh_objects)} mesh(es), {len(material_meta)} material(s)")
    for note in notes:
        print(f"[normalize]   {note}")


def main() -> None:
    ap = C.parser("Normalize a batch of armor items into per-item GLBs.")
    ap.add_argument("--spec", required=True, help="batch spec JSON from sc_extract.pipeline")
    args = ap.parse_args(C.script_args())

    spec = json.loads(C.abspath(args.spec).read_text())
    errors: dict[str, str] = {}
    for item in spec.get("items", []):
        try:
            process_item(item, spec, errors=errors)
        except Exception as exc:  # noqa: BLE001 - one bad item must not kill the batch
            errors[item["id"]] = repr(exc)
            print(f"[normalize] FAILED {item['id']}: {exc!r}")

    if errors:
        C.write_json(
            C.abspath(spec["interim_dir"]) / f"{Path(args.spec).stem}.errors.json", errors
        )
    print(f"[normalize] batch done: {len(spec.get('items', []))} items, {len(errors)} failed")


if __name__ == "__main__":
    main()
