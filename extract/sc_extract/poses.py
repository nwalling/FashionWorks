"""Retarget poses out of the game's own animation data.

Star Citizen keeps character animation in CryEngine ``.dba`` databases named by
the skeleton's ``.chrparams``. For a bare-handed human they sit under
``Animations/Characters/Human/<skeleton>/weapons/no_weapon/locomotion/``.

StarBreaker parses both the ``.chr`` skeleton and the animation formats but
exposes neither on its CLI, so ``tools/anim-dump`` is a small shim over its
``starbreaker-3d`` crate.

**Why this is a retarget and not a copy.** A clip stores absolute *local*
rotations in the animation rig's own bone frames. Our skeleton reached glTF via
cgf-converter, Collada, Blender and the glTF exporter, and its local frames no
longer match, so applying those rotations directly lays the character on its
back.

Absolute *world* orientation does not transfer either: it only works where the
two rigs' bone axes happen to agree, which they do for the spine and legs and
do not for the arms, whose bind differs. Arms ended up pointing at the ceiling.

What does transfer is the **delta from each rig's own bind pose**:
``delta = world_clip * inverse(world_bind)``. That says "rotate this bone by
however far the animation moves it from rest", which is independent of either
rig's axis conventions. The viewer applies it to our own rest orientation.
Bone lengths stay ours, so the pose adapts to our proportions.

The clip's world space has up along -Y and forward along +Z, which reaches glTF
through a 180 degree rotation about X. That was read off the data: a standing
clip puts the head 1.70 from the floor along -Y, and a crouch puts the knee
forward at +Z.
"""

from __future__ import annotations

import json
import logging
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .catalog import SKELETON_ROOTS
from .config import REPO_ROOT, Settings
from .tools import ToolError

log = logging.getLogger(__name__)

ANIM_DUMP = REPO_ROOT / "tools" / "anim-dump" / "target" / "release" / "anim-dump"
LOCOMOTION = "Animations/Characters/Human/{skeleton}/weapons/no_weapon/locomotion"
SKELETON_CHR = {
    "male": "Objects/Characters/Human/male_v7/export/bhm_skeleton_v7.chr",
    "female": "Objects/Characters/Human/female_v2/export/bhf_skeleton_v2.chr",
}

Quat = tuple[float, float, float, float]  # w, x, y, z
Vec3 = tuple[float, float, float]


@dataclass(frozen=True)
class PoseSpec:
    name: str
    label: str
    database: str
    clip: str


# Chosen for their final frame. Clips suffixed ``_add`` are additive deltas
# layered on a base at runtime and are no use as a standalone pose.
POSES: tuple[PoseSpec, ...] = (
    PoseSpec("idle", "Idle", "stand.dba", "nw_stand_idle_turn360_planted"),
    PoseSpec("crouch", "Crouch", "crouch.dba", "nw_neutral_crouch_idle.caf"),
)


def qmul(a: Quat, b: Quat) -> Quat:
    w1, x1, y1, z1 = a
    w2, x2, y2, z2 = b
    return (
        w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
        w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
        w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
        w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    )


def qrot(q: Quat, v: Vec3) -> Vec3:
    w, x, y, z = q
    vx, vy, vz = v
    tx = 2 * (y * vz - z * vy)
    ty = 2 * (z * vx - x * vz)
    tz = 2 * (x * vy - y * vx)
    return (
        vx + w * tx + (y * tz - z * ty),
        vy + w * ty + (z * tx - x * tz),
        vz + w * tz + (x * ty - y * tx),
    )


def to_gltf_quat(q: Quat) -> list[float]:
    """Clip world space to glTF, as xyzw. A 180 degree turn about X."""
    w, x, y, z = q
    return [x, -y, -z, w]


def to_gltf_position(v: Vec3) -> list[float]:
    x, y, z = v
    return [x, -y, -z]


