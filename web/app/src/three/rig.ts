/** The canonical armature, as a three.js `Skeleton`.
 *
 * Every piece binds to **this one object**. That is what makes a loadout share
 * a skeleton: the local pipeline's own measurement is that a full set holds one
 * `THREE.Skeleton` and one set of bone objects across ten skinned meshes, and
 * posing a bone deforms the body and every piece together.
 *
 * Two conversions happen here and both are easy to get subtly wrong.
 *
 * **Quaternion order.** The archive stores `[w, x, y, z]`; three.js takes
 * `(x, y, z, w)`. Passing the array straight in is a rotation that looks
 * plausible and is wrong.
 *
 * **Axis.** The archive is Z-up. Bone positions convert the same way vertices
 * do, `(x, y, z) -> (x, z, -y)`, and the rotation has to be conjugated by the
 * same change of basis or the mesh and the skeleton end up in different spaces
 * -- which shows up as a correctly-shaped piece that deforms into knots.
 */

import { Bone, Matrix4, Quaternion, Skeleton, Vector3 } from 'three';

import type { RigBone } from '../worker/archive.worker';

/** The Z-up to Y-up change of basis, as a quaternion.
 *
 * `(x, y, z) -> (x, z, -y)` is a -90° rotation about X. Applying it to a bone's
 * rotation means conjugating: `q' = B * q * B⁻¹`.
 */
const Z_TO_Y = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
const Z_TO_Y_INVERSE = Z_TO_Y.clone().invert();

export function boneRotation(archive: Float32Array | number[]): Quaternion {
  // [w, x, y, z] in the archive, (x, y, z, w) in three.js.
  const q = new Quaternion(archive[1]!, archive[2]!, archive[3]!, archive[0]!);
  return Z_TO_Y.clone().multiply(q).multiply(Z_TO_Y_INVERSE);
}

export function bonePosition(archive: Float32Array | number[]): Vector3 {
  return new Vector3(archive[0]!, archive[2]!, -archive[1]!);
}

/** A rotation out of an **animation clip**, into the scene's frame.
 *
 * Not the same conversion as [`boneRotation`], and the difference is a right
 * angle. Three frames are in play:
 *
 * * the `.chr` skeleton, **+Z up**;
 * * an animation clip's world space, **-Y up** -- which `CLAUDE.md` records;
 * * three.js, **+Y up**.
 *
 * Archive to scene is -90 degrees about X. Clip to archive is another -90.
 * Composed, clip to scene is **180 degrees about X**, which conjugates a
 * quaternion by negating its y and z -- and is exactly the conversion the
 * pipeline's own `to_gltf_quat` applies.
 *
 * Using `boneRotation` here instead lays the character on its back at a right
 * angle to the floor, with every joint otherwise correct, which reads as a
 * parsing failure and is not.
 */
export function clipRotation(archive: Float32Array | number[]): Quaternion {
  return new Quaternion(archive[1]!, -archive[2]!, -archive[3]!, archive[0]!);
}

export interface BuiltRig {
  bones: Bone[];
  skeleton: Skeleton;
  /** The root bone, to add to the scene. Parenting the skeleton is not enough:
   * three.js updates bone matrices by walking the scene graph. */
  root: Bone;
  byName: Map<string, Bone>;
}

export function buildRig(source: readonly RigBone[]): BuiltRig {
  const bones = source.map((entry) => {
    const bone = new Bone();
    bone.name = entry.name;
    bone.position.copy(bonePosition(entry.position));
    bone.quaternion.copy(boneRotation(entry.rotation));
    return bone;
  });

  let root = bones[0]!;
  source.forEach((entry, i) => {
    if (entry.parent >= 0 && bones[entry.parent]) {
      bones[entry.parent]!.add(bones[i]!);
    } else {
      root = bones[i]!;
    }
  });

  // World matrices have to exist before the inverse binds are taken, or every
  // one of them is the identity and the mesh collapses to the origin.
  root.updateMatrixWorld(true);
  const inverses = bones.map((bone) => new Matrix4().copy(bone.matrixWorld).invert());
  const skeleton = new Skeleton(bones, inverses);

  return {
    bones,
    skeleton,
    root,
    byName: new Map(bones.map((bone) => [bone.name, bone])),
  };
}

