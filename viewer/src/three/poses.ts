import * as THREE from 'three';

/**
 * Named poses for the shared skeleton.
 *
 * The rig arrives in a T-pose, which suits inspecting a mesh and not judging
 * how a set looks worn.
 *
 * Poses are expressed as **world-space aim directions** rather than per-bone
 * Euler angles. Hand-authored Eulers do not survive this rig: mirroring the
 * sign across the body sent the left arm down correctly and the right arm out
 * sideways, because the two limbs do not share a local axis convention. Aiming
 * a bone at a direction needs no such assumption, and reads better too, since
 * "point the upper arm down and slightly forward" is the actual intent.
 *
 * These are authored by eye. The game's own animations live in CryEngine
 * animation files the pipeline does not read yet.
 */
export type Aim = [number, number, number];

export interface Pose {
  label: string;
  /** Direction each bone should point, in world space. Unlisted bones rest. */
  aims: Record<string, Aim>;
  /**
   * Keep the feet on the ground after posing. A crouch folds the legs, which
   * lifts the feet unless the hips come down to meet them; how far depends on
   * the pose, so it is measured rather than hand-tuned.
   */
  plantFeet?: boolean;
}

export const POSES: Record<string, Pose> = {
  tpose: {
    label: 'T-pose',
    aims: {},
  },

  idle: {
    label: 'Idle',
    aims: {
      // Arms hang down, angled very slightly out and back off the ribcage.
      LeftArm: [-0.16, -1, -0.05],
      RightArm: [0.16, -1, -0.05],
      LeftForeArm: [-0.1, -1, 0.18],
      RightForeArm: [0.1, -1, 0.18],
      LeftHand: [-0.08, -1, 0.12],
      RightHand: [0.08, -1, 0.12],
      // Feet a little apart rather than perfectly parallel.
      LeftUpLeg: [-0.05, -1, 0],
      RightUpLeg: [0.05, -1, 0],
    },
  },

  crouch: {
    label: 'Crouch',
    aims: {
      // Thigh forward and down, shin back and down, foot flat: a braced kneel
      // rather than a squat, which is how armor is usually shown.
      LeftUpLeg: [-0.08, -0.62, 0.78],
      RightUpLeg: [0.08, -0.62, 0.78],
      LeftLeg: [0, -0.72, -0.69],
      RightLeg: [0, -0.72, -0.69],
      LeftFoot: [0, -0.18, 0.98],
      RightFoot: [0, -0.18, 0.98],
      // Torso pitched forward to keep the mass over the feet.
      Spine: [0, 0.97, 0.24],
      Spine1: [0, 0.98, 0.2],
      Neck: [0, 0.98, -0.2],
      LeftArm: [-0.2, -1, 0.15],
      RightArm: [0.2, -1, 0.15],
      LeftForeArm: [-0.1, -0.75, 0.66],
      RightForeArm: [0.1, -0.75, 0.66],
    },
    plantFeet: true,
  },
};

export type PoseName = keyof typeof POSES;

// Rest state is captured once per skeleton so switching poses is always
// relative to the T-pose rather than compounding.
const restRotations = new WeakMap<THREE.Skeleton, Map<string, THREE.Quaternion>>();
const restHips = new WeakMap<THREE.Skeleton, THREE.Vector3>();

function captureRest(skeleton: THREE.Skeleton): Map<string, THREE.Quaternion> {
  let rest = restRotations.get(skeleton);
  if (!rest) {
    rest = new Map();
    for (const bone of skeleton.bones) rest.set(bone.name, bone.quaternion.clone());
    restRotations.set(skeleton, rest);
  }
  return rest;
}

/**
 * The anatomical child of each posed bone.
 *
 * Taking "the first child bone" does not work here: the rig interleaves
 * deformation and IK helpers, and their order differs between sides. LeftArm
 * lists LeftForeArm first while RightArm lists RightDelt_def first and
 * RightForeArm fifth, which aimed the right limb off a helper and left the
 * body visibly lopsided.
 */
