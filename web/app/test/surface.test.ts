import { describe, expect, it } from 'vitest';

import { rasterOwners, UNOWNED } from '../src/three/surface';

/** Two submaterials, each a triangle pair covering one half of UV space. */
function halves(overlap = 0) {
  const uvs = new Float32Array([
    0, 0, 0.5 + overlap, 0, 0.5 + overlap, 1, 0, 1,
    0.5, 0, 1, 0, 1, 1, 0.5, 1,
  ]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return [{ uvs, indices, submeshes: [
    { materialId: 0, start: 0, count: 6 },
    { materialId: 1, start: 6, count: 6 },
  ] }];
}

describe('the UV owner map', () => {
  it('gives each texel to the submaterial whose triangles cover it', () => {
    const { core } = rasterOwners(halves(), 16, 2);
    expect(core[4 * 16 + 2]).toBe(0);
    expect(core[4 * 16 + 13]).toBe(1);
  });

  it('dilates islands into the gutter so filtering at an edge finds colour', () => {
    // One small island in the middle of an otherwise empty square.
    const uvs = new Float32Array([0.4, 0.4, 0.6, 0.4, 0.6, 0.6, 0.4, 0.6]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const { core, map } = rasterOwners(
      [{ uvs, indices, submeshes: [{ materialId: 3, start: 0, count: 6 }] }], 32, 4, 2,
    );
    const at = (y: number, x: number) => y * 32 + x;
    expect(core[at(16, 11)]).toBe(UNOWNED);
    expect(map[at(16, 11)]).toBe(3);
    expect(map[at(0, 0)]).toBe(UNOWNED);
  });

  it('reports submaterials that share UV space, so they get a bake of their own', () => {
    const { overlap } = rasterOwners(halves(0.25), 32, 2);
    expect(overlap.get(1)!).toBeGreaterThan(0.1);
    expect(rasterOwners(halves(), 32, 2).overlap.get(1)!).toBeLessThan(0.1);
  });

  it('never lets a group past the material list claim a texel', () => {
    const { core } = rasterOwners(halves(), 16, 1);
    expect(core.some((id) => id === 1)).toBe(false);
  });
});
