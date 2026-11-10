# Rig, skinning and sockets

Skeletons, the canonical armature, coordinate conversion, skin weights, attachment points and socket mounting, for both bodies.

### A socket mount is bone-relative, and `place` is not

Composing `bone_world · locator⁻¹` gives where a prop lands in world space,
which is what you want for *reporting* -- the grips test uses it. Parenting the
prop to that same bone and also giving it that matrix applies the bone **twice**
and floats a backpack a metre above the head, with correct facing and correct
grips, which is a confusing place to be.

What a scene graph wants is `locator⁻¹` alone; the bone supplies the rest, and
posing then carries the prop for free. `socket::mount` and `socket::place` are
separate functions for exactly this reason.

### The canonical armature comes from two donors, and matches bone for bone

The base `.chr` carries 220 bones and **no attachment points at all**. A CDS
undersuit (`m_cds_undersuit_armor_02.skin`) grafts 34, and the slaver core
supplies the one more -- `gadget_attach_1_override` -- that reaches the
pipeline's armature exactly: **255 bones, 35 attachment points, 0 missing and 0
extra** against `data/out/base/male.skeleton.json`.

Donors are a *fixed list*, not an accumulation. Grafting from more pieces
extends the armature rather than reproducing it: the Sunchaser helmet alone
brings three `helm_*_flashlight_override` points the pipeline does not have,
because `build_base_rig` grafts from a single undersuit. A superset is harmless
where binding is by name -- which it is, everywhere -- but it is not the same
rig, so the list stays pinned. `cargo run --example rig_union` reports the
difference by name.

**Four attachment bones sit where Blender's import put them, not where the
archive says**, which extends the `wep_sidearm_attach_override` note above from
one bone to four. Each differs on exactly one axis while the other two match to
four decimals:

| bone | archive | golden | off |
| --- | --- | --- | --- |
| `utility_attach_1_override` | z 0.8718 | z 0.8932 | 21.4 mm |
| `oxyPen_attach_1_override` | z 0.9863 | z 0.9709 | 15.3 mm |
| `medPen_attach_1_override` | z 0.9820 | z 0.9723 | 9.7 mm |
| `gadget_attach_1_override` | y -0.1292 | y -0.1385 | 9.3 mm |

The other 251 agree within a millimetre. The archive is right in every case and
a port should follow it.

### A bone's rotation needs the quaternion reordered *and* the basis conjugated

Two conversions, and doing only the first gives a rotation that looks plausible
and is wrong.

The archive stores `[w, x, y, z]`; three.js takes `(x, y, z, w)`. And the Z-up
to Y-up change of basis that vertices get as `(x, y, z) -> (x, z, -y)` is a -90°
rotation about X, which a *rotation* has to be conjugated by: `q' = B q B⁻¹`.
Converting the position but not the rotation leaves the mesh and the skeleton in
different spaces, which renders as a correctly-shaped piece that deforms into
knots -- not as anything obviously broken.

### `applyBoneTransform` skins the vector you hand it

It does **not** read `geometry.attributes.position` for you: `_basePosition`
is a copy of the argument. Passing a fresh `Vector3()` skins the origin and
returns something near zero, which reads exactly like a mesh that is not bound
to its skeleton. Read the vertex out of the position attribute first.

Cost me a wrong diagnosis: the rig was correct and the probe was not.

### Skinning comes in two forms, and reading one leaves armour unweighted

A `.skinm` carries its bone maps as **either** `IVOBONEMAP32` (eight influences,
24 bytes) **or** `IVOBONEMAP` (four, 12 bytes), and both are in use across the
armour tree. The Sunchaser helmet uses the twelve-byte form.

Reading only the eight-influence one is silent: an absent stream parses as
`None`, not as an error, so the mesh comes out complete and **entirely
unweighted** -- 16,930 of 16,930 vertices on that helmet. Nothing downstream
complains either; the piece simply does not deform.

