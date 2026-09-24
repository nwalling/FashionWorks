import { BufferAttribute, BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';

import { decalRoughness, hasDecalUvs, padDecalUvs } from '../src/three/decal';

const sub = (params: Record<string, number>) => ({ params }) as unknown as Parameters<typeof decalRoughness>[0];

describe('decals', () => {
  it('reads DecalGloss on the archive 0-255 scale', () => {
    // The Shogun Kiba's shogun_m states 133.43.
    expect(decalRoughness(sub({ DecalGloss: 133.43 }))).toBeCloseTo(1 - 133.43 / 255, 5);
    expect(decalRoughness(sub({ DiffuseDecalGloss: 10 }))).toBeCloseTo(1 - 10 / 255, 5);
    expect(decalRoughness(sub({}))).toBe(0.5);
  });

  it('pads a mesh with no decal UVs to the sheet\'s empty corner', () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(6), 3));
    padDecalUvs(geometry);
    expect(hasDecalUvs(geometry)).toBe(true);
    expect(Array.from(geometry.getAttribute('fwDecalUv').array)).toEqual([0, 0.99, 0, 0.99].map(Math.fround));
  });
});
