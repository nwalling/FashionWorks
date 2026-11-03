/** The tone curve: three.js's Neutral (Khronos PBR Neutral) with a softer
 * shoulder.
 *
 * **Neutral starts compressing at 0.76 and is nearly flat by 1.3.** Metered
 * (`StudioLighting.meter`), a white paint under a key reaches 1.2 to 1.6:
 * the Monde Legs' plates (palette `#e6e6e6`, 0.79 albedo) read a median 247
 * of 255 under `inventory`, 249 at the 90th percentile -- paper white. From
 * 0.6 they read 238 and 241 (`hangar` 235 to 227), while what stays below it
 * comes out as Neutral draws it: skin, a black suit and the gold's median do
 * not move. The brightest gold softens by 5 of 255 and Beacon's orange by 5,
 * hue within half a degree.
 *
 * **What it does not do is give a lit face much form.** Across a white plate
 * the light varies by a third, and any curve that keeps a white under 1
 * gives that a few levels; the shading comes back on the plate's turned-away
 * side, not on its lit face. More would want contrast in the light.
 *
 * **It cannot start much lower.** Both alpha solves (the portrait's and the
 * Hangarworks item renderer's) need the curve straight between their two
 * backdrop greys, and the light one sits at 0.52 (`BACKDROP_EXPOSURE`). The
 * shape is Khronos's hyperbola, only moved: with a slope of one where it
 * starts and white as its limit, it kept more slope at the top than an
 * exponential, a power or a white-pointed Reinhard, so where it starts is
 * the one free choice.
 */

import { ShaderChunk } from 'three';

/** Where the shoulder starts, after Neutral's 0.04 offset; Khronos's is 0.76. */
export const NEUTRAL_SHOULDER = 0.6;

let softened = false;

/** Move Neutral's shoulder to `NEUTRAL_SHOULDER` in three.js's shader chunk,
 * once, before anything compiles. The bundled three.js is the package's own,
 * so this reaches FashionWorks's renders and nothing of the host's. */
export function softenNeutralShoulder(): void {
  if (softened) return;
  softened = true;
  const anchor = 'const float StartCompression = 0.8 - 0.04;';
  const chunk = ShaderChunk.tonemapping_pars_fragment;
  if (!chunk.includes(anchor)) throw new Error('toneCurve: Neutral no longer declares its shoulder where expected');
  ShaderChunk.tonemapping_pars_fragment = chunk.replace(anchor, `const float StartCompression = ${NEUTRAL_SHOULDER.toFixed(4)};`);
}
