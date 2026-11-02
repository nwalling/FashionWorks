import { describe, expect, it } from 'vitest';

import { neutralGreyGain } from '../../gpu/bake.js';
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

  it("lifts a vehicle paint's flat grey texture to neutral, and nothing else", () => {
    const panel = 'Textures/vehicles/panels/low_freq/painted/fine/panel_a_base_diff.tif';
    expect(neutralGreyGain(panel, 0.408, false, 1)).toBeCloseTo(1 / 0.408, 6);
    // Not painted by the palette, a metal, or a near-white texture: as it was.
    expect(neutralGreyGain(panel, 0.408, false, 0)).toBe(1);
    expect(neutralGreyGain(panel, 0.408, true, 2)).toBe(1);
    expect(neutralGreyGain('Textures/vehicles/tileables/paint/ship_mf_paint_c_diff.tif', 0.788, false, 1)).toBe(1);
    // FPS layers never move: their paint sits near white, a weapon's grease is meant dark.
    expect(neutralGreyGain('textures/layers/grunge/painted_surface_02_diff.tif', 0.45, false, 1)).toBe(1);
    expect(neutralGreyGain('textures/layers/grunge/weapon_grease_01_diff.tif', 0.063, false, 1)).toBe(1);
  });
});
