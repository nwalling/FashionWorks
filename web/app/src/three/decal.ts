/** LayerBlend decals: the sheet in `TexSlot9`, placed by a second UV set the
 * mesh packs into its vertex colour. RENDERING.md, "Decals, decoded".
 *
 * The core decodes the UV per vertex (`mesh::decal_uv`) and hands it over as
 * `decalUvs`; here it becomes the `fwDecalUv` attribute, and a submaterial that
 * binds a decal sheet samples it there and lays it over whatever the surface
 * is -- live LayerBlend or the baked atlas alike -- by the sheet's own alpha.
 * Neutral geometry decodes to the sheet's empty bottom-left corner, so the
 * decal shows only where the artist placed one.
 *
 * The decal is paint: it takes its own colour, goes dielectric, and takes the
 * roughness the material's `DecalGloss` asks for.
 */

import { BufferAttribute, type BufferGeometry, type Material, type Texture } from 'three';

import type { MaterialPayload } from '../worker/archive.worker';

type Submaterial = MaterialPayload['submaterials'][number];

/** Where neutral geometry samples the sheet: its empty bottom-left corner. */
const NEUTRAL: readonly [number, number] = [0.0, 0.99];

/** Roughness where a material states no decal gloss. */
const DEFAULT_ROUGHNESS = 0.5;

export function hasDecalUvs(geometry: BufferGeometry): boolean {
  return geometry.hasAttribute('fwDecalUv');
}

/** Give a mesh with no decal UVs the neutral one, for a piece whose materials
 * sample a sheet. Without it the attribute reads (0, 0), the sheet's top-left,
 * which is not guaranteed empty. */
export function padDecalUvs(geometry: BufferGeometry): void {
  if (hasDecalUvs(geometry)) return;
  const vertices = geometry.getAttribute('position').count;
  const uv = new Float32Array(vertices * 2);
  for (let i = 0; i < vertices; i += 1) {
    uv[i * 2] = NEUTRAL[0];
    uv[i * 2 + 1] = NEUTRAL[1];
  }
  geometry.setAttribute('fwDecalUv', new BufferAttribute(uv, 2));
}

/** The decal's roughness: `DecalGloss` or `DiffuseDecalGloss`, 0-255 in the
 * archive, as 1 - gloss. */
export function decalRoughness(sub: Submaterial): number {
  const params = sub.params ?? {};
  const raw = params.DecalGloss ?? params.DiffuseDecalGloss;
  const gloss = typeof raw === 'number' ? raw : raw?.[0];
  if (gloss === undefined) return DEFAULT_ROUGHNESS;
  const unit = gloss > 1 ? gloss / 255 : gloss;
  return Math.min(1, Math.max(0.05, 1 - unit));
}

const VERTEX_DECLARE = /* glsl */ `
attribute vec2 fwDecalUv;
varying vec2 vFwDecalUv;
`;

const FRAGMENT_DECLARE = /* glsl */ `
uniform sampler2D fwDecal;
uniform float fwDecalRough;
varying vec2 vFwDecalUv;
float fwDecalA;
`;

const FRAGMENT_COLOUR = /* glsl */ `
  vec4 fwDecalS = texture2D(fwDecal, vFwDecalUv);
  fwDecalA = fwDecalS.a;
  diffuseColor.rgb = mix(diffuseColor.rgb, fwDecalS.rgb, fwDecalA);
`;

const FRAGMENT_RESPONSE = /* glsl */ `
  roughnessFactor = mix(roughnessFactor, fwDecalRough, fwDecalA);
  metalnessFactor = mix(metalnessFactor, 0.0, fwDecalA);
`;

/** Lay a decal sheet over a material, on top of whatever its own shader does. */
export function withDecal(material: Material, sheet: Texture, roughness: number): void {
  const uniforms = { fwDecal: { value: sheet }, fwDecalRough: { value: roughness } };
  material.userData.fwDecal = uniforms;
  const previous = material.onBeforeCompile.bind(material);
  const previousKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_DECLARE}`)
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n  vFwDecalUv = fwDecalUv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_DECLARE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAGMENT_COLOUR}`)
      .replace('#include <normal_fragment_begin>', `${FRAGMENT_RESPONSE}\n#include <normal_fragment_begin>`);
  };
  material.customProgramCacheKey = () => `${previousKey()}+decal`;
  material.needsUpdate = true;
}