Four influences is also what the renderer wants. glTF's `JOINTS_0`/`WEIGHTS_0`
hold four, and the pipeline's Collada-and-Blender route limits to four as well,
so the eight-wide form is reduced by keeping the four heaviest and
renormalising -- with ties broken by joint index, so the result does not depend
on the order the archive happened to store them in. A vertex with no influence
at all is left at zero rather than pinned to joint 0: weighting it to whatever
bone comes first is how a wrist cuff ends up across the body.

### The archive is Z-up, and the mapping is (x, y, z) -> (x, z, -y)

Checked against the pipeline rather than assumed: the Sunchaser helmet's GLB
spans **y 1.578 to 1.872** and the raw mesh spans **z 1.578 to 1.872** -- the
same numbers, on the axis the conversion relates, at head height on a 1.745 m
skeleton.

The negation matters and a bounding box cannot catch it. A plain `(x, z, y)`
swap has identical extents and flips handedness, which turns a left glove into
a right one.

Blender's exporter does this inside the pipeline, so nothing downstream of it
ever sees the conversion. A port has to do it explicitly, and doing it on the
buffers rather than by rotating the object is what keeps the mesh, the skeleton
and the socket transforms in one space.

### Attachment points and sockets

The base skeleton has **no attachment bones**. Names like
`backpack_attach_1_override` are introduced by the worn pieces themselves, which
is why a backpack initially rendered at the body origin.

A CDS undersuit contributes 35 such bones, and **every one parents to a bone the
base skeleton already has** (`Spine3`, `RightHand`, `LeftUpLeg_Start_sIk1`, ...).
So `build_base_rig.graft_attachments` copies them onto the canonical armature,
taking it from 220 to 255 bones with 36 attachment points. Verified positions:

| Bone | Parent | Head |
| --- | --- | --- |
| `backpack_attach_1_override` | `Spine3` | (0.000, -0.130, 1.440) |
| `helmethook_attach_override` | `Spine` | (-0.098, -0.101, 1.055) |

**One attachment bone in the canonical armature disagrees with the archive, and
the archive is right.** `wep_sidearm_attach_override` parents to `RightUpLeg` in
the raw `.skin`, in the converted `.dae` and in the converted `.gltf` -- all
three agree -- but the armature `build_base_rig` produces says
`RightUpLeg_Start_sIk1`, one level further down, and places the bone 27 mm away
at (0.1968, 0.0178, 0.8932) instead of (0.2237, 0.0156, 0.9044). Blender's
import introduced it; `graft_attachments` only copies whatever `donor.data.bones`
reports. The other 34 grafted bones agree exactly on both parent and position.
Nothing hangs off this point yet, so it has not shown, but a holstered sidearm
would sit low and rotate with the wrong parent. Found by the Rust port's
`graft_diff`, which follows the archive and lists this as expected divergence.

**`SOCKET_YAW` is a Blender-frame correction, not a property of the archive.**
`place_at_socket` composes against `bone.matrix_local`, where a bone's local Y
axis runs along the bone, and the yaw corrects for that convention. Composed in
the archive's own frame instead -- the bone's `world_rotation` straight out of
the `.skin` -- **no yaw is needed**, and adding one mounts the pack backwards:
`grip_left_1` lands at x=-0.156 without it and x=+0.156 with it, on a bone rest
of (0.000, -0.130, 1.440). So the Python is right in its own space and a port
composing natively must not copy the yaw. Checked with `socket_yaw`.

