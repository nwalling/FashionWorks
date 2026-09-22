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

import type { Color, GridHelper, Scene, WebGLRenderer } from 'three';

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
