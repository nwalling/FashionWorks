import { describe, expect, it } from 'vitest';

import { toYUp } from '../src/three/geometry';

describe('archive Z-up to three.js Y-up', () => {
  it('maps (x, y, z) to (x, z, -y)', () => {
    expect([...toYUp(new Float32Array([1, 2, 3]))]).toEqual([1, 3, -2]);
  });

  it('puts a helmet at head height, not at the origin', () => {
    // The Sunchaser helmet spans z 1.578 to 1.872 in the archive, and its GLB
    // spans y 1.578 to 1.872. That correspondence is what pins this mapping:
    // it was checked against the pipeline's own output rather than assumed.
    const out = toYUp(new Float32Array([0, 0, 1.578, 0, 0, 1.872]));
    expect(out[1]).toBeCloseTo(1.578, 5);
    expect(out[4]).toBeCloseTo(1.872, 5);
  });

  it('keeps the handedness, so the model is not mirrored', () => {
    // A naive (x, z, y) swap flips handedness and turns a left glove into a
    // right one -- the kind of fault a bounding box cannot show, because the
    // extents are identical either way.
    // Compared component-wise: negating a zero gives -0, which is the same
    // number and not deeply equal to 0.
    const forward = toYUp(new Float32Array([0, 1, 0]));
    expect(forward[1]).toBeCloseTo(0, 6);
    expect(forward[2]).toBeCloseTo(-1, 6);
    const up = toYUp(new Float32Array([0, 0, 1]));
    expect(up[1]).toBeCloseTo(1, 6);
    expect(up[2]).toBeCloseTo(0, 6);
  });

  it('leaves the buffer length alone', () => {
    const out = toYUp(new Float32Array(3 * 1000));
    expect(out.length).toBe(3000);
  });
});
