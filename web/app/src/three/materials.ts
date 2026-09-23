/** three.js materials for a piece's submaterials.
 *
 * Two kinds, because the archive has two kinds.
 *
 * **LayerBlend** submaterials -- nearly all armour -- are composited by
 * `surface.ts` into an atlas holding each texel's colour, and here get the two
 * things a bake cannot hold:
 *
 * * **the armour's own normal map** (`TexSlot3`, `_ddn`). The port never bound
 *   it, so panel lines, seams and stitching -- most of what reads as "detail"
 *   on a piece -- were simply gone, and pieces looked smoother and flatter
 *   than the pipeline's own renders of the same armour;
 * * **the grain of each layer** -- paint, weave, brushed metal -- sampled on
 *   the mesh at screen resolution, from the layer slot the bake recorded for
 *   the texel. The bake kept each layer's mean; the grain modulates around it,
 *   so the colour stays exactly the bake's and only the texture comes back.
 *
 * **Everything else** -- `Illum` straps and lights, `GlassPBR` visors,
 * `MeshDecal`, screens -- was skipped by the compositor and drawn in the
 * renderer's placeholder grey. That grey was the "untextured" backpack: the
 * CSP-68H's `backpack_07_m` is `Illum`, with a colour and nothing else. Each
 * now gets the constants and textures its `.mtl` actually declares.
 */

import {
  Color,
  DataTexture,
  DoubleSide,
  type Material,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NoColorSpace,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  ShaderChunk,
  type Texture,
  UnsignedByteType,
  Vector2,
} from 'three';

import type { MaterialPayload } from '../worker/archive.worker';
import { GLOW_GAIN, type Composited, type DetailLibrary } from './surface';

export type Submaterial = MaterialPayload['submaterials'][number];

/** Grain strength on the normal. The layer normals are authored for a
 * surface that is otherwise flat; on top of the armour's own `_ddn` they read
 * a little strong, so they are eased back rather than dropped. */
const DETAIL_NORMAL_STRENGTH = 0.8;

/** A flat normal, for a surface with grain but no normal map of its own: the
 * grain's normals need the tangent frame three.js only builds with one. */
let flat: DataTexture | null = null;
function flatNormal(): DataTexture {
  if (!flat) {
    flat = new DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1, RGBAFormat, UnsignedByteType);
    flat.colorSpace = NoColorSpace;
    // Shared by every material that needs it: never disposed with a piece.
    flat.userData.shared = true;
    flat.needsUpdate = true;
  }
  return flat;
}

const DECLARE = /* glsl */ `
uniform sampler2DArray fwGrainDiffuse;
uniform sampler2DArray fwGrainNormal;
uniform vec4 fwSlots[8];
uniform vec3 fwMeans[8];
uniform float fwGrainColour;
uniform float fwGrainBump;
uniform float fwGrainStrength;
`;

const GRAIN = /* glsl */ `
  // Which layer this texel shows, as the bake recorded it in the ORM's alpha.
  // Fetched, not filtered: a slot is an id, and interpolating two ids at an
  // island's edge would name a third layer that is not there.
  ivec2 fwSize = textureSize(roughnessMap, 0);
  ivec2 fwTexel = clamp(ivec2(vRoughnessMapUv * vec2(fwSize)), ivec2(0), fwSize - 1);
  int fwSlot = int(texelFetch(roughnessMap, fwTexel, 0).a * 7.0 + 0.5);
  vec4 fwInfo = fwSlots[fwSlot];
  vec2 fwUv = vMapUv * fwInfo.z;
  // Explicit gradients: each slot tiles differently, so an implicit one would
  // jump at every boundary between layers and pick the smallest mip there --
  // a one-pixel seam around every painted region.
  vec2 fwDx = dFdx(vMapUv) * fwInfo.z;
  vec2 fwDy = dFdy(vMapUv) * fwInfo.z;
  if (fwGrainColour > 0.5 && fwInfo.x >= 0.0) {
    vec3 fwGrain = textureGrad(fwGrainDiffuse, vec3(fwUv, fwInfo.x), fwDx, fwDy).rgb;
    // Around the mean the bake used, so the colour is the bake's and only the
    // texture is added. Clamped: a near-black channel mean would otherwise
    // amplify noise into speckle.
    diffuseColor.rgb *= clamp(fwGrain / max(fwMeans[fwSlot], vec3(0.004)), 0.0, 4.0);
  }
`;

