import * as THREE from 'three';

import { assetUrl } from '../manifest';

/**
 * Poses retargeted from the game's own animation data.
 *
 * `scx poses` reads a frame out of the standing and crouching locomotion
 * clips, runs forward kinematics over the `.chr` hierarchy, and writes how far
 * each bone moves from its own bind pose. Nothing here is hand-authored.
 *
 * A delta rather than an absolute orientation. The clip's local rotations live
 * in the animation rig's bone frames, and ours no longer match after the trip
 * through Collada, Blender and the glTF exporter. Absolute world orientation
 * does not save it either: that only works where the two rigs' bone axes agree,
 * which they do for spine and legs and do not for arms. "Rotate this bone by
 * however far the animation moves it from rest" is convention-independent.
 *
 * Bone lengths stay ours, so the pose adapts to our proportions.
 */
export interface BonePose {
  /**
   * How far the clip rotates this bone from its own bind pose, in world space,
   * glTF xyzw. A delta rather than an absolute orientation because the two
   * rigs do not share bone axis conventions.
   */
  delta: [number, number, number, number];
  /** World-space position, glTF. Informational; the rig's own lengths win. */
  position?: [number, number, number];
}

export interface Pose {
  label: string;
  clip: string;
  bones: Record<string, BonePose>;
}

export type PoseLibrary = Record<string, Pose>;

export const REST_POSE = 'tpose';
export const REST_LABEL = 'T-pose';

export async function loadPoses(signal?: AbortSignal): Promise<PoseLibrary> {
  try {
    const response = await fetch(assetUrl('poses.json'), { signal });
    if (!response.ok) return {};
    return (await response.json()) as PoseLibrary;
  } catch (error) {
    if (!signal?.aborted) console.warn('[poses] none available', error);
    return {};
  }
}

// Rest state is captured once per skeleton, so switching poses is always
// relative to the T-pose rather than compounding.
const restState = new WeakMap<
  THREE.Skeleton,
  Map<string, { rotation: THREE.Quaternion; position: THREE.Vector3 }>
>();

function captureRest(skeleton: THREE.Skeleton) {
  let rest = restState.get(skeleton);
  if (!rest) {
    rest = new Map();
    for (const bone of skeleton.bones) {
      rest.set(bone.name, {
        rotation: bone.quaternion.clone(),
        position: bone.position.clone(),
      });
    }
    restState.set(skeleton, rest);
  }
  return rest;
}

function restoreRest(skeleton: THREE.Skeleton): void {
  const rest = captureRest(skeleton);
  for (const bone of skeleton.bones) {
    const entry = rest.get(bone.name);
    if (!entry) continue;
    bone.quaternion.copy(entry.rotation);
    bone.position.copy(entry.position);
  }
  for (const bone of skeleton.bones) bone.updateMatrixWorld(true);
}

/** Lowest world Y across the foot and toe bones. */
function groundHeight(skeleton: THREE.Skeleton): number | null {
  const point = new THREE.Vector3();
  let lowest: number | null = null;
  for (const name of ['LeftToeBase', 'RightToeBase', 'LeftFoot', 'RightFoot']) {
    const bone = skeleton.getBoneByName(name);
    if (!bone) continue;
    bone.getWorldPosition(point);
    lowest = lowest === null ? point.y : Math.min(lowest, point.y);
  }
  return lowest;
}

function depth(bone: THREE.Object3D): number {
  let count = 0;
  let node: THREE.Object3D | null = bone.parent;
  while (node) {
    count += 1;
    node = node.parent;
  }
  return count;
}

export function applyPose(skeleton: THREE.Skeleton, pose: Pose | null): void {
  restoreRest(skeleton);
  if (!pose) return;

  const restGround = groundHeight(skeleton);

  // Our own rest orientation per bone, read after the restore above.
  const restWorld = new Map<string, THREE.Quaternion>();
  for (const bone of skeleton.bones) {
    const quaternion = new THREE.Quaternion();
    bone.getWorldQuaternion(quaternion);
    restWorld.set(bone.name, quaternion);
  }

  // Parents first: each bone's local rotation comes from its parent's
  // already-posed world orientation.
  const ordered = [...skeleton.bones].sort((a, b) => depth(a) - depth(b));
  const delta = new THREE.Quaternion();
  const parentWorld = new THREE.Quaternion();

  for (const bone of ordered) {
    const entry = pose.bones[bone.name];
    const rest = restWorld.get(bone.name);
    // The armature root carries the clip's own world placement, which would
    // drag the whole body sideways. Our root stays where it is.
    if (!entry || !rest || !bone.parent) continue;

    delta.set(entry.delta[0], entry.delta[1], entry.delta[2], entry.delta[3]);
    const desired = delta.multiply(rest);

    bone.parent.getWorldQuaternion(parentWorld);
    bone.quaternion.copy(parentWorld.invert().multiply(desired));
    bone.updateMatrixWorld(true);
  }

  for (const bone of skeleton.bones) bone.updateMatrixWorld(true);

  // The clip is authored against the game's floor and our proportions differ,
  // so seat the feet on the ground.
  const hips = skeleton.getBoneByName('Hips');
  const posedGround = groundHeight(skeleton);
  if (hips && restGround !== null && posedGround !== null) {
    const parent = hips.parent ?? hips;
    const from = parent.worldToLocal(new THREE.Vector3(0, 0, 0));
    const to = parent.worldToLocal(new THREE.Vector3(0, restGround - posedGround, 0));
    hips.position.add(to.sub(from));
    for (const bone of skeleton.bones) bone.updateMatrixWorld(true);
  }
}
