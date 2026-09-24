import { describe, expect, it } from 'vitest';

import { convergence, probeStatistics } from '../src/three/lighting';

describe('lighting', () => {
  it('finds the point an authored rig is aimed at', () => {
    // Two spots from either side, both aimed at (1, 2, 3).
    const aim = { x: 1, y: 2, z: 3 };
    const spot = (from: [number, number, number]) => {
      const d = [aim.x - from[0], aim.y - from[1], aim.z - from[2]] as [number, number, number];
      return { name: '', kind: 'Projector', position: from, direction: d, color: [1, 1, 1] as [number, number, number], intensity: 1, radius: 1, fov: 90, texture: null };
    };
    const p = convergence([spot([0, 0, 3]), spot([3, 2, 0]), spot([1, 5, 5])]);
    expect(p.x).toBeCloseTo(1, 5);
    expect(p.y).toBeCloseTo(2, 5);
    expect(p.z).toBeCloseTo(3, 5);
  });

  it('aims the key at the brightest part of a probe, upright', () => {
    // A 4x4 cube, dim everywhere except the +Y face: light from above.
    const size = 4;
    const rgba = new Float32Array(size * size * 6 * 4).fill(0.01);
    for (let i = 0; i < size * size; i += 1) {
      const k = (2 * size * size + i) * 4;
      rgba[k] = 5; rgba[k + 1] = 5; rgba[k + 2] = 5;
    }
    const { key, mean } = probeStatistics(size, rgba);
    expect(key.y).toBeGreaterThan(0.95);
    expect(mean).toBeGreaterThan(0.01);
  });
});
