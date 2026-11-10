# Poses and animation

How the game's animation clips become poses and emotes: clip frames, retargeting, idles and the emote list.

### Three frames, and the conversion between them is not one conversion

The web port touches data in three different up-axes, and mixing them produces
failures that look like parsing bugs and are not:

| source | up | to three.js |
| --- | --- | --- |
| `.chr` skeleton and `.skin` meshes | **+Z** | -90 degrees about X: `(x, y, z) -> (x, z, -y)` |
| an animation clip's world space | **-Y** | **180 degrees about X**: negate y and z |

Clip-to-archive is itself -90 about X, so clip-to-scene is the two composed --
which is exactly the conversion the pipeline's `to_gltf_quat` applies, and why
"Poses" below already records the clip reaching glTF "through a 180 degree
rotation about X".

Getting it wrong is legible once you know the shape of it. Converting a clip
rotation as if it were a skeleton rotation lays the character **on its back at a
right angle**, every joint otherwise correct. Converting a clip *position* as if
it were a skeleton position stands the whole body up along the wrong axis, with
head, hips, hands and feet all at anatomically perfect distances.

### A clip's local rotations apply directly here, and not in the pipeline

"Poses" below lists "copy the local rotations" as a refuted approach, and it is --
**for the pipeline**, whose rig has been through Collada, Blender and the glTF
exporter, so its bone frames no longer match the ones the clip was authored
against.

The web port builds its armature straight from the same `.chr` the clip targets.
The frames match, and the clip's locals apply directly. The delta retarget is
still there and still correct; it is simply not needed when nothing has
converted the rig in between.

**Rotations only.** The clip's positions are in its own world space and would
import the animation rig's proportions; leaving them alone is what keeps bone
lengths ours.

Measured on `nw_stand_idle_turn360_planted`, against the pipeline's own figures:
head **1.704** against 1.70, hips **1.001** against 1.00, hands at **-0.307 and
+0.302** against ±0.31 at hip height, feet at **0.103**. 145 clip bones, all 145
resolved by CRC32.

### Poses

`scx poses` retargets standing and crouching poses out of the game's own
animation data. Nothing is hand-authored.

**Where the data is.** The skeleton's `.chrparams` names the animation
databases; for a bare-handed human they are under
`Animations/Characters/Human/male_v7/weapons/no_weapon/locomotion/`:
`stand.dba` with 189 clips, `crouch.dba` with 43, plus `hunch` and `prone`.
Useful frames come from `nw_stand_idle_turn360_planted` and
`nw_neutral_crouch_idle`. Clips suffixed `_add` are additive deltas layered at
runtime and are no use alone.

**The standing idle is a turn in place, and does not loop.**
`nw_stand_idle_turn360_planted` is twelve seconds of the root turning 360
degrees in four steps, the legs stepping every three seconds; its last frame
is a fine still pose and nothing more. The rifle's `_raised` idle is the same
shape with a 1.5 s step. The loop to play is the **character customizer's**:
`pu_char_customizer/pu_char_custom_idle_{m,f}_01.caf`, ten seconds of weight
shifting that closes to 0.11 degrees (male) and 0.57 (female). There is no
armed standing idle that is not a turn in place. `cargo run --example
loop_survey` scores a whole `.dba` or `.caf` this way; RENDERING.md Phase 5
has the rest.

**Getting it out.** StarBreaker parses `.chr` skeletons and `.dba`/`.caf`
animation but exposes neither on its CLI, so `tools/anim-dump` is a small shim
over its `starbreaker-3d` crate with two commands: `bind` dumps a skeleton's
bind pose, `pose` dumps a clip's final frame. 145 animated bones, every name
resolved by CRC32 against our skeleton.

**Why it is a retarget.** Three approaches, two of which fail:

1. *Copy the local rotations.* Fails. A clip stores absolute local rotations in
   the animation rig's bone frames; ours no longer match after Collada, Blender
   and the glTF exporter. The character ends up on its back. No axis permutation
   fixes this, and seven were tried.
2. *Copy the world orientations*, obtained by running forward kinematics over
   the `.chr` hierarchy. Closer, and the spine and legs land correctly, but the
   arms point at the ceiling: absolute orientation only transfers where the two
   rigs' bone axes agree, and for arms they do not.
3. *Transfer the delta from each rig's own bind pose*, `world_clip *
   inverse(world_bind)`, applied to our rest orientation. This works, because
   "rotate this bone by however far the animation moves it" needs no agreement
   about axes at all. Bone lengths stay ours, so the pose adapts to our
   proportions.

Two details the data dictates. The clip's world space has up along -Y and
forward along +Z, reaching glTF through a 180 degree rotation about X; that was
read off a standing clip putting the head 1.70 above the floor and a crouch
putting the knee forward. And the armature **root is skipped**: it carries the
clip's own world placement, which otherwise drags the whole body a metre
sideways. Feet are then seated on the ground, since the clip is authored against
the game's floor.

Measured result: idle puts the hands at ±0.31 either side at hip height, crouch
drops the head from 1.70 to 0.99 with the knee forward and the foot planted.

One measurement trap: when checking whether a pose differs from rest, capture
the rest from a genuinely unposed skeleton. The viewer applies a pose on load,
so a first attempt captured the posed state as "rest" and reported zero
difference everywhere, which looked like a parsing failure and was not.

### The game's emotes play, from its own list (2026-11-06)

`ANIMATION.md` is the research and the record. The emote list is one record,
`ChatEmoteRecord`, and `Animations/Mannequin/ADB/Players/playerEmoteAnims.adb`
maps its tags to clip sequences. **The ADB is binary CryXML in the archive**
-- a dump made with StarBreaker's extract is text, and reading the archive's
bytes as text finds nothing -- so `catalog::emotes::adb_text` converts it
first. Emote clips bind to our rig with nothing unresolved, play once over
the idle (`EmotePlay`, not the loop, whose seam closing would bend them), and
the floor ones need no rule of their own: seating the feet each frame puts a
seated figure's hips at 0.087 m against the clip's 0.109.
