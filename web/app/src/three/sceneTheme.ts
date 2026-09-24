/** Making the 3D view follow the site's theme.
 *
 * CSS handles the panels for free. A WebGL scene does not: its background,
 * grid, outlines and shadow tint are numbers held by a renderer, and nothing
 * re-reads them when `data-theme` changes. This applies them.
 *
 * Everything here reads from [`Tokens`] and nothing has a colour of its own --
 * which is rule 2 of WEB.md's look-and-feel section, and why the package has no
 * hex values in it.
 */

import { NeutralToneMapping, NoToneMapping, type Color, type GridHelper, type Scene, type ToneMapping, type WebGLRenderer } from 'three';

import { contrast, toHex, type Tokens } from '../theme';

export interface ThemedScene {
  scene: Scene;
  renderer: WebGLRenderer;
  grid?: GridHelper;
}

/** How far the grid sits from the page colour.
 *
 * A grid drawn in `--sc-border` vanishes on a theme whose border and background
 * are close, and glares on one where they are far apart. Mixing toward the
 * text colour by a fixed amount keeps it visible on both without either being
 * hard-coded.
 */
const GRID_MIX = 0.35;
const GRID_MIX_MINOR = 0.15;

function mix(a: string, b: string, amount: number): number {
  const parse = (colour: string) => {
    const m = colour.match(/(-?[\d.]+)[,\s]+(-?[\d.]+)[,\s]+(-?[\d.]+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  };
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const blend = (x: number, y: number) => Math.round(x + (y - x) * amount);
  return (blend(ar!, br!) << 16) | (blend(ag!, bg!) << 8) | blend(ab!, bb!);
}

/** Apply a theme to a scene. Safe to call on every theme change. */
export function applyTheme(target: ThemedScene, tokens: Tokens): void {
  (target.scene.background as Color | null)?.setHex(toHex(tokens['--sc-dark']));
  if (!target.scene.background) {
    // A scene with no background object yet: setting the hex directly would
    // throw, so leave it for the caller's initial setup.
  }

  if (target.grid) {
    const material = target.grid.material as { color?: Color } | Array<{ color?: Color }>;
    const colours = Array.isArray(material) ? material : [material];
    // drei and three both build a GridHelper with two colours; whichever shape
    // it is, the first is the centre lines and the rest the minor ones.
    colours.forEach((entry, i) => {
      entry.color?.setHex(
        mix(tokens['--sc-dark'], tokens['--sc-text'], i === 0 ? GRID_MIX : GRID_MIX_MINOR),
      );
    });
  }
}

/** The colour an outline or highlight should use for the current theme.
 *
 * The accent, unless it is too close to the background to see -- on a
 * light-leaning theme an orange accent on a near-white page is a real
 * possibility, and `dolomite` is light-leaning. Below the large-text threshold
 * it falls back to the text colour, which every theme guarantees is readable
 * against its own background.
 */
export function outlineColour(tokens: Tokens): number {
  const accent = tokens['--sc-accent'];
  return contrast(accent, tokens['--sc-dark']) >= 3
    ? toHex(accent)
    : toHex(tokens['--sc-text']);
}

/** Whether the theme is light-leaning.
 *
 * Decides the things a colour token cannot: how strong to make ambient fill, and
 * whether a contact shadow should darken or lift. Measured off the page colour
 * rather than guessed from the theme's name, because a theme can be renamed.
 */
export function isLight(tokens: Tokens): boolean {
  return contrast(tokens['--sc-text'], '#ffffff') > contrast(tokens['--sc-text'], '#000000');
}

/** three.js's Neutral curve (Khronos PBR Neutral), exactly as its shader runs
 * it, on linear RGB. */
function neutral(r: number, g: number, b: number, exposure: number): [number, number, number] {
  let c = [r * exposure, g * exposure, b * exposure];
  const x = Math.min(c[0]!, c[1]!, c[2]!);
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  c = c.map((v) => v - offset);
  const peak = Math.max(c[0]!, c[1]!, c[2]!);
  const start = 0.8 - 0.04;
  if (peak < start) return [c[0]!, c[1]!, c[2]!];
  const d = 1 - start;
  const newPeak = 1 - (d * d) / (peak + d - start);
  c = c.map((v) => (v * newPeak) / peak);
  const mixing = 1 - 1 / (0.15 * (peak - newPeak) + 1);
  return [c[0]! + (newPeak - c[0]!) * mixing, c[1]! + (newPeak - c[1]!) * mixing, c[2]! + (newPeak - c[2]!) * mixing];
}

/** The linear colour that comes out as `target` once exposure and tone
 * mapping have run over it -- RENDERING.md Phase 2.
 *
 * The post chain tone-maps the whole image, page colour and grid included,
 * where the direct path never touched a background colour. Neutral is not
 * identity even in the darks: it subtracts a toe, so a near-black page colour
 * came out darker still. It is monotonic per channel over the range a page
 * uses, so a few dozen corrections of the forward curve invert it. `out` is
 * written and returned. */
export function untoneMapped(target: Color, exposure: number, toneMapping: ToneMapping, out: Color): Color {
  // With no tone mapping the output pass applies no exposure either.
  if (toneMapping === NoToneMapping) return out.copy(target);
  if (toneMapping !== NeutralToneMapping) return out.copy(target);
  let r = target.r / exposure;
  let g = target.g / exposure;
  let b = target.b / exposure;
  for (let i = 0; i < 40; i += 1) {
    const [fr, fg, fb] = neutral(r, g, b, exposure);
    r = Math.max(0, r + (target.r - fr) / exposure);
    g = Math.max(0, g + (target.g - fg) / exposure);
    b = Math.max(0, b + (target.b - fb) / exposure);
  }
  return out.setRGB(r, g, b);
}
