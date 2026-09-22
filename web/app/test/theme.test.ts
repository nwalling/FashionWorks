import { describe, expect, it } from 'vitest';

import {
  AA_LARGE,
  AA_TEXT,
  alphaOf,
  checkContrast,
  contrast,
  luminance,
  over,
  toHex,
  toRgb,
  type Tokens,
} from '../src/theme';

/** Hangarworks' real themes, from its own `src/lib/themes.ts`.
 *
 * Seven, not four, and **three of them are light** — so a light theme is the
 * common case rather than the edge case. Two details of the real registry
 * shape these tests:
 *
 * * **`accentText` is a separate colour from `accent`.** A fill that works can
 *   read at 1.71:1 as a heading on its own card; darkening the one accent fixes
 *   the type and turns the buttons brown. So the site ships both, and a check
 *   that holds the *fill* to a type threshold reports failures it already
 *   solved.
 * * **Several tokens are translucent.** `--sc-field` is
 *   `rgba(255, 255, 255, 0.07)` on the dark themes. Read at face value that is
 *   white; composited over the card it is a dark grey.
 *
 * `--sc-surface` and `--sc-surface-2` are `color-mix()` in the site's
 * stylesheet, so they are approximated here — nothing in `checkContrast` uses
 * them, and the browser resolves them for real at runtime.
 */
function theme(p: {
  bg: string; card: string; border: string; field: string; text: string;
  subtle: string; accent: string; badge: string; accentText?: string; accentInk?: string;
}): Tokens {
  return {
    '--sc-dark': p.bg,
    '--sc-card': p.card,
    '--sc-surface': p.card,
    '--sc-surface-2': p.field,
    '--sc-field': p.field,
    '--sc-border': p.border,
    '--sc-border-bright': p.border,
    '--sc-text': p.text,
    '--sc-subtle': p.subtle,
    '--sc-accent': p.accent,
    '--sc-accent-text': p.accentText ?? p.accent,
    '--sc-accent-ink': p.accentInk ?? '#0a1219',
    '--sc-badge': p.badge,
  };
}

const THEMES: Array<{ id: string; dark: boolean; tokens: Tokens }> = [
  {
    id: 'hangarworks', dark: true,
    tokens: theme({
      bg: '#0A1219', card: '#16292F', border: '#2C4E5D', field: '#1E3A44',
      text: '#EAF2F6', subtle: '#9FB6C2', accent: '#FF8A34', badge: '#5AD1E6',
    }),
  },
  {
    id: 'dark', dark: true,
    tokens: theme({
      bg: '#0a1c38', card: '#12305a', border: '#23417a',
      field: 'rgba(255, 255, 255, 0.07)', text: '#ffffff',
      subtle: 'rgba(255, 255, 255, 0.6)', accent: '#C8A84B', badge: '#1E90FF',
    }),
  },
  {
    id: 'navy', dark: false,
    tokens: theme({
      bg: '#f6f7fb', card: '#eaeff7', border: '#c3d7ed',
      field: 'rgba(0, 46, 102, 0.08)', text: '#0a1c38', subtle: '#546277',
      accent: '#C8A84B', accentText: '#72602b', badge: '#1462ad',
    }),
  },
  {
    id: 'dolomite', dark: false,
    tokens: theme({
      bg: '#ffffff', card: '#ccd0d9', border: '#b1b8c5',
      field: 'rgba(51, 51, 51, 0.05)', text: '#333333', subtle: '#505153',
      accent: '#e8872b', accentText: '#764416', badge: '#12589c',
    }),
  },
  {
    id: 'nightrunner', dark: true,
    tokens: theme({
      bg: '#0f0e11', card: '#26232c', border: '#3a3641',
      field: 'rgba(255, 255, 255, 0.06)', text: '#ffffff',
      subtle: 'rgba(255, 255, 255, 0.6)', accent: '#ff453a',
      accentText: '#ff7067', badge: '#5aa9e6',
    }),
  },
  {
    id: 'lovestruck', dark: true,
    tokens: theme({
      bg: '#1a0e16', card: '#2a1422', border: '#43203a',
      field: 'rgba(255, 255, 255, 0.06)', text: '#fdeef5',
      subtle: 'rgba(253, 238, 245, 0.6)', accent: '#ff4d8d', badge: '#c77dff',
    }),
  },
  {
    id: 'keystone', dark: false,
    tokens: theme({
      bg: '#ffffff', card: '#cdd6e7', border: '#9fb1cb',
      field: 'rgba(53, 61, 93, 0.08)', text: '#353d5d', subtle: '#4c546f',
      accent: '#2e73b8', accentText: '#22568b', accentInk: '#ffffff',
      badge: '#4b4f58',
    }),
  },
];

