import { describe, expect, it } from 'vitest';

import { filmValue } from '../src/three/film';

// Where on the interference ramp (80-800 nm) a film with no ramp is read.
const nm = (u: number) => 80 + 720 * filmValue({ u, v: 0.09, strength: 5 }, false).x;

describe('film', () => {
  it('reads a film with no ramp at a thickness in proportion to its own', () => {
    // The game's icons: Mirage blue-violet, Venom green, Glimmer violet-blue.
    expect(nm(0.045)).toBeCloseTo(211.5, 1);
    expect(nm(0.06)).toBeCloseTo(282, 1);
    expect(nm(0.09)).toBeCloseTo(423, 1);
  });

  it('reads a named ramp by the material, and states nothing for the template', () => {
    expect(filmValue({ u: 1, v: 0.3, strength: 1 }, true).w).toBe(0);
    expect(filmValue({ u: 1, v: 1, strength: 1 }, false).z).toBe(0);
    expect(filmValue(undefined, false).z).toBe(0);
  });
});
