import { Bone, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { ClipLoop, smooth } from '../src/three/idle';
import { clipRotation } from '../src/three/rig';

/** An archive `[w, x, y, z]` rotation of `degrees` about the archive's Z. */
function aboutZ(degrees: number): number[] {
  const h = (degrees * Math.PI) / 360;
  return [Math.cos(h), 0, 0, Math.sin(h)];
}

/** A clip of one bone turning 0 -> 20 degrees and back to `end`. */
function payload(end: number, frames = 21) {
  const rotations = new Float32Array(frames * 4);
  for (let f = 0; f < frames; f += 1) {
    const t = f / (frames - 1);
    const degrees = t <= 0.5 ? 40 * t : 20 + (end - 20) * (2 * t - 1);
    rotations.set(aboutZ(degrees), f * 4);
  }
  return { fps: 10, frames, bones: ['Spine'], rotations };
}

const angle = (a: Quaternion, b: Quaternion) => (2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * 180) / Math.PI;

describe('ClipLoop', () => {
  it('closes a gap between the ends, so the seam does not jump', () => {
    const bone = new Bone();
    const loop = new ClipLoop(payload(3), new Map([['Spine', bone]]), 'absolute');
    const cycle = loop.length / loop.fps;
    loop.apply(0, 1);
    const start = bone.quaternion.clone();
    loop.apply(cycle - 1e-6, 1);
    expect(angle(bone.quaternion, start)).toBeLessThan(0.01);
  });

  it('starts from the still pose and fades into the clip', () => {
    const bone = new Bone();
    bone.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), 0.5);
    const still = bone.quaternion.clone();
    const loop = new ClipLoop(payload(0), new Map([['Spine', bone]]), 'absolute');
    loop.apply(1, smooth(0));
    expect(angle(bone.quaternion, still)).toBeLessThan(1e-4);
    loop.apply(1, 1);
    expect(angle(bone.quaternion, clipRotation(aboutZ(20)))).toBeLessThan(0.05);
  });

  it('adds only the motion from frame 0 on top of the still pose', () => {
    const bone = new Bone();
    bone.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), 1.2);
    const still = bone.quaternion.clone();
    const loop = new ClipLoop(payload(0), new Map([['Spine', bone]]), 'additive');
    loop.apply(0, 1);
    expect(angle(bone.quaternion, still)).toBeLessThan(1e-4);
    loop.apply(1, 1);
    expect(angle(bone.quaternion, still)).toBeCloseTo(20, 1);
  });

  it('moves only the bones it is given', () => {
    const spine = new Bone();
    const other = new Bone();
    const clip = payload(0);
    const two = { ...clip, bones: ['Spine', 'Other'], rotations: new Float32Array(clip.frames * 8) };
    for (let f = 0; f < clip.frames; f += 1) {
      two.rotations.set(clip.rotations.subarray(f * 4, f * 4 + 4), f * 8);
      two.rotations.set(clip.rotations.subarray(f * 4, f * 4 + 4), f * 8 + 4);
    }
    const loop = new ClipLoop(two, new Map([['Spine', spine], ['Other', other]]), 'additive', new Set(['Spine']));
    loop.apply(1, 1);
    expect(loop.moved).toBe(1);
    expect(other.quaternion.equals(new Quaternion())).toBe(true);
    expect(angle(spine.quaternion, new Quaternion())).toBeGreaterThan(10);
  });
});
