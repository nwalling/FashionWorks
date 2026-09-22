/** Reading Hangarworks' theme, live.
 *
 * The site switches theme by setting `data-theme` on `<html>`, and its tokens
 * are plain CSS custom properties. CSS picks that up for free; **the 3D view
 * does not**, because a WebGL scene's background, grid and outlines are numbers
 * in a renderer, not styles on an element.
 *
 * So the tokens are read through `getComputedStyle` and re-read when a
 * `MutationObserver` sees `data-theme` change. That is the whole mechanism, and
 * it is what WEB.md's phase 5 exit criterion asks for: *switching theme on the
 * site restyles the page and the 3D view with no reload.*
 *
 * Two things this must survive, because they are the normal case rather than
 * the edge case:
 *
 * * **A token may be a `color-mix()` or a `var()` chain.** The live theme
 *   defines `--sc-surface` as `color-mix(in srgb, var(--sc-card), var(--sc-text)
 *   7%)`. `getComputedStyle` on a custom property returns it *unresolved*, so
 *   it cannot be parsed as a colour. Resolving it needs the browser: set it as
 *   a real property on a probe element and read that back.
 * * **A theme may define only some tokens.** `dolomite` overrides four and
 *   inherits the rest. Anything missing falls back to the base theme's value
 *   rather than to black, which would otherwise render an invisible scene.
 */

/** The tokens the component and the 3D view actually use. */
export const TOKENS = [
  '--sc-dark',
  '--sc-card',
  '--sc-surface',
  '--sc-surface-2',
  '--sc-field',
  '--sc-border',
  '--sc-border-bright',
  '--sc-text',
  '--sc-subtle',
  '--sc-accent',
  // The accent as *type*, which is not the same colour as the accent as a
  // fill. Hangarworks separates them because a fill that works can read at
  // 1.71:1 as a heading on its own card -- darkening the one accent fixes the
  // type and turns the buttons brown. `--sc-accent` fills, this one is text.
  '--sc-accent-text',
  '--sc-accent-ink',
  '--sc-badge',
] as const;

export type TokenName = (typeof TOKENS)[number];
export type Tokens = Record<TokenName, string>;

/** Used when the host defines nothing at all -- a bare page, or a test.
 *
 * These are the live `hangarworks` values, read off the site. They exist so the
 * component renders somewhere sensible standalone, **not** as a design: inside
 * Hangarworks every one of them is overridden.
 */
export const FALLBACK: Tokens = {
  '--sc-dark': '#0a1219',
  '--sc-card': '#16292f',
  '--sc-surface': '#1b2f35',
  '--sc-surface-2': '#1e3a44',
  '--sc-field': '#1e3a44',
  '--sc-border': '#2c4e5d',
  '--sc-border-bright': '#4a6c7c',
  '--sc-text': '#eaf2f6',
  '--sc-subtle': '#9fb6c2',
  '--sc-accent': '#ff8a34',
  '--sc-accent-text': '#ff8a34',
  '--sc-accent-ink': '#0a1219',
  '--sc-badge': '#5ad1e6',
};

/** Resolve a token to a concrete colour string.
 *
 * `getComputedStyle(el).getPropertyValue('--sc-surface')` returns the *declared*
 * value, which on this site is a `color-mix()` referencing two more variables.
 * Assigning it to a real colour property and reading that back makes the
 * browser do the resolution, which is the only thing that can.
 */
function resolveColour(probe: HTMLElement, value: string): string | null {
  if (!value) return null;
  probe.style.color = '';
  probe.style.color = value;
  const resolved = getComputedStyle(probe).color;
  // An unparseable value leaves `color` at its inherited value; a resolved one
  // always comes back as `rgb(...)` or `rgba(...)`.
  return resolved.startsWith('rgb') ? resolved : null;
}

/** Read the current theme's tokens from an element's computed style. */
export function readTokens(from: Element = document.documentElement): Tokens {
  const style = getComputedStyle(from);
  const probe = document.createElement('span');
  probe.style.display = 'none';
  // Appended to the element being read, so `var()` chains resolve against the
  // same theme rather than against the document default.
  (from as HTMLElement).appendChild(probe);
  try {
    const out = {} as Tokens;
    for (const name of TOKENS) {
      const declared = style.getPropertyValue(name).trim();
      out[name] = resolveColour(probe, declared) ?? FALLBACK[name];
    }
    return out;
  } finally {
    probe.remove();
  }
}

/** Watch for theme changes. Returns an unsubscribe.
 *
 * Observes `data-theme` and `class` on `<html>`: the site uses the first, and
 * watching the second costs nothing and covers a host that swaps a class
 * instead.
 */
export function watchTheme(onChange: (tokens: Tokens) => void): () => void {
  const target = document.documentElement;
  const observer = new MutationObserver(() => onChange(readTokens()));
  // `style` as well as `data-theme`: Hangarworks applies a theme by writing the
  // palette straight onto `<html>` with `style.setProperty`, and only then sets
  // the attribute. Watching the attribute alone works today because of that
  // ordering, and would silently stop working if a preview ever set the vars
  // without it.
  observer.observe(target, {
    attributes: true,
    attributeFilter: ['data-theme', 'class', 'style'],
  });
  return () => observer.disconnect();
}

