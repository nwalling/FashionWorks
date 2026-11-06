/** An emote: one of the game's clip sequences, played once. ANIMATION.md.
 *
 * Not a loop, so not `ClipLoop`: a loop's seam is closed by spreading its
 * end-to-start gap over the whole cycle, which is right for an idle that ends
 * a fraction of a degree from where it began and would bend a one-shot out of
 * shape. A salute is two clips -- attention to salute, then the salute held --
 * whose ends are 98 to 180 degrees apart, and played as a loop would crawl
 * from one to the other the whole way through.
 *
 * The game blends an emote in over 0.2 s and out over 0.2 s
 * (`playerEmoteAnims.adb`), and so does this: from the still pose to the
 * clip, and back to the still pose as it ends. Most emote clips start and end
 * on the standing idle, so the blends are short and nearly invisible. The
 * clips of a sequence follow one another without one: the game's are cut to
 * meet. Rotations only, as every clip here is: the hips stay ours and the
 * caller seats the feet each frame.
 */

import { type Bone, Quaternion } from 'three';

import type { ClipPayload } from '../worker/archive.worker';
import { smooth } from './idle';
import { clipRotation } from './rig';

/** How long an emote takes to blend in from the still pose, and out to it. */
export const EMOTE_BLEND_SECONDS = 0.2;

interface Part {
  readonly fps: number;
  readonly frames: number;
  /** Seconds this clip plays for: from its first frame to its last. */
  readonly seconds: number;
  /** For each of this clip's columns, the bone's index in the emote's set. */
  readonly slots: number[];
  /** `frames x slots x 4`, three.js `[x, y, z, w]`. */
  readonly samples: Float32Array;
}

export class EmotePlay {
  /** How long the whole sequence plays. */
  readonly seconds: number;
  /** Every bone any clip of the sequence moves. */
  private readonly bones: Bone[];
  /** Each bone's still-pose rotation, captured when the emote starts. */
  private readonly base: Quaternion[];
  private readonly parts: Part[];
  private readonly target: Quaternion[];
  private readonly qa = new Quaternion();
  private readonly qb = new Quaternion();

  constructor(payloads: readonly ClipPayload[], byName: ReadonlyMap<string, Bone>) {
    const index = new Map<string, number>();
    const bones: Bone[] = [];
    this.parts = payloads.map((payload) => {
      const fps = payload.fps > 0 ? payload.fps : 30;
      const columns: number[] = [];
      const slots: number[] = [];
      payload.bones.forEach((name, column) => {
        const bone = byName.get(name);
        if (!bone) return;
        let slot = index.get(name);
        if (slot === undefined) {
          slot = bones.length;
          index.set(name, slot);
          bones.push(bone);
        }
        columns.push(column);
        slots.push(slot);
      });
      const stride = payload.bones.length * 4;
      const samples = new Float32Array(payload.frames * slots.length * 4);
      for (let frame = 0; frame < payload.frames; frame += 1) {
        columns.forEach((column, i) => {
          const o = frame * stride + column * 4;
          const q = clipRotation(payload.rotations.subarray(o, o + 4));
          samples.set([q.x, q.y, q.z, q.w], (frame * slots.length + i) * 4);
        });
      }
      return { fps, frames: payload.frames, seconds: Math.max(1, payload.frames - 1) / fps, slots, samples };
    });
    this.bones = bones;
    this.base = bones.map((bone) => bone.quaternion.clone());
    this.target = bones.map(() => new Quaternion());
    this.seconds = this.parts.reduce((sum, part) => sum + part.seconds, 0);
  }

  /** How many bones the emote moves. */
  get moved(): number {
    return this.bones.length;
  }

  /** How far into the still pose's blend the emote is at `seconds`: 0 to 1
   * over the first 0.2 s, 1 until the last 0.2 s, back to 0 at the end. */
  weight(seconds: number): number {
    const into = seconds / EMOTE_BLEND_SECONDS;
    const left = (this.seconds - seconds) / EMOTE_BLEND_SECONDS;
    return smooth(Math.min(1, into, left));
  }

  /** Pose the bones at `seconds` into the sequence. A bone the playing clip
   * leaves alone is at the still pose. */
  apply(seconds: number): void {
    let at = Math.max(0, Math.min(seconds, this.seconds));
    let part = this.parts[this.parts.length - 1]!;
    for (const candidate of this.parts) {
      if (at <= candidate.seconds) {
        part = candidate;
        break;
      }
      at -= candidate.seconds;
    }
    at = Math.min(at, part.seconds);
    const position = Math.min(at * part.fps, part.frames - 1);
    const a = Math.floor(position);
    const b = Math.min(a + 1, part.frames - 1);
    const f = position - a;

    this.bones.forEach((_, i) => this.target[i]!.copy(this.base[i]!));
    const n = part.slots.length;
    for (let i = 0; i < n; i += 1) {
      this.qa.fromArray(part.samples, (a * n + i) * 4);
      this.qb.fromArray(part.samples, (b * n + i) * 4);
      this.target[part.slots[i]!]!.slerpQuaternions(this.qa, this.qb, f);
    }
    const weight = this.weight(seconds);
    this.bones.forEach((bone, i) => bone.quaternion.slerpQuaternions(this.base[i]!, this.target[i]!, weight));
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