describe('colour maths', () => {
  it('parses rgb strings, spaced or comma-separated', () => {
    expect(toRgb('rgb(10, 18, 25)')).toEqual([10, 18, 25]);
    expect(toRgb('rgb(10 18 25)')).toEqual([10, 18, 25]);
    expect(toRgb('rgba(10, 18, 25, 0.5)')).toEqual([10, 18, 25]);
  });

  it('parses hex, which is how a stylesheet usually spells a token', () => {
    // Not parsing hex makes every ratio exactly 1.0, which a contrast suite
    // will happily report as "all passing" while measuring nothing.
    expect(toRgb('#0a1219')).toEqual([10, 18, 25]);
    expect(toRgb('#FF8A34')).toEqual([255, 138, 52]);
    expect(toRgb('#fff')).toEqual([255, 255, 255]);
  });

  it('converts to the packed hex three.js takes', () => {
    expect(toHex('rgb(255, 138, 52)')).toBe(0xff8a34);
  });

  it('gives 21 for black on white and 1 for a colour on itself', () => {
    expect(contrast('rgb(0,0,0)', 'rgb(255,255,255)')).toBeCloseTo(21, 1);
    expect(contrast('rgb(120,50,10)', 'rgb(120,50,10)')).toBeCloseTo(1, 5);
  });

  it('computes luminance at the ends of the range', () => {
    expect(luminance('rgb(255,255,255)')).toBeCloseTo(1, 5);
    expect(luminance('rgb(0,0,0)')).toBeCloseTo(0, 5);
  });
});

describe('translucent tokens', () => {
  it('reads an alpha where there is one', () => {
    expect(alphaOf('rgba(255, 255, 255, 0.07)')).toBeCloseTo(0.07, 5);
    expect(alphaOf('rgb(255, 255, 255)')).toBe(1);
    expect(alphaOf('#ffffff')).toBe(1);
  });

  it('composites over the backing rather than taking the colour at face value', () => {
    // `--sc-field` on the Night theme. At face value it is white; over its card
    // it is a slightly lifted navy, and the difference decides whether white
    // text on it passes or fails.
    const composited = over('rgba(255, 255, 255, 0.07)', '#12305a');
    expect(toRgb(composited)[0]).toBeLessThan(50);
    expect(contrast('#ffffff', composited)).toBeGreaterThan(AA_TEXT);
    // Taken at face value it would read as white on white.
    expect(contrast('#ffffff', 'rgb(255,255,255)')).toBeCloseTo(1, 2);
  });

  it('leaves an opaque colour alone', () => {
    expect(over('#16292f', '#0a1219')).toBe('#16292f');
  });
});

describe('every Hangarworks theme', () => {
  for (const { id, tokens } of THEMES) {
    it(`${id} passes every pairing the component draws`, () => {
      const failures = checkContrast(tokens).filter((r) => !r.passes);
      expect(
        failures.map((f) => `${f.label}: ${f.ratio.toFixed(2)} < ${f.required}`),
      ).toEqual([]);
    });
  }

  it('covers light themes as well as dark', () => {
    // Three of the seven are light, so this is the common case.
    expect(THEMES.filter((t) => !t.dark)).toHaveLength(3);
  });
});

describe('the accent, as fill and as type', () => {
  it('is checked as type using accentText, not the fill colour', () => {
    // Dolomite's fill orange is 2.65:1 as type on white, which is why the site
    // ships a separate darker one. Holding the fill to a type threshold would
    // report a failure the site has already solved.
    const dolomite = THEMES.find((t) => t.id === 'dolomite')!.tokens;
    expect(contrast(dolomite['--sc-accent'], dolomite['--sc-dark'])).toBeLessThan(AA_LARGE);
    const heading = checkContrast(dolomite)
      .find((r) => r.label === 'accent heading on the page')!;
    expect(heading.passes).toBe(true);
  });

  it('checks the ink that sits on the fill', () => {
    // Keystone's blue needs white ink: near-black gives 3.83:1 and white 4.93.
    const keystone = THEMES.find((t) => t.id === 'keystone')!.tokens;
    const label = checkContrast(keystone).find((r) => r.label === 'accent button label')!;
    expect(label.passes).toBe(true);
    expect(contrast('#0a1219', keystone['--sc-accent'])).toBeLessThan(AA_TEXT);
  });
});

describe('the checks themselves', () => {
  it('report a ratio even when they fail, so the gap is visible', () => {
    const base = THEMES[0]!.tokens;
    const unreadable = { ...base, '--sc-text': base['--sc-dark'] } as Tokens;
    const body = checkContrast(unreadable).find((r) => r.label === 'body text on the page')!;
    expect(body.passes).toBe(false);
    expect(body.ratio).toBeCloseTo(1, 2);
  });
});
