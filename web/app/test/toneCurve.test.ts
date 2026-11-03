import { Color, NeutralToneMapping, ShaderChunk } from 'three';
import { describe, expect, it } from 'vitest';

import { untoneMapped } from '../src/three/sceneTheme';
import { NEUTRAL_SHOULDER, softenNeutralShoulder } from '../src/three/toneCurve';

describe('the tone curve', () => {
  it('moves Neutral\'s shoulder in the shader, once', () => {
    softenNeutralShoulder();
    softenNeutralShoulder();
    const chunk = ShaderChunk.tonemapping_pars_fragment;
    expect(chunk).toContain(`const float StartCompression = ${NEUTRAL_SHOULDER.toFixed(4)};`);
    expect(chunk).not.toContain('0.8 - 0.04');
  });

  it('starts above the light capture backdrop, which the alpha solves need straight', () => {
    // 0.8 linear at the backdrop's exposure of 0.7, less Neutral's offset.
    expect(NEUTRAL_SHOULDER).toBeGreaterThan(0.8 * 0.7 - 0.04);
  });

  it('inverts on the shoulder as the shader draws it', () => {
    // A light page colour lands on the shoulder: the inverse has to know where it starts.
    const target = new Color().setRGB(0.9, 0.88, 0.85);
    const lit = untoneMapped(target, 1.4, NeutralToneMapping, new Color());
    expect(lit.r * 1.4 - 0.04).toBeGreaterThan(NEUTRAL_SHOULDER);
    // Forward again by hand: Khronos's shoulder from NEUTRAL_SHOULDER.
    const c = [lit.r * 1.4 - 0.04, lit.g * 1.4 - 0.04, lit.b * 1.4 - 0.04];
    const peak = Math.max(...c);
    const d = 1 - NEUTRAL_SHOULDER;
    const top = 1 - (d * d) / (peak + d - NEUTRAL_SHOULDER);
    const g = 1 - 1 / (0.15 * (peak - top) + 1);
    const out = c.map((v) => (v * top) / peak).map((v) => v + (top - v) * g);
    expect(out[0]).toBeCloseTo(0.9, 3);
    expect(out[1]).toBeCloseTo(0.88, 3);
    expect(out[2]).toBeCloseTo(0.85, 3);
  });

  it('inverts a dark page colour through the toe', () => {
    for (const exposure of [0.7, 1.4, 2.6]) {
      for (const hex of [0x0b0d12, 0x16181d, 0x2a2c31, 0x101820]) {
        const target = new Color(hex);
        const lit = untoneMapped(target, exposure, NeutralToneMapping, new Color());
        // The toe: what falls below 0.08 loses x - 6.25 x^2 of its least channel.
        const c = [lit.r, lit.g, lit.b].map((v) => v * exposure);
        const x = Math.min(...c);
        const off = x < 0.08 ? x - 6.25 * x * x : 0.04;
        const out = c.map((v) => v - off);
        expect(out[0]).toBeCloseTo(target.r, 4);
        expect(out[1]).toBeCloseTo(target.g, 4);
        expect(out[2]).toBeCloseTo(target.b, 4);
      }
    }
  });
});
