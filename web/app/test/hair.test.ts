import { describe, expect, it } from 'vitest';

import { coverageScale, hairColour } from '../src/three/materials';

const luminance = (c: { r: number; g: number; b: number }) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

describe('hairColour', () => {
  it('darkens as melanin rises', () => {
    const levels = [0.1, 0.4, 0.7, 0.95].map((m) => luminance(hairColour({ BaseMelanin: m })));
    for (let i = 1; i < levels.length; i += 1) expect(levels[i]).toBeLessThan(levels[i - 1]!);
  });

  it('reads warm, red above blue, at any melanin', () => {
    for (const m of [0.2, 0.5, 0.8]) {
      const c = hairColour({ BaseMelanin: m });
      expect(c.r).toBeGreaterThan(c.b);
    }
  });

  it('shifts toward red with redness', () => {
    const plain = hairColour({ BaseMelanin: 0.5, BaseMelaninRedness: 0 });
    const red = hairColour({ BaseMelanin: 0.5, BaseMelaninRedness: 1 });
    expect(red.r / red.g).toBeGreaterThan(plain.r / plain.g);
  });

  it('absorbs: a full dye multiplies the pigment by the dye colour', () => {
    const base = hairColour({ BaseMelanin: 0.3 });
    const c = hairColour({ BaseMelanin: 0.3, DyeColor: new Float32Array([0.2, 0.1, 0.05]), DyeAmount: 1 });
    expect(c.r).toBeCloseTo(base.r * 0.2, 6);
    expect(c.g).toBeCloseTo(base.g * 0.1, 6);
    expect(c.b).toBeCloseTo(base.b * 0.05, 6);
  });

  it('leaves black hair black under a coloured dye', () => {
    // The brow preset seven archive characters share: black melanin, a blue
    // dye at full amount. Mixed to the dye, every one of them had blue brows.
    const c = hairColour({ BaseMelanin: 0.9995, DyeColor: new Float32Array([0.0024, 0.0012, 0.332]), DyeAmount: 1 });
    expect(Math.max(c.r, c.g, c.b)).toBeLessThan(0.001);
  });

  it('leaves a beard dark under a near-white dye, as Ilucide wears it in game', () => {
    const plain = hairColour({ BaseMelanin: 1 });
    const dyed = hairColour({ BaseMelanin: 1, DyeColor: new Float32Array([0.991, 0.991, 0.991]), DyeAmount: 0.707 });
    expect(dyed.r).toBeLessThanOrEqual(plain.r);
  });

  it('gives hair_31 its near-black brown', () => {
    // m_hair_31.mtl's own parameters.
    const c = hairColour({
      BaseMelanin: 0.69207001,
      BaseMelaninRedness: 0,
      DyeColor: new Float32Array([0.16826943, 0.099898733, 0.057805438]),
      DyeAmount: 0.40782699,
      BaseTintColor: new Float32Array([1, 1, 1]),
    });
    expect(c.getHexString()).toBe('100400');
  });
});

describe('coverageScale', () => {
  it('makes the fraction passing the test the mean opacity', () => {
    // Thin strands smeared to a quarter opacity over 40% of the texels: mean
    // 0.1, so a tenth of the texels should pass, not none.
    const level = new Float32Array(1000);
    for (let i = 0; i < 400; i += 1) level[i] = 0.25 * (0.5 + (i % 100) / 100);
    const mean = level.reduce((a, b) => a + b, 0) / level.length;
    const scale = coverageScale(level, 0.35);
    const passing = level.filter((v) => v * scale > 0.35).length / level.length;
    expect(Math.abs(passing - mean)).toBeLessThan(0.01);
  });

  it('never thins a mask', () => {
    expect(coverageScale(new Float32Array([1, 1, 0, 0]), 0.35)).toBe(1);
  });
});
