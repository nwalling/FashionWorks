import { BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';

import { covered, showUncovered, type ZoneChunk } from '../src/three/zones';

// A short-sleeved shirt: torso and upper arm at layer 1, the sleeve's last
// zone leaving the body drawn under it.
const shirt: ZoneChunk[] = [
  { zone: 'torso01_zone', layer: 1, visible: [] },
  { zone: 'l_arm01_zone', layer: 1, visible: [] },
  { zone: 'l_arm02_zone', layer: 1, visible: [0] },
];
const jacket: ZoneChunk[] = [
  { zone: 'torso01_zone', layer: 2, visible: [] },
  { zone: 'l_arm02_zone', layer: 2, visible: [] },
];

describe('zones', () => {
  it('hides a lower layer where a higher one covers the zone', () => {
    expect(covered('torso01_zone', 0, shirt)).toBe(true);
    expect(covered('l_arm03_zone', 0, shirt)).toBe(false);
  });

  it('leaves the body drawn under a zone the sleeve only partly covers', () => {
    expect(covered('l_arm02_zone', 0, shirt)).toBe(false);
    // ...but not the shirt itself under a jacket that covers it fully.
    expect(covered('l_arm02_zone', 1, [...shirt, ...jacket])).toBe(true);
  });

  it('never hides an item under its own layer, or a zone with no name', () => {
    expect(covered('torso01_zone', 1, shirt)).toBe(false);
    expect(covered(null, 0, shirt)).toBe(false);
  });

  it('re-filters from the full group list each time', () => {
    const geometry = new BufferGeometry();
    geometry.addGroup(0, 3, 0);
    geometry.addGroup(3, 3, 0);
    (geometry.groups[0] as { zone?: string }).zone = 'torso01_zone';
    (geometry.groups[1] as { zone?: string }).zone = 'l_arm03_zone';
    expect(showUncovered(geometry, 0, shirt)).toBe(1);
    expect(geometry.groups).toHaveLength(1);
    expect(showUncovered(geometry, 0, [])).toBe(0);
    expect(geometry.groups).toHaveLength(2);
  });
});
