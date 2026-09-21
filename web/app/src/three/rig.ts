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