const CHAIN: Record<string, string> = {
  LeftArm: 'LeftForeArm',
  RightArm: 'RightForeArm',
  LeftForeArm: 'LeftHand',
  RightForeArm: 'RightHand',
  LeftHand: 'LeftHandMiddle1',
  RightHand: 'RightHandMiddle1',
  LeftUpLeg: 'LeftLeg',
  RightUpLeg: 'RightLeg',
  LeftLeg: 'LeftFoot',
  RightLeg: 'RightFoot',
  LeftFoot: 'LeftToeBase',
  RightFoot: 'RightToeBase',
  Spine: 'Spine1',
  Spine1: 'Spine2',
  Spine2: 'Spine3',
  Spine3: 'Neck',
  Neck: 'Neck1',
  Neck1: 'Head',
};

/** The bone's own direction in world space, from its head towards its child. */
function worldDirection(bone: THREE.Bone, out: THREE.Vector3): boolean {
  const wanted = CHAIN[bone.name];
  const children = bone.children.filter((node) => (node as THREE.Bone).isBone) as THREE.Bone[];
  const child = (wanted && children.find((node) => node.name === wanted)) ?? children[0];
  if (!child) return false;

  const head = new THREE.Vector3();
  const tail = new THREE.Vector3();
  bone.getWorldPosition(head);
  child.getWorldPosition(tail);
  out.subVectors(tail, head);
  if (out.lengthSq() < 1e-10) return false;
  out.normalize();
  return true;
}

/** Rotate a bone so it points along ``target`` in world space. */
function aimBone(bone: THREE.Bone, target: THREE.Vector3): void {
  const current = new THREE.Vector3();
  if (!worldDirection(bone, current)) return;

  const delta = new THREE.Quaternion().setFromUnitVectors(current, target);
  const boneWorld = new THREE.Quaternion();
  bone.getWorldQuaternion(boneWorld);

  const parentWorld = new THREE.Quaternion();
  if (bone.parent) bone.parent.getWorldQuaternion(parentWorld);

  // world = parent * local, so local = parent⁻¹ * (delta * world)
  bone.quaternion.copy(parentWorld.invert().multiply(delta.multiply(boneWorld)));
  bone.updateMatrixWorld(true);
}

/** Lowest world Y across the foot and toe bones. */
function groundHeight(skeleton: THREE.Skeleton): number | null {
  const names = ['LeftToeBase', 'RightToeBase', 'LeftFoot', 'RightFoot'];
  const point = new THREE.Vector3();
  let lowest: number | null = null;
  for (const name of names) {
    const bone = skeleton.getBoneByName(name);
    if (!bone) continue;
    bone.getWorldPosition(point);
    lowest = lowest === null ? point.y : Math.min(lowest, point.y);
  }
  return lowest;
}

export function applyPose(skeleton: THREE.Skeleton, pose: Pose): void {
  const rest = captureRest(skeleton);

  for (const bone of skeleton.bones) {
    const base = rest.get(bone.name);
    if (base) bone.quaternion.copy(base);
  }

  const hips = skeleton.getBoneByName('Hips');
  if (hips) {
    let home = restHips.get(skeleton);
    if (!home) {
      home = hips.position.clone();
      restHips.set(skeleton, home);
    }
    hips.position.copy(home);
  }

  for (const bone of skeleton.bones) bone.updateMatrixWorld(true);
  const restGround = groundHeight(skeleton);

  // Aim parents before children: each aim reads the current world direction, so
  // a child must be posed after the limb it hangs off has moved.
  const byDepth = [...skeleton.bones].sort((a, b) => depth(a) - depth(b));
  const target = new THREE.Vector3();
  for (const bone of byDepth) {
    const aim = pose.aims[bone.name];
    if (!aim) continue;
    target.set(aim[0], aim[1], aim[2]);
    if (target.lengthSq() < 1e-10) continue;
    aimBone(bone, target.normalize());
  }

  for (const bone of skeleton.bones) bone.updateMatrixWorld(true);

  if (pose.plantFeet && hips && restGround !== null) {
    const posedGround = groundHeight(skeleton);
    if (posedGround !== null) {
      // Convert the world-space correction into the hips' own parent space, so
      // it stays correct whatever transform sits above them.
      const parent = hips.parent ?? hips;
      const from = parent.worldToLocal(new THREE.Vector3(0, 0, 0));
      const to = parent.worldToLocal(new THREE.Vector3(0, restGround - posedGround, 0));
      hips.position.add(to.sub(from));
      for (const bone of skeleton.bones) bone.updateMatrixWorld(true);
    }
  }
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
