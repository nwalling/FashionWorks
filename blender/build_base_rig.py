"""Build the canonical armature and base character (PLAN.md §4.3).

Imports the converted human ``.chr``, keeps every bone name verbatim, adds the
undersuit mesh, and writes:

* ``<out_dir>/<skeleton>.glb``            base character for the viewer
* ``<out_dir>/<skeleton>.skeleton.json``  ordered bone names, parents, rest pose
* ``<out_dir>/<skeleton>.blend``          cached armature, reused by every
                                          normalize_armor.py run so joint order
                                          is byte-identical across exports

Run::

    blender -b -P blender/build_base_rig.py -- \
        --skeleton male --interim-dir data/interim --out-dir data/out/base
"""

from __future__ import annotations

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


def import_any(path: Path) -> None:
    importer = IMPORTERS.get(path.suffix.lower())
    if importer is None:
        raise SystemExit(f"no importer for {path.suffix} ({path})")
    if not path.is_file():
        raise SystemExit(f"missing input: {path}")
    importer(path)


def find_armature():
    for obj in bpy.context.scene.objects:
        if obj.type == "ARMATURE":
            return obj
    return None


def meshes() -> list:
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def skeleton_json(armature) -> dict:
    bones = list(armature.data.bones)
    index = {b.name: i for i, b in enumerate(bones)}
    return {
        "bones": [b.name for b in bones],
        "parents": [index[b.parent.name] if b.parent else -1 for b in bones],
        "rest": [list(b.head_local) + list(b.tail_local) for b in bones],
        "sockets": [b.name for b in bones if "socket" in b.name.lower()],
    }


def apply_scale_fix(scale: float, up_axis: str) -> None:
    """Apply the scale/up-axis correction discovered in the Task 1 spike.

    Defaults are no-ops: StarEngine units are metres and the glTF exporter
    already handles Z-up to Y-up. Override only when the spike proves otherwise.
    """
    if scale == 1.0 and up_axis == "z":
        return
    bpy.ops.object.select_all(action="SELECT")
    for obj in bpy.context.selected_objects:
        if obj.parent is None:
            obj.scale = (scale, scale, scale)
            if up_axis == "y":
                obj.rotation_euler = (1.5707963, 0.0, 0.0)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)


def main() -> None:
    ap = C.parser("Build the canonical base rig.")
    ap.add_argument("--skeleton", default="male")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--interim-dir", required=True)
    ap.add_argument("--chr", dest="chr_file", default=None,
                    help="converted .chr/.gltf/.dae; default <interim>/<skeleton>.gltf")
    ap.add_argument("--undersuit", default=None, help="optional undersuit mesh to include")
    ap.add_argument("--scale", type=float, default=1.0)
    ap.add_argument("--up-axis", default="z", choices=["z", "y"])
    args = ap.parse_args(C.script_args())

    out_dir = Path(args.out_dir)
    interim = Path(args.interim_dir)
    chr_file = Path(args.chr_file) if args.chr_file else interim / f"{args.skeleton}.gltf"

    C.reset_scene()
    import_any(chr_file)

    armature = find_armature()
    if armature is None:
        raise SystemExit(f"no armature found in {chr_file}; check the Cgf-Converter output")
    armature.name = f"{args.skeleton}_rig"

    if args.undersuit:
        import_any(Path(args.undersuit))
        for mesh in meshes():
            if mesh.parent is None:
                mesh.parent = armature
                if not any(m.type == "ARMATURE" for m in mesh.modifiers):
                    modifier = mesh.modifiers.new("Armature", "ARMATURE")
                    modifier.object = armature

    apply_scale_fix(args.scale, args.up_axis)

    info = skeleton_json(armature)
    C.write_json(out_dir / f"{args.skeleton}.skeleton.json", info)
    print(f"[rig] {len(info['bones'])} bones, {len(info['sockets'])} sockets")

    # Cache the armature so every item export binds against this exact object.
    out_dir.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(out_dir / f"{args.skeleton}.blend"))

    C.export_glb(out_dir / f"{args.skeleton}.glb")
    print(f"[rig] wrote {out_dir / f'{args.skeleton}.glb'}")


if __name__ == "__main__":
    main()
