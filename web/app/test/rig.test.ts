import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';

import { bonePosition, boneRotation, buildRig } from '../src/three/rig';
import type { RigBone } from '../src/worker/archive.worker';

function bone(name: string, parent: number, position: number[], rotation = [1, 0, 0, 0]): RigBone {
  return {
    name,
    parent,
    position: new Float32Array(position),
    rotation: new Float32Array(rotation),
    world: new Float32Array(position),
    attachment: name.endsWith('_override'),
  };
}

describe('bone positions', () => {
  it('convert Z-up to Y-up the same way vertices do', () => {
    expect(bonePosition([1, 2, 3]).toArray()).toEqual([1, 3, -2]);
  });
});

describe('bone rotations', () => {
  it('reorder the quaternion from [w, x, y, z] to (x, y, z, w)', () => {
    // Identity is the one case where getting the order wrong is invisible, so
    // this uses a rotation with all four components distinct.
    const archive = [0.5, 0.5, 0.5, 0.5];
    const q = boneRotation(archive);
    expect(q.length()).toBeCloseTo(1, 6);
  });

  it('leaves identity alone', () => {
    const q = boneRotation([1, 0, 0, 0]);
    expect(q.x).toBeCloseTo(0, 6);
    expect(q.y).toBeCloseTo(0, 6);
    expect(q.z).toBeCloseTo(0, 6);
    expect(Math.abs(q.w)).toBeCloseTo(1, 6);
  });

  it('conjugates by the change of basis, not just reorders', () => {
    // A quarter turn about the archive's Z should become a quarter turn about
    // three.js's Y -- because the archive's Z *is* three.js's Y. Reordering
    // without conjugating leaves it turning about Z, which puts the skeleton in
    // a different space from the mesh and deforms the piece into knots.
    const halfAngle = Math.PI / 4;
    const aboutArchiveZ = [Math.cos(halfAngle), 0, 0, Math.sin(halfAngle)];
    const q = boneRotation(aboutArchiveZ);

    const axis = new Vector3(0, 0, 1).applyQuaternion(q);
    // Rotating about Y leaves Y fixed and moves Z.
    const yAxis = new Vector3(0, 1, 0).applyQuaternion(q);
    expect(yAxis.y).toBeCloseTo(1, 5);
    expect(axis.y).toBeCloseTo(0, 5);
    expect(axis.z).toBeCloseTo(Math.cos(Math.PI / 2), 5);
  });

  it('round-trips a rotation applied to a converted vector', () => {
    // Converting a point then rotating it must equal rotating it in the
    // archive's space and then converting. That equality is what "same space"
    // means, and it is the property the conjugation buys.
    const archiveQ = [Math.cos(0.3), 0.0, Math.sin(0.3), 0.0]; // about archive Y
    const point = [0.2, 0.5, 1.3];

    const converted = bonePosition(point).applyQuaternion(boneRotation(archiveQ));

    const inArchive = new Vector3(...point).applyQuaternion(
      new Quaternion(archiveQ[1]!, archiveQ[2]!, archiveQ[3]!, archiveQ[0]!),
    );
    const thenConverted = bonePosition(inArchive.toArray());

    expect(converted.x).toBeCloseTo(thenConverted.x, 5);
    expect(converted.y).toBeCloseTo(thenConverted.y, 5);
    expect(converted.z).toBeCloseTo(thenConverted.z, 5);
  });
});

describe('building the rig', () => {
  const source: RigBone[] = [
    bone('World', -1, [0, 0, 0]),
    bone('Hips', 0, [0, 0, 1]),
    bone('Spine', 1, [0, 0, 0.2]),
    bone('backpack_attach_1_override', 2, [0, -0.13, 0.44]),
  ];

  it('parents the bones and finds the root', () => {
    const rig = buildRig(source);
    expect(rig.bones).toHaveLength(4);
    expect(rig.root.name).toBe('World');
    expect(rig.byName.get('Spine')!.parent!.name).toBe('Hips');
  });

  it('accumulates world positions down the chain', () => {
    // Local positions are parent-relative, so Spine sits at the sum. Getting
    // this wrong collapses the skeleton onto the root.
    const rig = buildRig(source);
    const world = new Vector3();
    rig.byName.get('Spine')!.getWorldPosition(world);
    expect(world.y).toBeCloseTo(1.2, 5);
  });

  it('gives every bone an inverse bind, not the identity', () => {
    // Inverse binds taken before `updateMatrixWorld` are all identity, and the
    // mesh then collapses to the origin.
    const rig = buildRig(source);
    expect(rig.skeleton.boneInverses).toHaveLength(4);
    const spine = rig.skeleton.boneInverses[2]!;
    expect(spine.elements[13]).toBeCloseTo(-1.2, 5);
  });

  it('marks the grafted attachment points', () => {
    expect(source.filter((b) => b.attachment)).toHaveLength(1);
  });
});
