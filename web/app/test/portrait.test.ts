import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BACKGROUND,
  FRAMING,
  portraitBackgrounds,
  portraitFileName,
  portraitView,
  solveCutout,
} from '../src/three/portrait';

const toLinear = (byte: number) => {
  const v = byte / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const toByte = (l: number) => {
  const v = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
};

describe('portraitBackgrounds', () => {
  it('keeps the host order, so its first entry is preselected', () => {
    const list = portraitBackgrounds([
      { id: 'dolomite', name: 'Dolomite', from: '#AABBCC', to: '#112233' },
      { id: 'ember', name: 'Ember', from: '#ff8800', to: '#220000' },
    ]);
    expect(list.map((b) => b.id)).toEqual(['dolomite', 'ember']);
  });

  it('drops malformed and repeated entries, and falls back to the default', () => {
    const list = portraitBackgrounds([
      { id: 'short', name: 'Short', from: '#abc', to: '#000000' },
      { id: '', name: 'Nameless', from: '#000000', to: '#000000' },
      { id: 'ok', name: 'Ok', from: '#010203', to: '#040506' },
      { id: 'ok', name: 'Again', from: '#010203', to: '#040506' },
    ]);
    expect(list.map((b) => b.name)).toEqual(['Ok']);
    expect(portraitBackgrounds(undefined)).toEqual([DEFAULT_BACKGROUND]);
    expect(portraitBackgrounds([{ id: 'x', name: 'X', from: 'red', to: 'blue' }])).toEqual([DEFAULT_BACKGROUND]);
  });
});

describe('portraitView', () => {
  it('stands in front of the face, off to one side and a little above, framing the set height', () => {
    const head: [number, number, number] = [0, 1.7, 0];
    const { position, target, fov } = portraitView(head);
    expect(target).toEqual([0, 1.7 + FRAMING.lift, 0]);
    expect(fov).toBe(FRAMING.fov);
    // The figure faces negative z.
    expect(position[2]).toBeLessThan(0);
    expect(position[0]).toBeGreaterThan(0);
    expect(position[1]).toBeGreaterThan(target[1]);
    const distance = Math.hypot(position[0] - target[0], position[1] - target[1], position[2] - target[2]);
    // At that distance the vertical field spans exactly the frame's height.
    expect(2 * distance * Math.tan((fov * Math.PI) / 360)).toBeCloseTo(FRAMING.height, 6);
  });
});

describe('solveCutout', () => {
  it('recovers coverage and colour from two backgrounds through an affine tone curve', () => {
    // The screen as a tone curve affine in linear light over this range.
    const curve = (l: number) => 0.06 + 0.82 * l;
    const backs = [0.2, 0.8].map((g) => toByte(curve(g)));
    const object = [0.31, 0.12, 0.05];
    const pixels: Array<{ alpha: number }> = [{ alpha: 1 }, { alpha: 0.5 }, { alpha: 0.2 }, { alpha: 0 }];
    const frame = (grey: number) => new Uint8ClampedArray(pixels.flatMap(({ alpha }) => [
      ...object.map((o) => toByte(curve(alpha * o + (1 - alpha) * grey))),
      255,
    ]));
    const out = solveCutout(
      frame(0.2),
      frame(0.8),
      [backs[0]!, backs[0]!, backs[0]!],
      [backs[1]!, backs[1]!, backs[1]!],
    );
    pixels.forEach(({ alpha }, i) => {
      expect(Math.abs(out[i * 4 + 3]! / 255 - alpha)).toBeLessThan(0.02);
      if (alpha >= 0.5) {
        // Colour as the screen shows the object on its own.
        object.forEach((o, k) => expect(Math.abs(out[i * 4 + k]! - toByte(curve(o)))).toBeLessThanOrEqual(3));
      }
    });
    expect(toLinear(0)).toBe(0);
  });
});

describe('portraitFileName', () => {
  it('names the file after the character, safely', () => {
    expect(portraitFileName('Ilucide')).toBe('ilucide-portrait.jpg');
    expect(portraitFileName('Dr. Zöe / Mk II')).toBe('dr-zoe-mk-ii-portrait.jpg');
    expect(portraitFileName(null)).toBe('fashionworks-portrait.jpg');
    expect(portraitFileName('///')).toBe('fashionworks-portrait.jpg');
  });
});