/** An archive-frame 3x4 transform as a three.js matrix in the scene's frame.
 *
 * The change of basis has to act on the *whole* transform -- `M' = B M B⁻¹` --
 * not just on its translation. Converting the translation alone leaves the
 * prop's rotation in the archive's frame and mounts it at the right place
 * facing the wrong way, which on a backpack is hard to see: its extents look
 * much the same either way round.
 */
export function mountMatrix(rows: Float32Array | number[]): Matrix4 {
  // Row-major 3x4 -> Matrix4 (which `set` also takes row-major).
  const m = new Matrix4().set(
    rows[0]!, rows[1]!, rows[2]!, rows[3]!,
    rows[4]!, rows[5]!, rows[6]!, rows[7]!,
    rows[8]!, rows[9]!, rows[10]!, rows[11]!,
    0, 0, 0, 1,
  );
  const basis = new Matrix4().makeRotationFromQuaternion(Z_TO_Y);
  const inverse = new Matrix4().makeRotationFromQuaternion(Z_TO_Y_INVERSE);
  return basis.multiply(m).multiply(inverse);
}

/** Apply a clip's own local rotations to the rig.
 *
 * **The pipeline cannot do this and this port can.** `CLAUDE.md` records "copy
 * the local rotations" as refuted -- the character ends up on its back -- but
 * that is true of the *pipeline's* rig, which has been through Collada,
 * Blender and the glTF exporter and whose bone frames no longer match the ones
 * the clip was authored against. This rig is built straight from the same
 * `.chr` the clip targets, so they do match.
 *
 * The root is skipped: it carries the clip's own world placement, which
 * otherwise drags the whole body sideways.
 */
export function applyClip(
  rig: BuiltRig,
  locals: ReadonlyArray<{ name: string; rotation: Float32Array | null; position: Float32Array | null }>,
): number {
  let moved = 0;
  for (const entry of locals) {
    if (!entry.rotation) continue;
    const bone = rig.byName.get(entry.name);
    if (!bone || bone === rig.root) continue;
    bone.quaternion.copy(clipRotation(entry.rotation));
    // **Rotations only.** The clip's positions are in its own world space,
    // which has up along -Y where the `.chr` has up along +Z -- so converting
    // them as if they were skeleton positions stands the whole body up along
    // the wrong axis. Local *rotations* need no such conversion, because a
    // bone's local frame is defined by its parent and the two rigs share the
    // hierarchy.
    //
    // Leaving positions alone is also what keeps bone lengths ours, so the
    // pose adapts to our proportions rather than importing the animation rig's.
    moved += 1;
  }
  rig.root.updateMatrixWorld(true);
  rig.skeleton.update();
  return moved;
}

/** Apply a retargeted pose to the rig.
 *
 * Each bone gets its rest orientation multiplied by the clip's delta from its
 * own bind pose -- `rest * delta` -- which is what makes a pose authored for
 * the game's rig work on ours without the two agreeing about bone axes.
 *
 * **The root is skipped.** It carries the clip's own world placement, which
 * otherwise drags the whole body a metre sideways.
 */
export function applyPose(
  rig: BuiltRig,
  bones: ReadonlyArray<{ name: string; root: boolean; delta: Float32Array }>,
  rest: ReadonlyMap<string, Quaternion>,
): number {
  let moved = 0;
  for (const entry of bones) {
    if (entry.root) continue;
    const bone = rig.byName.get(entry.name);
    const base = rest.get(entry.name);
    if (!bone || !base) continue;
    // `[w, x, y, z]` from the archive, in the archive's own frame -- so it
    // needs both the reorder and the same conjugation the bones got. A
    // rotation delta is basis-dependent, and applying one from another basis
    // folds the character up rather than failing.
    const delta = boneRotation(entry.delta);
    if (Math.abs(delta.w) < 0.999999) moved += 1;
    bone.quaternion.copy(delta).multiply(base);
  }
  rig.root.updateMatrixWorld(true);
  rig.skeleton.update();
  return moved;
}

/** The rig's rest orientations, captured before any pose is applied.
 *
 * Has to be taken from a genuinely unposed skeleton. Capturing it after a pose
 * has been applied makes every later comparison report zero difference, which
 * looks like a parsing failure and is not -- that happened once already.
 */
export function restPose(rig: BuiltRig): Map<string, Quaternion> {
  return new Map(rig.bones.map((bone) => [bone.name, bone.quaternion.clone()]));
}
