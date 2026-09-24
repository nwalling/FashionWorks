/** The idle loop. RENDERING.md Phase 5.
 *
 * A still pose is one frame of a clip; this plays a whole one, over and over,
 * on top of whatever still pose is up. Two ways, because the archive offers two
 * kinds of loop and neither fits every pose:
 *
 * * **absolute** -- the clip's own local rotations, applied directly, as the
 *   still poses apply theirs. For the unarmed idle, which is the character
 *   customizer's: `pu_char_custom_idle_{m,f}_01.caf`, ten seconds of weight
 *   shifting that ends within 0.11 degrees (male) and 0.57 (female) of where
 *   it began. The standing idle the still pose uses cannot loop: it is a
 *   turn in place, the root turning 360 degrees in four steps, and with the
 *   root left out the figure shuffles its feet on the spot.
 * * **additive** -- the clip's motion relative to its first frame, laid over
 *   the still pose, on a few bones. For everything with a weapon in hand and
 *   for crouching: there is no armed standing idle that is not a turn in
 *   place, so the same customizer idle sways the spine, neck and head -- one
 *   to two degrees -- over the still pose. Both weapon bones hang off
 *   `Spine3`, so the hands and the gun ride the chest together and the grip
 *   holds exactly. The hips are left out: turning them swings the legs, and
 *   the feet would slide. The game's own breathing layer,
 *   `nw_neutral_stand_idle_base`, was tried first and is nearly invisible
 *   there: its motion is in the shoulders, up to 2.3 degrees, and the spine
 *   moves under half a degree. The shoulders cannot take it without moving
 *   one hand off the gun.
 *
 * Frames are slerped, so a 30 fps clip plays smoothly at 60. The loop runs
 * over frames `0 .. frames - 1`: on a clip that loops, the last key repeats the
 * first, and drawing both would hold the pose for a frame at the seam. What
 * gap a clip leaves between its ends -- 0.57 degrees on a finger of the
 * female idle, which showed as a one-frame jump -- is spread across the cycle,
 * so every seam closes exactly.
 */

import { type Bone, Quaternion } from 'three';

import type { ClipPayload } from '../worker/archive.worker';
import { clipRotation } from './rig';

export type LoopMode = 'absolute' | 'additive';

/** How long a loop takes to fade in over the still pose, and out again. */
export const FADE_SECONDS = 0.6;

export class ClipLoop {
  readonly fps: number;
  /** Frames in one cycle: the clip's, less the repeated last one. */
  readonly length: number;
  private readonly bones: Bone[];
  /** `frames x bones x 4`, three.js `[x, y, z, w]`: the rotation, or for an
   * additive loop the rotation relative to frame 0. */
  private readonly samples: Float32Array;
  /** Each bone's still-pose rotation, captured when the loop starts. */
  private readonly base: Quaternion[];
  private readonly mode: LoopMode;
  private readonly scratch = new Quaternion();
  private readonly qa = new Quaternion();
  private readonly qb = new Quaternion();

  constructor(payload: ClipPayload, byName: ReadonlyMap<string, Bone>, mode: LoopMode, only?: ReadonlySet<string>) {
    this.fps = payload.fps > 0 ? payload.fps : 30;
    this.mode = mode;
    const columns: number[] = [];
    const bones: Bone[] = [];
    payload.bones.forEach((name, i) => {
      const bone = byName.get(name);
      if (!bone || (only && !only.has(name))) return;
      columns.push(i);
      bones.push(bone);
    });
    this.bones = bones;
    this.base = bones.map((bone) => bone.quaternion.clone());
    this.length = Math.max(1, payload.frames - 1);

    const stride = payload.bones.length * 4;
    const samples = new Float32Array(payload.frames * bones.length * 4);
    const first: Quaternion[] = columns.map((c) => clipRotation(payload.rotations.subarray(c * 4, c * 4 + 4)).invert());
    for (let frame = 0; frame < payload.frames; frame += 1) {
      columns.forEach((c, b) => {
        const o = frame * stride + c * 4;
        const q = clipRotation(payload.rotations.subarray(o, o + 4));
        if (mode === 'additive') q.premultiply(first[b]!);
        const o2 = (frame * bones.length + b) * 4;
        samples[o2] = q.x;
        samples[o2 + 1] = q.y;
        samples[o2 + 2] = q.z;
        samples[o2 + 3] = q.w;
      });
    }
    this.samples = samples;
    this.closeSeam(payload.frames);
  }

  /** Spread each bone's gap between its last and first frame over the cycle:
   * frame f gains `f / last` of the rotation that takes the last frame to the
   * first, so the last frame lands on the first exactly. */
  private closeSeam(frames: number): void {
    const last = frames - 1;
    if (last < 1) return;
    const first = new Quaternion();
    const end = new Quaternion();
    const gap = new Quaternion();
    const part = new Quaternion();
    const q = new Quaternion();
    for (let b = 0; b < this.bones.length; b += 1) {
      this.at(first, 0, b);
      this.at(end, last, b);
      gap.copy(end).invert().multiply(first);
      for (let frame = 1; frame <= last; frame += 1) {
        part.identity().slerp(gap, frame / last);
        this.at(q, frame, b).multiply(part);
        const o = (frame * this.bones.length + b) * 4;
        this.samples[o] = q.x;
        this.samples[o + 1] = q.y;
        this.samples[o + 2] = q.z;
        this.samples[o + 3] = q.w;
      }
    }
  }

  /** How many bones the loop moves. */
  get moved(): number {
    return this.bones.length;
  }

  /** Pose the bones at `seconds` into the loop, at `weight` of the way from
   * the still pose (0) to the loop (1). */
  apply(seconds: number, weight: number): void {
    const position = (seconds * this.fps) % this.length;
    const a = Math.floor(position);
    const b = a + 1;
    const f = position - a;
    const n = this.bones.length;
    for (let i = 0; i < n; i += 1) {
      this.scratch.slerpQuaternions(this.at(this.qa, a, i), this.at(this.qb, b, i), f);
      const bone = this.bones[i]!;
      const base = this.base[i]!;
      if (this.mode === 'additive') {
        // base x delta, the delta scaled by the fade.
        if (weight < 1) this.scratch.slerp(IDENTITY, 1 - weight);
        bone.quaternion.copy(base).multiply(this.scratch);
      } else {
        bone.quaternion.slerpQuaternions(base, this.scratch, weight);
      }
    }
  }

  private at(out: Quaternion, frame: number, bone: number): Quaternion {
    const o = (frame * this.bones.length + bone) * 4;
    const s = this.samples;
    return out.set(s[o]!, s[o + 1]!, s[o + 2]!, s[o + 3]!);
  }

  /** Put the still pose back. */
  restore(): void {
    this.bones.forEach((bone, i) => bone.quaternion.copy(this.base[i]!));
  }

  /** Every bone's current rotation, for a fade out from wherever it is. */
  snapshot(): Quaternion[] {
    return this.bones.map((bone) => bone.quaternion.clone());
  }

  /** Blend from `from` back to the still pose, `t` from 0 to 1. */
  fadeOut(from: readonly Quaternion[], t: number): void {
    this.bones.forEach((bone, i) => bone.quaternion.slerpQuaternions(from[i]!, this.base[i]!, t));
  }
}

const IDENTITY = new Quaternion();

/** Ease in and out, so the fade does not start or stop with a jolt. */
export function smooth(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}