/** A colour string to its three components, 0-255.
 *
 * Handles `rgb()`/`rgba()` in either the comma or the space syntax, and hex in
 * both the three- and six-digit forms. Hex matters: `readTokens` resolves
 * everything to `rgb()`, but a token read straight from a stylesheet -- or a
 * default written by hand -- is usually `#rrggbb`, and parsing that as black
 * makes every contrast ratio come out at exactly 1.0. A whole contrast suite
 * can pass that way while measuring nothing.
 */
export function toRgb(colour: string): [number, number, number] {
  const value = colour.trim();

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const digits = hex[1]!;
    const pairs = digits.length === 3
      ? [...digits].map((d) => d + d)
      : [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6)];
    return pairs.map((p) => parseInt(p, 16)) as [number, number, number];
  }

  const match = value.match(/(-?[\d.]+)[,\s]+(-?[\d.]+)[,\s]+(-?[\d.]+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** A colour as `0xRRGGBB`, which is what three.js takes. */
export function toHex(colour: string): number {
  const [r, g, b] = toRgb(colour);
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

/** A colour's alpha, 0-1. Opaque unless it says otherwise. */
export function alphaOf(colour: string): number {
  const match = colour.trim().match(
    /^rgba?\(\s*[\d.]+[,\s]+[\d.]+[,\s]+[\d.]+[,\s/]+([\d.]+)\s*\)$/i,
  );
  return match ? Math.min(1, Math.max(0, Number(match[1]))) : 1;
}

/** Composite a possibly-translucent colour over its backing.
 *
 * **Several real tokens are translucent.** Hangarworks defines `--sc-field` as
 * `rgba(255, 255, 255, 0.07)` on its dark themes: taken at face value that is
 * white, and a contrast check then reports a dark input as near-white and
 * passes text that is actually unreadable on it. What the eye sees is the
 * composite over whatever sits behind.
 */
export function over(colour: string, backing: string): string {
  const alpha = alphaOf(colour);
  if (alpha >= 1) return colour;
  const [fr, fg, fb] = toRgb(colour);
  const [br, bg, bb] = toRgb(backing);
  const blend = (f: number, b: number) => Math.round(f * alpha + b * (1 - alpha));
  return `rgb(${blend(fr, br)}, ${blend(fg, bg)}, ${blend(fb, bb)})`;
}

/** Relative luminance, per WCAG 2.1. */
export function luminance(colour: string): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = toRgb(colour);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio between two colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA: 4.5 for body text, 3.0 for large text and UI boundaries. */
export const AA_TEXT = 4.5;
export const AA_LARGE = 3.0;

export interface ContrastCheck {
  readonly label: string;
  readonly ratio: number;
  readonly required: number;
  readonly passes: boolean;
}

/** Every text-on-background pairing the component actually renders.
 *
 * Listed explicitly rather than derived, because what matters is the pairs that
 * appear on screen -- checking every token against every other would report
 * failures for combinations nothing ever draws.
 */
export function checkContrast(tokens: Tokens): ContrastCheck[] {
  // `[label, foreground, background, behind the background, required]`.
  //
  // The fourth entry matters because a background token can itself be
  // translucent: a field sits on a card, and `rgba(255,255,255,0.07)` over a
  // dark card is a dark grey, not white.
  const pairs: Array<[string, TokenName, TokenName, TokenName, number]> = [
    ['body text on the page', '--sc-text', '--sc-dark', '--sc-dark', AA_TEXT],
    ['body text on a card', '--sc-text', '--sc-card', '--sc-dark', AA_TEXT],
    ['body text on a field', '--sc-text', '--sc-field', '--sc-card', AA_TEXT],
    ['secondary text on a card', '--sc-subtle', '--sc-card', '--sc-dark', AA_TEXT],
    ['secondary text on the page', '--sc-subtle', '--sc-dark', '--sc-dark', AA_TEXT],
    // The accent as *type* is `--sc-accent-text`, never `--sc-accent`. Checking
    // the fill colour as type reports failures the site has already solved.
    ['accent heading on a card', '--sc-accent-text', '--sc-card', '--sc-dark', AA_LARGE],
    ['accent heading on the page', '--sc-accent-text', '--sc-dark', '--sc-dark', AA_LARGE],
    // And the fill is checked the other way round: the ink that sits on it.
    ['accent button label', '--sc-accent-ink', '--sc-accent', '--sc-card', AA_TEXT],
    ['badge on a card', '--sc-badge', '--sc-card', '--sc-dark', AA_LARGE],
    ['border against the page', '--sc-border', '--sc-dark', '--sc-dark', 1.2],
  ];
  return pairs.map(([label, fore, back, behind, required]) => {
    const background = over(tokens[back], tokens[behind]);
    const foreground = over(tokens[fore], background);
    const ratio = contrast(foreground, background);
    return { label, ratio, required, passes: ratio >= required };
  });
}
