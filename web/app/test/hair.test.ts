import { describe, expect, it } from 'vitest';

import { hairColour } from '../src/three/materials';

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

  it('is the dye colour at full dye amount', () => {
    const c = hairColour({ BaseMelanin: 0.7, DyeColor: new Float32Array([0.2, 0.1, 0.05]), DyeAmount: 1 });
    expect(c.r).toBeCloseTo(0.2, 5);
    expect(c.g).toBeCloseTo(0.1, 5);
    expect(c.b).toBeCloseTo(0.05, 5);
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
    expect(c.getHexString()).toBe('4d3a2b');
  });
});
