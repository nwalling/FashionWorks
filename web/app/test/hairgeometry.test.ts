import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { sortInnerFirst, strandCoordinate, strandFrame } from '../src/three/hair';

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

  it('carries the distance out from the root as the red itself', () => {
    // What a dye's gradient is set against: the same step is the same
    // distance on a long card and a short one.
    const geometry = cards();
    strandCoordinate(geometry, 0, geometry.getIndex()!.count);
    const d = Array.from(geometry.getAttribute('fwStrandD').array as Float32Array);
    expect(d.slice(0, 8)).toEqual([0, 0, 1, 1, 2, 2, 3, 3].map((s) => Math.fround(s / 255)));
    expect(d.slice(8)).toEqual([0, 0, 1, 1].map((s) => Math.fround(s / 255)));
  });

  it('does nothing without a vertex colour', () => {
    const geometry = cards();
    geometry.deleteAttribute('fwColor');
    expect(strandCoordinate(geometry, 0, geometry.getIndex()!.count)).toBe(false);
    expect(geometry.hasAttribute('fwStrandT')).toBe(false);
  });
  it('gives no coordinate to a mesh whose cards never count, as lashes', () => {
    const geometry = cards();
    const color = geometry.getAttribute('fwColor');
    for (let v = 0; v < color.count; v += 1) color.setX(v, 0);
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

describe('strandFrame', () => {
  it('moves a normal stream that runs along the strand into the tangent', () => {
    const geometry = cards();
    // The archive's hair: the "normal" is the strand, up the card in y.
    const count = geometry.getAttribute('position').count;
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(count * 3).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    expect(strandFrame(geometry, [{ start: 0, count: geometry.getIndex()!.count }])).toBe(true);
    const tangent = geometry.getAttribute('tangent');
    const normal = geometry.getAttribute('normal');
    for (let v = 0; v < count; v += 1) {
      expect([tangent.getX(v), tangent.getY(v), tangent.getZ(v), tangent.getW(v)]).toEqual([0, 1, 0, 1]);
      // The cards lie in the xy plane: their own normal is z.
      expect(Math.abs(normal.getZ(v))).toBeCloseTo(1, 5);
    }
  });

  it('leaves a real normal alone', () => {
    const geometry = cards();
    const count = geometry.getAttribute('position').count;
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(count * 3).map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
    expect(strandFrame(geometry, [{ start: 0, count: geometry.getIndex()!.count }])).toBe(false);
    expect(geometry.hasAttribute('tangent')).toBe(false);
  });
});
