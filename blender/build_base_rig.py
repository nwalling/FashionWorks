"""Build the canonical armature and base character (PLAN.md §4.3).

Imports the converted human skeleton, keeps every bone name verbatim, optionally
adds an undersuit mesh, and writes:

* ``<out_dir>/<skeleton>.glb``            base character for the viewer
* ``<out_dir>/<skeleton>.skeleton.json``  ordered bone names, parents, rest pose
* ``<out_dir>/<skeleton>.blend``          cached armature, reused by every
                                          normalize_armor.py run

VERIFIED (build 1.0.191.55227): the skeleton must come from **Collada**.
``bhm_skeleton_v7.chr`` converts to 220 named bones under a single ``World``
root through ``cgf-converter -dae``; the same file through glTF collapses to one
node with no bones.

Run::

    blender -b -P blender/build_base_rig.py -- \
        --skeleton male --interim-dir data/interim --out-dir data/out/base \
        --chr data/interim/bhm_skeleton_v7.dae \
        --undersuit data/interim/m_clothing_undersuit_01.gltf
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import bpy  # type: ignore[import-not-found]

import _common as C

IMPORTERS = {
    ".gltf": lambda p: bpy.ops.import_scene.gltf(filepath=str(p)),
    ".glb": lambda p: bpy.ops.import_scene.gltf(filepath=str(p)),
    ".dae": lambda p: bpy.ops.wm.collada_import(filepath=str(p)),
    ".fbx": lambda p: bpy.ops.import_scene.fbx(filepath=str(p)),
}


def import_any(path: Path) -> bool:
    importer = IMPORTERS.get(path.suffix.lower())
    if importer is None:
        print(f"[rig] no importer for {path.suffix} ({path})")
        return False
    if not path.is_file():
        print(f"[rig] missing input: {path}")
        return False
    importer(path)
    return True


def find_armature(exclude: set[str] | None = None):
    exclude = exclude or set()
    best = None
    for obj in bpy.context.scene.objects:
        if obj.type == "ARMATURE" and obj.name not in exclude:
            if best is None or len(obj.data.bones) > len(best.data.bones):
                best = obj
    return best


def meshes() -> list:
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


ATTACHMENT_PATTERN = re.compile(r"(_attach|_override)", re.IGNORECASE)


def graft_attachments(armature, donor) -> list[str]:
    """Copy equipment attachment bones from ``donor`` onto the canonical rig.

    The base skeleton has no attachment points: bones like
    ``backpack_attach_1_override`` are introduced by the worn pieces
    themselves. Verified in build 1.0.191.55227, a CDS undersuit contributes 35
    such bones and **every one** parents to a bone the base skeleton already
    has, so they graft on without inventing a hierarchy.

    Without this there is nowhere for a rigid piece to hang, and backpacks end
    up at the body origin.
    """
    existing = {b.name for b in armature.data.bones}
    wanted = [
        b
        for b in donor.data.bones
        if b.name not in existing
        and ATTACHMENT_PATTERN.search(b.name)
        and b.parent
        and b.parent.name in existing
    ]
    if not wanted:
        return []

    spec = [
        (b.name, b.parent.name, tuple(b.head_local), tuple(b.tail_local)) for b in wanted
    ]

    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.mode_set(mode="EDIT")
    edit_bones = armature.data.edit_bones
    added: list[str] = []
    for name, parent, head, tail in spec:
        bone = edit_bones.new(name)
        bone.head = head
        # A zero-length bone is dropped by Blender, so give it a small tail.
        bone.tail = tail if tail != head else (head[0], head[1] + 0.02, head[2])
        bone.parent = edit_bones[parent]
        bone.use_deform = False
        added.append(name)
    bpy.ops.object.mode_set(mode="OBJECT")
    return added


def skeleton_json(armature) -> dict:
    bones = list(armature.data.bones)
    index = {b.name: i for i, b in enumerate(bones)}
    return {
        "bones": [b.name for b in bones],
        "parents": [index[b.parent.name] if b.parent else -1 for b in bones],
        "rest": [list(b.head_local) + list(b.tail_local) for b in bones],
        "sockets": [b.name for b in bones if ATTACHMENT_PATTERN.search(b.name)],
    }


def apply_scale_fix(scale: float, up_axis: str) -> None:
    """Scale / up-axis correction, no-op by default."""
    if scale == 1.0 and up_axis == "z":
        return
    bpy.ops.object.select_all(action="SELECT")
    for obj in bpy.context.selected_objects:
        if obj.parent is None:
            obj.scale = (scale, scale, scale)
            if up_axis == "y":
                obj.rotation_euler = (1.5707963, 0.0, 0.0)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)


def rebind_to(mesh, armature) -> list[str]:
    """Parent a mesh to ``armature`` by vertex-group name. Returns unknown groups."""
    bone_names = {b.name for b in armature.data.bones}
    unknown = [g.name for g in mesh.vertex_groups if g.name not in bone_names]
    for modifier in list(mesh.modifiers):
        if modifier.type == "ARMATURE":
            mesh.modifiers.remove(modifier)
    modifier = mesh.modifiers.new("Armature", "ARMATURE")
    modifier.object = armature
    mesh.parent = armature
    mesh.matrix_parent_inverse.identity()
    return unknown


def main() -> None:
    ap = C.parser("Build the canonical base rig.")
    ap.add_argument("--skeleton", default="male")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--interim-dir", required=True)
    ap.add_argument("--chr", dest="chr_file", default=None,
                    help="converted skeleton; default <interim>/bhm_skeleton_v7.dae")
    ap.add_argument("--undersuit", default=None, help="optional undersuit mesh to include")
    ap.add_argument("--scale", type=float, default=1.0)
    ap.add_argument("--up-axis", default="z", choices=["z", "y"])
    args = ap.parse_args(C.script_args())

    out_dir = C.abspath(args.out_dir)
    interim = C.abspath(args.interim_dir)
    default_chr = {"male": "bhm_skeleton_v7.dae", "female": "bhf_skeleton_v2.dae"}
    chr_file = C.abspath(args.chr_file) if args.chr_file else interim / default_chr[args.skeleton]

    C.reset_scene()
    if not import_any(chr_file):
        raise SystemExit(f"could not import the skeleton from {chr_file}")

    armature = find_armature()
    if armature is None:
        raise SystemExit(
            f"no armature in {chr_file}. A .chr must be converted with "
            f"`cgf-converter -dae`; glTF loses the bones."
        )
    armature.name = f"{args.skeleton}_rig"
    rig_name = armature.name
    print(f"[rig] {len(armature.data.bones)} bones from {chr_file.name}")

    if args.undersuit:
        before = {o.name for o in bpy.context.scene.objects}
        if import_any(C.abspath(args.undersuit)):
            added = [o for o in bpy.context.scene.objects if o.name not in before]
            for obj in added:
                if obj.type == "MESH":
                    unknown = rebind_to(obj, armature)
                    if unknown:
                        print(f"[rig] undersuit groups not on the rig: {sorted(unknown)[:6]}")
            # Harvest attachment points before discarding the donor rig.
            for obj in added:
                if obj.type == "ARMATURE" and obj.name != rig_name:
                    grafted = graft_attachments(armature, obj)
                    if grafted:
                        print(f"[rig] grafted {len(grafted)} attachment bone(s)")
                    bpy.data.objects.remove(obj, do_unlink=True)

    for mesh in meshes():
        dropped = C.strip_vertex_colors(mesh)
        if dropped:
            print(f"[rig] dropped {dropped} colour attribute(s) from {mesh.name}")

    apply_scale_fix(args.scale, args.up_axis)

    info = skeleton_json(armature)
    C.write_json(out_dir / f"{args.skeleton}.skeleton.json", info)
    print(f"[rig] {len(info['bones'])} bones, {len(info['sockets'])} attachment points")

    out_dir.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(C.abspath(out_dir / f"{args.skeleton}.blend")))

    C.export_glb(out_dir / f"{args.skeleton}.glb")
    print(f"[rig] wrote {out_dir / f'{args.skeleton}.glb'}")


if __name__ == "__main__":
    main()
