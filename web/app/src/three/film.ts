/** Thin films: LayerBlend compiled with `%IRIDESCENCE` (`material::Film`).
 *
 * A film colours what a metal reflects, and shows by how dark the metal is.
 * Films are mostly laid over near-black metals (the Starchaser's
 * `iridescence_metal`, the Scorched slide), which take all of it; the Aves
 * Shrike's light blue steel takes about half, and under its ramp's green is
 * the teal it is in game; the white anodised panels beside the Starchaser's
 * violet, in the same submaterial, stay silver. A non-metal's own reflection
 * is too faint to carry one at all.
 *
 * Where the material names a ramp (`TexSlot5`), the ramp is the look: read
 * across by how squarely the surface faces the viewer, scaled by
 * `IridescenceThicknessU`, at the row `IridescenceThicknessV` names counted up
 * from the bottom edge. Each choice is what the wiki's in-game shots need: the
 * S-38 "Scorched" slide is pink square on and gold where it turns away, never
 * the Fire Rats ramp's green centre (read along the diagonal, as the ship
 * renders read theirs, every three-quarter view went through it); the
 * Starchaser helmets are the violet near the top of their ramp, not the pale
 * blue near its bottom; the Shrike's ribs are teal head on and violet turning
 * away, from a ramp of green, mauve and grey.
 *
 * Where it names none (the Arclight "Glimmer", the Yubarev "Mirage"), the
 * colour is thin-film interference at the material's thickness, the ship
 * renders' ramp (`renders/sc_materials.py`, `_thin_film_ramp`): the Glimmer's
 * 0.09 is the gold it is in game. A grazing view reads the film thinner.
 */

import { ClampToEdgeWrapping, DataTexture, LinearFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType, Vector4 } from 'three';

export interface Film {
  u: number;
  v: number;
  strength: number;
}

/** How far across its ramp a film is read head on: the Scorched slide square
 * to the camera is the Fire Rats ramp's pink at 0.8, where its edge is blue. */
const FILM_REACH = 0.8;
/** How much thinner a film with no ramp reads at a grazing view (the ship renders'). */
const FILM_EDGE = 0.7;

/** Declarations for the fragment shader. */
export const FILM_DECLARE = /* glsl */ `
uniform sampler2D fwFilmRamp;
uniform vec4 fwFilm;
`;

/** The film, applied to `diffuseColor` once the normal is known (before
 * `emissivemap_fragment`). `metal` names the shader's metalness. */
export function filmFragment(metal: string): string {
  return /* glsl */ `
  if (fwFilm.z > 0.0) {
    vec3 fwView = isOrthographic ? vec3( 0.0, 0.0, 1.0 ) : normalize( vViewPosition );
    float fwFacing = clamp( dot( normal, fwView ), 0.0, 1.0 );
    vec2 fwFilmUv = fwFilm.w > 0.5
      ? vec2( fwFilm.x * mix( ${FILM_EDGE.toFixed(2)}, 1.0, fwFacing ), 0.5 )
      : vec2( fwFacing * fwFilm.x, fwFilm.y );
    vec3 fwFilmColour = texture2D( fwFilmRamp, clamp( fwFilmUv, 0.0, 1.0 ) ).rgb;
    // Shown by how dark the metal under it is: a bright one's own reflection drowns it.
    float fwUnder = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
    float fwFilmAmount = fwFilm.z * ${metal} * clamp( 1.0 - fwUnder, 0.0, 1.0 );
    diffuseColor.rgb = mix( diffuseColor.rgb, fwFilmColour, fwFilmAmount );
  }
`;
}

/** The `fwFilm` uniform's value: no film is a zero amount. */
export function filmValue(film: Film | undefined, ownRamp: boolean): Vector4 {
  if (!film) return new Vector4(0, 0, 0, 0);
  const amount = Math.min(1, Math.max(0, film.strength));
  // The row counts up from the ramp's bottom edge.
  if (ownRamp) return new Vector4(film.u * FILM_REACH, 1 - film.v * FILM_REACH, amount, 0);
  // With no ramp there is no row, and `u` is the thickness, 0 to 1 across the
  // ramp's 80 to 800 nm: the Glimmer's 0.09 is gold, the Mirage's 0.045 pale.
  // The template's 1 and 1 (20 armour materials) state no film at all.
  if (film.u >= 1 && film.v >= 1) return new Vector4(0, 0, 0, 0);
  return new Vector4(film.u, 0.5, amount, 1);
}

let interference: DataTexture | null = null;
/** Thin-film interference colours by thickness, 80 to 800 nm at n 1.4, each
 * at full brightness: spectra summed through a fit of the CIE matching
 * functions (Wyman, Sloan and Shirley 2013). Shared, never disposed. */
export function interferenceRamp(): DataTexture {
  if (interference) return interference;
  const g = (lam: number, mu: number, s1: number, s2: number) => {
    const t = (lam - mu) / (lam < mu ? s1 : s2);
    return Math.exp(-0.5 * t * t);
  };
  const encode = (c: number) => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
  const n = 256;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i += 1) {
    const d = 80 + (720 * i) / (n - 1);
    let X = 0;
    let Y = 0;
    let Z = 0;
    for (let lam = 380; lam <= 780; lam += 5) {
      const r = 0.5 * (1 - Math.cos((2 * Math.PI * 2 * 1.4 * d) / lam));
      X += r * (1.056 * g(lam, 599.8, 37.9, 31.0) + 0.362 * g(lam, 442.0, 16.0, 26.7) - 0.065 * g(lam, 501.1, 20.4, 26.2));
      Y += r * (0.821 * g(lam, 568.8, 46.9, 40.5) + 0.286 * g(lam, 530.9, 16.3, 31.1));
      Z += r * (1.217 * g(lam, 437.0, 11.8, 36.0) + 0.681 * g(lam, 459.0, 26.0, 13.8));
    }
    const rgb = [
      3.2406 * X - 1.5372 * Y - 0.4986 * Z,
      -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
      0.0557 * X - 0.204 * Y + 1.057 * Z,
    ];
    const m = Math.max(...rgb, 1e-6);
    rgb.forEach((c, k) => { data[i * 4 + k] = encode(Math.min(1, Math.max(0, c / m))); });
    data[i * 4 + 3] = 255;
  }
  interference = new DataTexture(data, n, 1, RGBAFormat, UnsignedByteType);
  interference.colorSpace = SRGBColorSpace;
  interference.wrapS = ClampToEdgeWrapping;
  interference.wrapT = ClampToEdgeWrapping;
  interference.minFilter = LinearFilter;
  interference.magFilter = LinearFilter;
  interference.userData.shared = true;
  interference.needsUpdate = true;
  return interference;
}