def run_dump(args: list[str]) -> str:
    if not ANIM_DUMP.is_file():
        raise ToolError(
            "anim-dump is not built. Run:\n"
            "  cargo build --release --manifest-path tools/anim-dump/Cargo.toml\n"
            "It needs the StarBreaker clone that tools/build.sh creates."
        )
    proc = subprocess.run(  # noqa: S603
        [str(ANIM_DUMP), *args], capture_output=True, text=True, check=False
    )
    if proc.returncode != 0:
        raise ToolError(f"anim-dump {args[0]} failed: {proc.stderr.strip()[:300]}")
    return proc.stdout


def qconj(q: Quat) -> Quat:
    w, x, y, z = q
    return (w, -x, -y, -z)


def forward_kinematics(bind: list[dict], clip: dict) -> dict[str, dict]:
    """Per-bone rotation delta from the bind pose, in glTF axes.

    Bones the clip does not animate keep their bind local transform, so their
    delta comes out as identity.
    """
    world_rotation: list[Quat] = [(1.0, 0.0, 0.0, 0.0)] * len(bind)
    world_position: list[Vec3] = [(0.0, 0.0, 0.0)] * len(bind)

    for i, bone in enumerate(bind):
        local_rotation: Quat = tuple(bone["local_rotation"])  # type: ignore[assignment]
        local_position: Vec3 = tuple(bone["local_position"])  # type: ignore[assignment]

        entry = clip.get(bone["name"])
        if entry:
            local_rotation = tuple(entry["rotation"])  # type: ignore[assignment]
            if "position" in entry:
                local_position = tuple(entry["position"])  # type: ignore[assignment]

        parent = bone["parent"]
        if parent is None:
            world_rotation[i] = local_rotation
            world_position[i] = local_position
        else:
            world_rotation[i] = qmul(world_rotation[parent], local_rotation)
            offset = qrot(world_rotation[parent], local_position)
            world_position[i] = tuple(
                world_position[parent][k] + offset[k] for k in range(3)
            )

    out: dict[str, dict] = {}
    for i, bone in enumerate(bind):
        bind_world: Quat = tuple(bone["world_rotation"])  # type: ignore[assignment]
        delta = qmul(world_rotation[i], qconj(bind_world))
        out[bone["name"]] = {
            "delta": to_gltf_quat(delta),
            "position": to_gltf_position(world_position[i]),
        }
    return out


def build(settings: Settings, *, skeleton: str | None = None) -> Path:
    """Write ``data/out/poses.json`` from the game's animation databases."""
    skeleton = skeleton or settings.skeleton
    skeleton_json = settings.base_dir() / f"{skeleton}.skeleton.json"
    if not skeleton_json.is_file():
        raise ToolError(f"no skeleton at {skeleton_json}; run `scx rig` first")
    known = set(json.loads(skeleton_json.read_text()).get("bones", []))

    chr_path = settings.raw_dir / "Data" / SKELETON_CHR[skeleton]
    if not chr_path.is_file():
        raise ToolError(f"no skeleton at {chr_path}; extract it first")
    bind = json.loads(run_dump(["bind", str(chr_path)]))

    directory = SKELETON_ROOTS.get(skeleton, skeleton)
    root = settings.raw_dir / "Data" / LOCOMOTION.format(skeleton=directory)

    out: dict[str, dict] = {}
    for spec in POSES:
        database = root / spec.database
        if not database.is_file():
            raise ToolError(f"no animation database at {database}")
        clip = json.loads(
            run_dump(["pose", str(database), spec.clip, str(skeleton_json)])
        )
        world = forward_kinematics(bind, clip)
        bones = {name: entry for name, entry in world.items() if name in known}
        out[spec.name] = {"label": spec.label, "clip": spec.clip, "bones": bones}
        log.info("%s: %d bones from %s", spec.name, len(bones), spec.clip)

    target = settings.out_dir / "poses.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(out, indent=1) + "\n")
    return target
