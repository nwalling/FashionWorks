import { describe, expect, it } from 'vitest';

import {
  AA_LARGE,
  AA_TEXT,
  checkContrast,
  contrast,
  luminance,
  toHex,
  toRgb,
  FALLBACK,
  type Tokens,
} from '../src/theme';

/** The live Hangarworks theme, read off the site. */
const HANGARWORKS: Tokens = { ...FALLBACK };

/** A light-leaning theme.
 *
 * `dolomite` is one -- its chip background is `rgb(255 255 255/0.75)` and its
 * shadow is a pale `rgb(15 34 51/0.14)` -- but the site does not ship its full
 * palette in public CSS, so this is a representative stand-in rather than the
 * real thing. Light is the case worth covering: an orange accent that reads
 * comfortably on near-black can fail against near-white.
 */
const LIGHT: Tokens = {
  '--sc-dark': 'rgb(244, 246, 248)',
  '--sc-card': 'rgb(255, 255, 255)',
  '--sc-surface': 'rgb(248, 250, 251)',
  '--sc-surface-2': 'rgb(236, 240, 243)',
  '--sc-field': 'rgb(236, 240, 243)',
  '--sc-border': 'rgb(198, 208, 216)',
  '--sc-border-bright': 'rgb(140, 155, 168)',
  '--sc-text': 'rgb(16, 28, 38)',
  '--sc-subtle': 'rgb(78, 96, 110)',
  '--sc-accent': 'rgb(166, 74, 8)',
  '--sc-accent-ink': 'rgb(255, 255, 255)',
  '--sc-badge': 'rgb(14, 100, 118)',
};

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

  it('gives black for something it cannot parse, and that is visible', () => {
    expect(toRgb('color-mix(in srgb, var(--a), var(--b) 7%)')).toEqual([0, 0, 0]);
  });

  it('converts to the packed hex three.js takes', () => {
    expect(toHex('rgb(255, 138, 52)')).toBe(0xff8a34);
    expect(toHex('rgb(0, 0, 0)')).toBe(0x000000);
  });

  it('computes luminance at the ends of the range', () => {
    expect(luminance('rgb(255, 255, 255)')).toBeCloseTo(1, 5);
    expect(luminance('rgb(0, 0, 0)')).toBeCloseTo(0, 5);
  });

  it('gives 21 for black on white and 1 for a colour on itself', () => {
    expect(contrast('rgb(0,0,0)', 'rgb(255,255,255)')).toBeCloseTo(21, 1);
    expect(contrast('rgb(120,50,10)', 'rgb(120,50,10)')).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    const a = 'rgb(234, 242, 246)';
    const b = 'rgb(22, 41, 47)';
    expect(contrast(a, b)).toBeCloseTo(contrast(b, a), 10);
  });
});

describe('the live Hangarworks theme', () => {
  const results = checkContrast(HANGARWORKS);

  it('passes every pairing the component renders', () => {
    const failures = results.filter((r) => !r.passes);
    expect(
      failures.map((f) => `${f.label}: ${f.ratio.toFixed(2)} < ${f.required}`),
    ).toEqual([]);
  });

  it('reads body text well clear of the AA threshold', () => {
    const body = results.find((r) => r.label === 'body text on the page')!;
    expect(body.ratio).toBeGreaterThan(AA_TEXT);
  });

  it('holds the accent to the large-text threshold, not the body one', () => {
    // An accent is a heading and a button face, never body copy. Holding it to
    // 4.5 would rule out the site's own orange.
    const accent = results.find((r) => r.label === 'accent heading on a card')!;
    expect(accent.required).toBe(AA_LARGE);
    expect(accent.ratio).toBeGreaterThan(AA_LARGE);
  });
});

describe('a light-leaning theme', () => {
  it('passes every pairing too', () => {
    const failures = checkContrast(LIGHT).filter((r) => !r.passes);
    expect(
      failures.map((f) => `${f.label}: ${f.ratio.toFixed(2)} < ${f.required}`),
    ).toEqual([]);
  });

  it('is the case that catches a too-bright accent', () => {
    // The site's own orange on a near-white card is 2.3:1 -- below even the
    // large-text bar. A light theme has to darken it, and this is the check
    // that says so rather than leaving it to be noticed on screen.
    const bright = { ...LIGHT, '--sc-accent': 'rgb(255, 138, 52)' } as Tokens;
    const accent = checkContrast(bright).find((r) => r.label === 'accent heading on a card')!;
    expect(accent.passes).toBe(false);
    expect(accent.ratio).toBeLessThan(AA_LARGE);
  });
});

describe('the checks themselves', () => {
  it('cover every pairing the component actually draws', () => {
    const labels = checkContrast(HANGARWORKS).map((r) => r.label);
    for (const expected of [
      'body text on the page',
      'body text on a card',
      'secondary text on a card',
      'accent button label',
    ]) {
      expect(labels).toContain(expected);
    }
  });

  it('report a ratio even when they fail, so the gap is visible', () => {
    const unreadable = { ...HANGARWORKS, '--sc-text': HANGARWORKS['--sc-dark'] } as Tokens;
    const body = checkContrast(unreadable).find((r) => r.label === 'body text on the page')!;
    expect(body.passes).toBe(false);
    expect(body.ratio).toBeCloseTo(1, 2);
  });
});
