import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { sortInnerFirst, strandCoordinate } from '../src/three/hair';

/** Two cards side by side, each a strip of quads whose vertex red counts the
 * step from root to tip: the first three steps long, the second one. */
function cards(): BufferGeometry {
  const positions: number[] = [];
  const colours: number[] = [];
  const indices: number[] = [];
  let base = 0;
  for (const [x, steps] of [[0, 3], [5, 1]] as const) {
    for (let s = 0; s <= steps; s += 1) {
      for (const dx of [0, 1]) {
        positions.push(x + dx, s, 0);
        colours.push(s, 255, 255, 255);
      }
    }
    for (let s = 0; s < steps; s += 1) {
      const a = base + s * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    base += (steps + 1) * 2;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('fwColor', new BufferAttribute(new Uint8Array(colours), 4, true));
  geometry.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
  return geometry;
}

describe('strandCoordinate', () => {
  it('runs each card from 0 at its root to 1 at its tip', () => {
    const geometry = cards();
    expect(strandCoordinate(geometry, 0, geometry.getIndex()!.count)).toBe(true);
    const t = Array.from(geometry.getAttribute('fwStrandT').array as Float32Array);
    // The long card: steps 0..3 over its peak of 3.
    expect(t.slice(0, 8)).toEqual([0, 0, 1 / 3, 1 / 3, 2 / 3, 2 / 3, 1, 1].map((v) => Math.fround(v)));
    // The short card reaches its tip in one step, by its own peak.
    expect(t.slice(8)).toEqual([0, 0, 1, 1]);
  });

  it('does nothing without a vertex colour', () => {
    const geometry = cards();
    geometry.deleteAttribute('fwColor');
    expect(strandCoordinate(geometry, 0, geometry.getIndex()!.count)).toBe(false);
    expect(geometry.hasAttribute('fwStrandT')).toBe(false);
  });
});

describe('sortInnerFirst', () => {
  it('orders triangles by distance from the centre, keeping each whole', () => {
    const geometry = cards();
    const index = geometry.getIndex()!;
    const before = new Set<string>();
    for (let i = 0; i < index.count; i += 3) before.add([index.getX(i), index.getX(i + 1), index.getX(i + 2)].join());
    sortInnerFirst(geometry, 0, index.count, new Vector3(5.5, 0.5, 0));
    const position = geometry.getAttribute('position');
    const distances: number[] = [];
    const after = new Set<string>();
    for (let i = 0; i < index.count; i += 3) {
      const v = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
      after.add(v.join());
      const c = v.reduce((sum, k) => sum.add(new Vector3(position.getX(k), position.getY(k), 0)), new Vector3()).divideScalar(3);
      distances.push(c.distanceTo(new Vector3(5.5, 0.5, 0)));
    }
    expect(after).toEqual(before);
    for (let i = 1; i < distances.length; i += 1) expect(distances[i]).toBeGreaterThanOrEqual(distances[i - 1]! - 1e-6);
  });
});
