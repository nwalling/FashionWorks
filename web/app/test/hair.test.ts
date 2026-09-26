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

  it('mixes toward the dye by the share of strands it reaches', () => {
    // A full amount reaches 45% of strands, each drawn at 30% of the dye
    // colour: the average over a head of hair.
    const base = hairColour({ BaseMelanin: 0.7 });
    const c = hairColour({ BaseMelanin: 0.7, DyeColor: new Float32Array([1, 1, 1]), DyeAmount: 1 });
    expect(c.r).toBeCloseTo(base.r + (0.3 - base.r) * 0.45, 5);
  });

  it('leaves no dye at amount zero', () => {
    const base = hairColour({ BaseMelanin: 0.7 });
    const c = hairColour({ BaseMelanin: 0.7, DyeColor: new Float32Array([1, 1, 1]), DyeAmount: 0 });
    expect(c.getHexString()).toBe(base.getHexString());
  });

  it('gives hair_31 its dark brown', () => {
    // m_hair_31.mtl's own parameters.
    const c = hairColour({
      BaseMelanin: 0.69207001,
      BaseMelaninRedness: 0,
      DyeColor: new Float32Array([0.16826943, 0.099898733, 0.057805438]),
      DyeAmount: 0.40782699,
      BaseTintColor: new Float32Array([1, 1, 1]),
    });
    expect(c.getHexString()).toBe('24160b');
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

  it('passes every texel that holds anything when the target is out of reach', () => {
    // A tenth of texels hold a faint 0.1; a target of half cannot be met, so
    // all of them should pass rather than none.
    const level = new Float32Array(100);
    for (let i = 0; i < 10; i += 1) level[i] = 0.1;
    const scale = coverageScale(level, 0.35, 50);
    expect(level.filter((v) => v * scale >= 0.35).length).toBe(10);
  });
});
