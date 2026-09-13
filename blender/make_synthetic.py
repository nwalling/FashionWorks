"""Generate a synthetic rig and armor set so the viewer runs without game data.

DEVELOPMENT STAND-IN. The meshes are primitives, not Star Citizen assets. The
point is that everything downstream of extraction — the canonical armature, the
per-item GLB export, bone order, the skinned/socket split, the manifest schema
and the viewer's rebinding — is exercised for real, so viewer and pipeline work
is not blocked on having a Data.p4k.

Run: blender -b -P blender/make_synthetic.py -- --out-dir data/out --skeleton male
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import bpy  # type: ignore[import-not-found]
from mathutils import Vector  # type: ignore[import-not-found]

import _common as C

# ---------------------------------------------------------------------------
# Canonical skeleton
# ---------------------------------------------------------------------------
# (name, head, tail, parent). Placeholder names — the real StarEngine bone names
# come from the Task 1 spike and replace these wholesale.

BONES: list[tuple[str, tuple[float, float, float], tuple[float, float, float], str | None]] = [
    ("root",        (0.00, 0.00, 0.00), (0.00, 0.00, 0.08), None),
    ("pelvis",      (0.00, 0.00, 0.95), (0.00, 0.00, 1.05), "root"),
    ("spine_01",    (0.00, 0.00, 1.05), (0.00, 0.00, 1.20), "pelvis"),
    ("spine_02",    (0.00, 0.00, 1.20), (0.00, 0.00, 1.35), "spine_01"),
    ("spine_03",    (0.00, 0.00, 1.35), (0.00, 0.00, 1.48), "spine_02"),
    ("neck",        (0.00, 0.00, 1.48), (0.00, 0.00, 1.58), "spine_03"),
    ("head",        (0.00, 0.00, 1.58), (0.00, 0.00, 1.76), "neck"),
    ("clavicle_l",  (0.03, 0.00, 1.45), (0.17, 0.00, 1.45), "spine_03"),
    ("upperarm_l",  (0.17, 0.00, 1.45), (0.17, 0.00, 1.17), "clavicle_l"),
    ("lowerarm_l",  (0.17, 0.00, 1.17), (0.17, 0.00, 0.92), "upperarm_l"),
    ("hand_l",      (0.17, 0.00, 0.92), (0.17, 0.00, 0.80), "lowerarm_l"),
    ("clavicle_r",  (-0.03, 0.00, 1.45), (-0.17, 0.00, 1.45), "spine_03"),
    ("upperarm_r",  (-0.17, 0.00, 1.45), (-0.17, 0.00, 1.17), "clavicle_r"),
    ("lowerarm_r",  (-0.17, 0.00, 1.17), (-0.17, 0.00, 0.92), "upperarm_r"),
    ("hand_r",      (-0.17, 0.00, 0.92), (-0.17, 0.00, 0.80), "lowerarm_r"),
    ("thigh_l",     (0.10, 0.00, 0.95), (0.10, 0.00, 0.53), "pelvis"),
    ("calf_l",      (0.10, 0.00, 0.53), (0.10, 0.00, 0.12), "thigh_l"),
    ("foot_l",      (0.10, 0.00, 0.12), (0.10, -0.18, 0.04), "calf_l"),
    ("thigh_r",     (-0.10, 0.00, 0.95), (-0.10, 0.00, 0.53), "pelvis"),
    ("calf_r",      (-0.10, 0.00, 0.53), (-0.10, 0.00, 0.12), "thigh_r"),
    ("foot_r",      (-0.10, 0.00, 0.12), (-0.10, -0.18, 0.04), "calf_r"),
    # Attachment points for rigid (socket-bound) pieces.
    ("head_socket", (0.00, 0.00, 1.66), (0.00, 0.00, 1.72), "head"),
    ("back_socket", (0.00, 0.12, 1.34), (0.00, 0.18, 1.34), "spine_03"),
]

SOCKETS = ["head_socket", "back_socket"]

# ---------------------------------------------------------------------------
# Piece templates: slot -> segments of (bone, center, size)
# ---------------------------------------------------------------------------

Segment = tuple[str, tuple[float, float, float], tuple[float, float, float]]

PIECES: dict[str, list[Segment]] = {
    "helmet": [
        ("head", (0.00, 0.00, 1.67), (0.24, 0.26, 0.28)),
    ],
    "torso": [
        ("spine_01", (0.00, 0.00, 1.12), (0.36, 0.24, 0.16)),
        ("spine_02", (0.00, 0.00, 1.28), (0.40, 0.26, 0.16)),
        ("spine_03", (0.00, 0.00, 1.42), (0.44, 0.27, 0.14)),
    ],
    "arms": [
        ("upperarm_l", (0.17, 0.00, 1.31), (0.13, 0.13, 0.30)),
        ("lowerarm_l", (0.17, 0.00, 1.04), (0.11, 0.11, 0.26)),
        ("upperarm_r", (-0.17, 0.00, 1.31), (0.13, 0.13, 0.30)),
        ("lowerarm_r", (-0.17, 0.00, 1.04), (0.11, 0.11, 0.26)),
    ],
    "legs": [
        ("thigh_l", (0.10, 0.00, 0.74), (0.17, 0.17, 0.44)),
        ("calf_l", (0.10, 0.00, 0.32), (0.14, 0.14, 0.42)),
        ("thigh_r", (-0.10, 0.00, 0.74), (0.17, 0.17, 0.44)),
        ("calf_r", (-0.10, 0.00, 0.32), (0.14, 0.14, 0.42)),
    ],
    "undersuit": [
        ("pelvis", (0.00, 0.00, 1.00), (0.30, 0.20, 0.16)),
        ("spine_02", (0.00, 0.00, 1.26), (0.32, 0.20, 0.30)),
        ("upperarm_l", (0.17, 0.00, 1.31), (0.10, 0.10, 0.30)),
        ("lowerarm_l", (0.17, 0.00, 1.04), (0.09, 0.09, 0.26)),
        ("upperarm_r", (-0.17, 0.00, 1.31), (0.10, 0.10, 0.30)),
        ("lowerarm_r", (-0.17, 0.00, 1.04), (0.09, 0.09, 0.26)),
        ("thigh_l", (0.10, 0.00, 0.74), (0.14, 0.14, 0.44)),
        ("calf_l", (0.10, 0.00, 0.32), (0.11, 0.11, 0.42)),
        ("thigh_r", (-0.10, 0.00, 0.74), (0.14, 0.14, 0.44)),
        ("calf_r", (-0.10, 0.00, 0.32), (0.11, 0.11, 0.42)),
        ("neck", (0.00, 0.00, 1.52), (0.13, 0.13, 0.10)),
    ],
    # Rigid piece: bound to a socket, not skinned.
    "backpack": [
        ("back_socket", (0.00, 0.22, 1.32), (0.30, 0.18, 0.34)),
    ],
}

SETS = [
    {"key": "aeg_pathfinder", "mfg": ("AEG", "Aegis Dynamics"), "weight": "light",
     "scale": 1.00, "colors": {"slate": (0.28, 0.31, 0.35, 1), "sand": (0.68, 0.60, 0.44, 1)}},
    {"key": "rsi_bastion", "mfg": ("RSI", "Roberts Space Industries"), "weight": "medium",
     "scale": 1.06, "colors": {"steel": (0.42, 0.44, 0.47, 1), "olive": (0.31, 0.35, 0.24, 1)}},
    {"key": "cds_bulwark", "mfg": ("CDS", "Clark Defense Systems"), "weight": "heavy",
     "scale": 1.13, "colors": {"charcoal": (0.16, 0.17, 0.19, 1), "rust": (0.44, 0.24, 0.16, 1)}},
]

SLOT_ORDER = ["helmet", "torso", "arms", "legs", "backpack", "undersuit"]


# ---------------------------------------------------------------------------
# Build helpers
# ---------------------------------------------------------------------------


def build_armature(name: str):
    """Create the canonical armature. Bone creation order fixes glTF joint order."""
    armature_data = bpy.data.armatures.new(f"{name}_armature")
    obj = bpy.data.objects.new(f"{name}_rig", armature_data)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")

    created = {}
    for bone_name, head, tail, _parent in BONES:
        bone = armature_data.edit_bones.new(bone_name)
        bone.head = Vector(head)
        bone.tail = Vector(tail)
        bone.use_deform = True
        created[bone_name] = bone
    for bone_name, _head, _tail, parent in BONES:
        if parent:
            created[bone_name].parent = created[parent]

    bpy.ops.object.mode_set(mode="OBJECT")
    return obj


_BOX_FACES = [
    (0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1),
    (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3),
]


def build_mesh(name: str, segments: list[Segment], *, scale: float, origin=(0.0, 0.0, 0.0)):
    """Build a boxes-per-bone mesh. Returns (object, {bone: [vertex indices]})."""
    verts: list[tuple[float, float, float]] = []
    faces: list[tuple[int, ...]] = []
    groups: dict[str, list[int]] = {}

    for bone, center, size in segments:
        base = len(verts)
        cx, cy, cz = center
        sx, sy, sz = (v * scale for v in size)
        for i, dx in enumerate((-1, 1)):
            for j, dy in enumerate((-1, 1)):
                for k, dz in enumerate((-1, 1)):
                    assert (i, j, k) == (i, j, k)
                    verts.append(
                        (cx + dx * sx / 2 - origin[0],
                         cy + dy * sy / 2 - origin[1],
                         cz + dz * sz / 2 - origin[2])
                    )
        faces.extend(tuple(base + idx for idx in face) for face in _BOX_FACES)
        groups.setdefault(bone, []).extend(range(base, base + 8))

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj, groups


def skin(obj, groups: dict[str, list[int]], armature) -> None:
    """Bind by vertex group name, never by automatic weights (PLAN.md §4.3)."""
    for bone, indices in groups.items():
        group = obj.vertex_groups.new(name=bone)
        group.add(indices, 1.0, "REPLACE")
    modifier = obj.modifiers.new("Armature", "ARMATURE")
    modifier.object = armature
    obj.parent = armature


def skeleton_json(armature) -> dict:
    """Ordered bone names + parent indices + rest pose, for the viewer."""
    names = [b.name for b in armature.data.bones]
    index = {name: i for i, name in enumerate(names)}
    return {
        "bones": names,
        "parents": [
            index[b.parent.name] if b.parent else -1 for b in armature.data.bones
        ],
        "rest": [list(b.head_local) + list(b.tail_local) for b in armature.data.bones],
        "sockets": SOCKETS,
    }


def socket_rest(armature, socket: str) -> list[float]:
    bone = armature.data.bones.get(socket)
    return list(bone.head_local) if bone else [0.0, 0.0, 0.0]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    ap = C.parser("Generate a synthetic rig, armor set and item descriptors.")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--skeleton", default="male")
    ap.add_argument("--items", type=int, default=12)
    args = ap.parse_args(C.script_args())

    out_dir = Path(args.out_dir)
    base_dir = out_dir / "base"
    descriptors: list[dict] = []

    # --- base rig + undersuit ------------------------------------------
    C.reset_scene()
    armature = build_armature(args.skeleton)
    undersuit, groups = build_mesh("undersuit", PIECES["undersuit"], scale=0.94)
    undersuit.data.materials.append(
        C.make_material("undersuit", (0.10, 0.11, 0.13, 1), roughness=0.75)
    )
    skin(undersuit, groups, armature)

    C.write_json(base_dir / f"{args.skeleton}.skeleton.json", skeleton_json(armature))
    C.export_glb(base_dir / f"{args.skeleton}.glb")
    print(f"[synth] base rig -> {base_dir / f'{args.skeleton}.glb'}")

    # --- items ----------------------------------------------------------
    budget = max(1, args.items)
    made = 0
    for set_def in SETS:
        for color_name, color in set_def["colors"].items():
            for slot in SLOT_ORDER:
                if slot == "undersuit":
                    continue
                if made >= budget:
                    break
                class_name = f"{set_def['key']}_{slot}_{color_name}"
                item_id = f"synth-{class_name}"
                bind_mode = "socket" if slot == "backpack" else "skinned"

                C.reset_scene()
                rig = build_armature(args.skeleton)
                origin = (0.0, 0.0, 0.0)
                socket = None
                if bind_mode == "socket":
                    socket = "back_socket"
                    origin = tuple(socket_rest(rig, socket))

                mesh_obj, mesh_groups = build_mesh(
                    class_name, PIECES[slot], scale=set_def["scale"], origin=origin
                )
                mesh_obj.data.materials.append(
                    C.make_material(f"{class_name}_shell", color, roughness=0.45, metallic=0.25)
                )

                if bind_mode == "skinned":
                    skin(mesh_obj, mesh_groups, rig)
                else:
                    # Rigid piece: drop the armature entirely and export the mesh
                    # with its origin at the socket rest transform.
                    bpy.data.objects.remove(rig, do_unlink=True)

                item_dir = out_dir / "items" / item_id
                C.export_glb(item_dir / "item.glb")
                C.write_json(
                    item_dir / "materials.json",
                    {
                        "slots": [
                            {
                                "name": f"{class_name}_shell",
                                "tintable": True,
                                "base_color": list(color),
                            }
                        ]
                    },
                )

                descriptors.append({
                    "id": item_id,
                    "class_name": class_name,
                    "name": (
                        f"{set_def['mfg'][0]} "
                        f"{set_def['key'].split('_')[1].title()} "
                        f"{slot.title()} ({color_name.title()})"
                    ),
                    "slot": slot,
                    "weight_class": set_def["weight"],
                    "manufacturer": {"code": set_def["mfg"][0], "name": set_def["mfg"][1]},
                    "set": set_def["key"],
                    "bind_mode": bind_mode,
                    "socket": socket,
                    "glb": f"items/{item_id}/item.glb",
                    "color": list(color),
                    "flags": ["synthetic"],
                })
                made += 1

    C.write_json(
        out_dir / "synth-items.json",
        {
            "skeleton": args.skeleton,
            "sockets": SOCKETS,
            "base_glb": f"base/{args.skeleton}.glb",
            "items": descriptors,
        },
    )
    print(f"[synth] {len(descriptors)} items -> {out_dir / 'synth-items.json'}")


if __name__ == "__main__":
    main()