**The prop's locator faces into the body, so the placement needs a 180 degree
yaw** (in Blender's frame). Without it every backpack is mounted backwards. A bounding box will not
catch this, since a pack's extents look much the same either way; the props'
own `grip_left_1` / `grip_right_1` locators will. Composed directly, a pack's
left grip lands on the character's right at x=+0.190; with the yaw it lands at
x=-0.190 where it belongs. `normalize_armor.SOCKET_YAW`.

**A rigid prop is authored around its own origin, not in body space**, and
carries empties marking where it mounts: a backpack ships a
`backpack_attach_1_loc` empty that pairs with the skeleton's
`backpack_attach_1_override` bone. `normalize_armor.place_at_socket` composes
`bone_rest · locator⁻¹` so the prop's frame lands on the bone, then exports the
result **in body space**. The viewer cancels the bone's rest matrix when it
parents the mesh.

Two earlier attempts were wrong and are worth not repeating. Baking the mesh
into the bone's local space in Blender fought the exporter's Z-up to Y-up
conversion of the bone's own rest rotation and put backpacks 1.3 m off the body.
Skipping the locator and using the bone position alone left the pack floating at
head height, because the prop's origin is not its mount point.

`catalog.SLOT_SOCKETS` maps a rigid slot to its bone. Grafted bones are marked
`use_deform = False` so they never pick up weight.

**Colour variants reuse the canonical mesh.** They differ only by tint, so
converting each one would duplicate geometry for nothing.
`pipeline.refresh_assets` points a variant at its canonical item's GLB, and the
viewer re-applies the variant's own palette colour, since the shared mesh carries
the canonical colour baked into its material.

### The female body is the same rig with different meshes

The long-standing "whether female meshes bind to the same bone names as male
ones" is answered: **they do, exactly.** Measured against the real archive,
`female_v2/export/bhf_skeleton_v2.chr` carries **220 bones, every name also in
the male base, and not one female-only bone**. The 35 the male *armature* has
beyond that are all grafted `*_override` attachment points, which come from the
donor pieces rather than from the `.chr`.

So a body switch is a swap of meshes and rig, not a second binding scheme --
binding is by name everywhere, and the name sets are identical.

**Female donors exist and mirror the male list**, `m_` becoming `f_`:
`f_cds_undersuit_armor_02.skin` (42,677 verts) and
`f_slaver_heavy_armor_01_core.skin` (22,842 verts), both 220 bones. Grafted,
the female armature reaches **256 bones with 36 attachment points**, against
the male's 255 and 35 -- one more, and harmless, since nothing binds
positionally.

**The item is shared; only the mesh differs.** `SubGeometry[1]` is the female
`f_*.skin` and `SubGeometry[2]` the male `m_*.skin` on the *same* DataCore
record, which is why a loadout carries across a switch by item id. Measured on
a full Defiance Sunchaser set: 4 of 4 pieces carried over, geometry changing
from `m_slaver_heavy_armor_01_core.skin` to `f_slaver_heavy_armor_01_core.skin`
and so on, one shared skeleton across all four.

The catalogues differ slightly in size -- **2,439 male against 2,436 female** --
because three pieces have no female mesh. They simply do not appear for that
body, which is honest: they are not in the game for it either.

**Switching re-reads the DataCore, so the built catalogue is cached per body.**
The DCB is 316 MB and deliberately not held; the catalogue it produces is a few
MB of JSON and is. First switch to a body 10.2s, every switch after it **under
a second** -- measured 956ms back to male and 952ms to female again.

### A backpack can be a character, and still hangs on its socket (2026-10-31)

The Novikov pack (`clda_env_heavy_backpack_01*`, 8 items, 7 looks) never
drew: its only geometry is `m_clda_env_heavy_backpack_01.cdf`, the catalogue
called it skinned because the path is not a `.cga`, and `loadMesh` read the
definition's bytes as a mesh. In 4.10.2 it is the only worn `.cdf`.

**Rebinding it to the body would be wrong.** Its `CA_SKIN` is weighted only to
a skeleton of the pack's own -- `root`, `cannister`, `carabiner`, the last two
on pendulums -- and sits at the pack's origin (z 0.00-0.36), not at body
height. Its `.chr` carries exactly what a `.cga` pack carries as nodes:
`backpack_attach_1_loc`, `grip_left_1`/`grip_right_1`, and the
`wep_stocked_attach_2/3_override` and `gadget_attach_1_override` points. So a
backpack named by a `.cdf` is a socket piece (`bind_mode_for`, both
catalogues), and `loadProp` reads a `.cdf`: the skins at bind pose, the
model's bones as the prop's nodes (`socket::Prop::from_skeleton`). Against the
`.cga` pack in the same folder the locator has the same rotation and the grips
land on the same sides (±0.228 against ±0.243 m); drawn, the outer face -- tray,
plate, strapped pocket, canister -- matches the game's icon.