const BUMP = /* glsl */ `
	if (fwGrainBump > 0.5 && fwInfo.y >= 0.0) {
		vec3 fwN = textureGrad(fwGrainNormal, vec3(fwUv, fwInfo.y), fwDx, fwDy).xyz * 2.0 - 1.0;
		fwN.xy *= fwGrainStrength;
		// Whiteout blend: the grain rides on the armour's own surface.
		mapN = normalize(vec3(mapN.xy + fwN.xy, mapN.z * fwN.z));
	}
	normal = normalize( tbn * mapN );`;

/** Draw a layer library's grain on a composited material. */
function withGrain(material: MeshStandardMaterial, library: DetailLibrary, name: string): void {
  const slots = library.slots.get(name);
  const means = library.means.get(name);
  if (!slots || !means) return;
  const vec4s = Array.from({ length: 8 }, (_, i) => [
    slots[i * 4]!, slots[i * 4 + 1]!, slots[i * 4 + 2]!, slots[i * 4 + 3]!,
  ]).flat();
  const uniforms = {
    fwGrainDiffuse: { value: library.diffuse },
    fwGrainNormal: { value: library.normal },
    fwSlots: { value: vec4s },
    fwMeans: { value: Array.from(means) },
    fwGrainColour: { value: library.diffuse ? 1 : 0 },
    fwGrainBump: { value: library.normal ? 1 : 0 },
    fwGrainStrength: { value: DETAIL_NORMAL_STRENGTH },
  };
  // A sampler must be bound even when unused, or the program will not link
  // on some drivers; the diffuse array stands in for a missing normal one.
  if (!uniforms.fwGrainNormal.value) uniforms.fwGrainNormal.value = library.diffuse;
  if (!uniforms.fwGrainDiffuse.value) uniforms.fwGrainDiffuse.value = library.normal;
  if (!uniforms.fwGrainDiffuse.value) return;

  material.userData.fwGrain = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${DECLARE}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${GRAIN}`)
      .replace(
        '#include <normal_fragment_maps>',
        ShaderChunk.normal_fragment_maps.replace('\tnormal = normalize( tbn * mapN );', BUMP),
      );
  };
  // One program for every grained material; the uniforms are per material.
  material.customProgramCacheKey = () => 'fw-grain';
}

export interface SurfaceTextures {
  /** Decoded `.mtl` textures by path: normal maps, diffuse maps. */
  readonly byPath: ReadonlyMap<string, Texture>;
}

/** The material for a composited (LayerBlend) submaterial. */
export function surfaceMaterial(
  sub: Submaterial,
  composited: Composited,
  textures: SurfaceTextures,
): MeshStandardMaterial {
  const surface = composited.surfaces.get(sub.name);
  const material = new MeshStandardMaterial({
    // White, with the colour arriving entirely through the map. The flat
    // palette multiply that used to sit on top repainted the 87% of layers the
    // artist never palette-tinted.
    color: 0xffffff,
    roughness: 1,
    metalness: 1,
  });
  material.name = sub.name;
  if (!surface) {
    material.color.setHex(0x8a929a);
    material.roughness = 0.55;
    material.metalness = 0.25;
    return material;
  }
  material.map = surface.albedo;
  // glTF's ORM packing: occlusion in red, roughness in green, metalness in
  // blue, all read off the one texture. Alpha is the layer slot.
  material.aoMap = surface.orm;
  material.roughnessMap = surface.orm;
  material.metalnessMap = surface.orm;

  const normal = sub.textures.normal ? textures.byPath.get(sub.textures.normal) : undefined;
  material.normalMap = normal ?? (composited.detail?.normal ? flatNormal() : null);
  // CryEngine's normal maps are DirectX-style, green pointing down the image.
  // With textures uploaded unflipped that is already +v, which is the
  // direction three.js's derivative tangent frame builds its bitangent along,
  // so no sign flip. (Blender flips v on import, which is why the pipeline
  // had to invert green.)
  material.normalScale = new Vector2(1, 1);

  if (sub.glow > 0) {
    // A fraction of the surface's own colour, emitted: bright layers glow and
    // dark ones do not, which is how the Big Boss graffiti reads in game.
    material.emissive = new Color(1, 1, 1);
    material.emissiveMap = surface.albedo;
    material.emissiveIntensity = Math.min(4, sub.glow * GLOW_GAIN);
  }

  if (composited.detail) withGrain(material, composited.detail, sub.name);
  return material;
}

function linear(rgb: ArrayLike<number> | undefined, fallback: number): Color {
  if (!rgb || rgb.length < 3) return new Color(fallback);
  // .mtl colours are linear already.
  return new Color().setRGB(rgb[0]!, rgb[1]!, rgb[2]!);
}

/** The material for anything the compositor does not handle. */
export function plainMaterial(sub: Submaterial, textures: SurfaceTextures): Material {
  const shader = sub.shader.toLowerCase();
  if (shader.includes('nodraw')) {
    // Collision proxies. Invisible in the game too.
    return new MeshBasicMaterial({ visible: false, name: sub.name });
  }
  const diffuseMap = sub.textures.base_color ? textures.byPath.get(sub.textures.base_color) : undefined;
  const normalMap = sub.textures.normal ? textures.byPath.get(sub.textures.normal) : undefined;
  const specular = sub.specular ? Math.max(sub.specular[0]!, sub.specular[1]!, sub.specular[2]!) : 0.04;
  const metal = specular > 0.2;

  if (shader.includes('glass')) {
    // Visors and canopies: tinted, glossy and see-through.
    const material = new MeshStandardMaterial({
      name: sub.name,
      color: linear(sub.diffuse, 0x202428),
      roughness: 0.08,
      metalness: 0.6,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      side: DoubleSide,
    });
    return material;
  }

  if (shader.includes('decal')) {
    if (!diffuseMap) return new MeshBasicMaterial({ visible: false, name: sub.name });
    return new MeshStandardMaterial({
      name: sub.name,
      map: diffuseMap,
      normalMap: normalMap ?? null,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      roughness: 0.6,
      metalness: 0,
      alphaTest: 0.02,
    });
  }

  const screen = ['monitor', 'uimesh', 'displayscreen', 'hologram', 'uiplane'].some((s) => shader.includes(s));
  if (screen) {
    // A switched-off display with a faint glow; the UI it shows in game is
    // rendered at runtime and is not in the archive to draw.
    const colour = linear(sub.diffuse, 0x101418);
    return new MeshStandardMaterial({
      name: sub.name,
      color: new Color(0x06080a),
      emissive: colour,
      emissiveIntensity: 0.25,
      roughness: 0.15,
      metalness: 0,
    });
  }

  const skin = ['humanskin', 'hair', 'eye', 'organic'].some((s) => shader.includes(s));
  const material = new MeshStandardMaterial({
    name: sub.name,
    color: skin && !diffuseMap ? new Color(0xb08870) : linear(metal ? sub.specular : sub.diffuse, 0x8a929a),
    map: diffuseMap ?? null,
    normalMap: normalMap ?? null,
    roughness: Math.min(1, Math.max(0.05, 1 - (sub.shininess ?? 0.4) * 0.9)),
    metalness: metal ? 1 : 0,
  });
  if (diffuseMap) material.color.set(0xffffff).multiply(linear(sub.diffuse, 0xffffff));
  const emissive = sub.emissive ? Math.max(sub.emissive[0]!, sub.emissive[1]!, sub.emissive[2]!) : 0;
  if (sub.glow > 0 || emissive > 0) {
    material.emissive = emissive > 0 ? linear(sub.emissive, 0) : linear(sub.diffuse, 0);
    material.emissiveIntensity = Math.min(4, Math.max(sub.glow, 0.05) * GLOW_GAIN * 0.4);
    if (diffuseMap) material.emissiveMap = diffuseMap;
  }
  if (sub.opacity < 0.99) {
    material.transparent = true;
    material.opacity = Math.max(0.05, sub.opacity);
    material.depthWrite = false;
  }
  if (sub.alphaTest > 0 && diffuseMap) material.alphaTest = sub.alphaTest;
  return material;
}

/** Which of a submaterial's textures the renderer needs, and in what space. */
export function texturesWanted(sub: Submaterial): Array<{ path: string; srgb: boolean }> {
  const out: Array<{ path: string; srgb: boolean }> = [];
  if (sub.textures.normal) out.push({ path: sub.textures.normal, srgb: false });
  if (!sub.tintable && sub.textures.base_color) out.push({ path: sub.textures.base_color, srgb: true });
  return out;
}

/** Prepare a decoded texture for binding on a mesh. */
export function meshTexture(texture: DataTexture, srgb: boolean): DataTexture {
  texture.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}
