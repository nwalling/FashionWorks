import { describe, expect, it } from 'vitest';

import { bc1Mean } from '../src/three/live';

describe('live surfaces', () => {
  it('takes a BC1 texture mean from its blocks', () => {
    // One 4x4 block, both endpoints mid-grey 0x8410 (sRGB ~132/255), all
    // indices 0: the mean is that grey, linearised.
    const block = new Uint8Array([0x10, 0x84, 0x10, 0x84, 0, 0, 0, 0]);
    const mean = bc1Mean([block], 4);
    const g = 132 / 255;
    const expected = ((g + 0.055) / 1.055) ** 2.4;
    expect(mean).toBeCloseTo(expected, 2);
  });
});
