import { Bone, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { readCatalogue } from '../src/archive/catalogue';
import { EMOTE_BLEND_SECONDS, EmotePlay } from '../src/three/emote';
import { clipRotation } from '../src/three/rig';

/** An archive `[w, x, y, z]` rotation of `degrees` about the archive's Z. */
function aboutZ(degrees: number): number[] {
  const h = (degrees * Math.PI) / 360;
  return [Math.cos(h), 0, 0, Math.sin(h)];
}

/** One bone turning from `from` to `to` degrees over `frames` frames at 10 fps. */
function payload(bone: string, from: number, to: number, frames = 11) {
  const rotations = new Float32Array(frames * 4);
  for (let f = 0; f < frames; f += 1) rotations.set(aboutZ(from + ((to - from) * f) / (frames - 1)), f * 4);
  return { fps: 10, frames, bones: [bone], rotations };
}

const angle = (a: Quaternion, b: Quaternion) => (2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * 180) / Math.PI;

describe('EmotePlay', () => {
  it('plays a sequence once, end to end, without closing it as a loop', () => {
    const bone = new Bone();
    // A salute: attention to salute, 0 -> 90, then the salute held at 90.
    const play = new EmotePlay([payload('Spine', 0, 90), payload('Spine', 90, 90)], new Map([['Spine', bone]]));
    expect(play.seconds).toBeCloseTo(2, 6);
    play.apply(0.5);
    expect(angle(bone.quaternion, clipRotation(aboutZ(45)))).toBeLessThan(0.05);
    // Into the second clip: held, where a loop would be crawling back to 0.
    play.apply(1.5);
    expect(angle(bone.quaternion, clipRotation(aboutZ(90)))).toBeLessThan(0.05);
  });

  it('blends in from the still pose and back to it', () => {
    const bone = new Bone();
    bone.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), 0.4);
    const still = bone.quaternion.clone();
    const play = new EmotePlay([payload('Spine', 30, 30)], new Map([['Spine', bone]]));
    play.apply(0);
    expect(angle(bone.quaternion, still)).toBeLessThan(1e-4);
    play.apply(EMOTE_BLEND_SECONDS);
    expect(angle(bone.quaternion, clipRotation(aboutZ(30)))).toBeLessThan(0.05);
    play.apply(play.seconds);
    expect(angle(bone.quaternion, still)).toBeLessThan(1e-4);
    play.apply(0.5);
    play.restore();
    expect(angle(bone.quaternion, still)).toBeLessThan(1e-6);
  });

  it('leaves a bone the playing clip does not move at the still pose', () => {
    const spine = new Bone();
    const head = new Bone();
    head.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), 0.3);
    const still = head.quaternion.clone();
    const play = new EmotePlay(
      [payload('Spine', 0, 10), payload('Head', 0, 60)],
      new Map([['Spine', spine], ['Head', head]]),
    );
    expect(play.moved).toBe(2);
    play.apply(0.5);
    expect(angle(head.quaternion, still)).toBeLessThan(1e-4);
    play.apply(1.5);
    expect(angle(head.quaternion, clipRotation(aboutZ(30)))).toBeLessThan(0.05);
  });
});

describe('readCatalogue', () => {
  it('carries the emotes, and drops a kind with nothing to play', () => {
    const json = JSON.stringify({
      items: [],
      gear: [],
      emotes: [
        { kind: 'wave', text: 'You wave.', in_game: true, variants: [['emote_farewell_m_stand_armwave_generic']] },
        { kind: 'dance', text: 'You feel the music.', in_game: false, variants: [] },
      ],
    });
    const catalogue = readCatalogue(json);
    expect(catalogue.emotes.map((e) => e.kind)).toEqual(['wave']);
    expect(readCatalogue(JSON.stringify({ items: [] })).emotes).toEqual([]);
  });
});
