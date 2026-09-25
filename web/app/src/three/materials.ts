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
  LinearMipmapLinearFilter,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NoColorSpace,
  RGBAFormat,
  RGFormat,
  RepeatWrapping,
  SRGBColorSpace,
  ShaderChunk,
  type Texture,
  UnsignedByteType,
  Vector2,
  Vector3,
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

/** The material for anything the compositor does not handle.
 *
 * `siblings` are the other submaterials of the same `.mtl`, for a shader that
 * takes something from them: a hair cap names no colour and wears its cards'. */
export function plainMaterial(sub: Submaterial, textures: SurfaceTextures, siblings: readonly Submaterial[] = []): Material {
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

  // A HUD plane or hologram shows UI the game renders at runtime -- the
  // texture is `$RenderToTexture`, nothing in the archive -- and in the shop it
  // is transparent until powered. Drawn, it was a flat grey card floating
  // beside a launcher's sight.
  if (['uiplane', 'hologram'].some((s) => shader.includes(s))) {
    return new MeshBasicMaterial({ visible: false, name: sub.name });
  }

  const screen = ['monitor', 'uimesh', 'displayscreen'].some((s) => shader.includes(s));
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

  if (shader.includes('hair')) return hairMaterial(sub, textures, siblings);

  const skin = ['humanskin', 'eye', 'organic'].some((s) => shader.includes(s));
  const material = new MeshStandardMaterial({
    name: sub.name,
    color: skin && !diffuseMap ? new Color(0xb08870) : linear(metal ? sub.specular : sub.diffuse, 0x8a929a),
    map: diffuseMap ?? null,
    normalMap: normalMap ?? null,
    roughness: Math.min(1, Math.max(0.05, 1 - (sub.shininess ?? 0.4) * 0.9)),
    metalness: metal ? 1 : 0,
  });
  if (diffuseMap) material.color.set(0xffffff).multiply(linear(sub.diffuse, 0xffffff));
  if (isSkin(sub) && normalMap) {
    const rough = skinRoughness(normalMap, sub.shininess ?? 1);
    if (rough) {
      material.roughnessMap = rough;
      material.roughness = 1;
    }
  }
  if (isSkin(sub)) withSkinTone(material, sub, textures);
  if (shader.includes('eye') && diffuseMap) withIris(material, sub, diffuseMap);
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

/** A `HairPBR` submaterial: strand cards, or the scalp under them.
 *
 * The shader carries no colour at all -- `Diffuse` is white on the cards and
 * black on the scalp, and `TexSlot1` is an opacity mask, two strand sets in red
 * and green over a flat blue. Drawn as a colour map it came out as blue and
 * rainbow cards. The colour is physical: `BaseMelanin` and
 * `BaseMelaninRedness` for the pigment, `DyeColor` absorbed over it by
 * `DyeAmount` (`hairColour`).
 *
 * Cards (`%HAIR_CARDS`) are drawn as strands: alpha to coverage on a mask whose
 * mips keep the strands' coverage (`strandMask`), each strand its own shade of
 * the pigment from the ID map (`%CARD_ID_MAP`, `BaseMelaninVariation`), and an
 * anisotropic highlight running across the strands from the direction map
 * (`%DIRECTION_MAP`). A cap (`%HAIR_CAP`) or a coat (`%HAIR_COAT`, a buzz
 * cut's short hair) is shade on the skin: the pigment, matte, blended through
 * its density mask. */
function hairMaterial(sub: Submaterial, textures: SurfaceTextures, siblings: readonly Submaterial[]): Material {
  const params = sub.params ?? {};
  // The flags say which kind; a core too old to send them leaves the name,
  // where the cards' mask is the one named `_opac` -- which a coat's
  // (`hair_02_shaved_opac`) is too, drawn as a solid band on the forehead.
  const cap = sub.hair ? sub.hair !== 'cards' : !/_opac\b/i.test(sub.textures.base_color ?? '');
  const mask = sub.textures.base_color ? textures.byPath.get(sub.textures.base_color) : undefined;
  // The cap declares only smoothness and specular; its colour is the hair's.
  const pigment = params.BaseMelanin !== undefined
    ? params
    : siblings.find((s) => s.params?.BaseMelanin !== undefined)?.params ?? params;
  return cap ? hairCap(sub, mask, pigment, sub.hair === 'coat' ? 'coat' : 'cap') : hairCards(sub, mask, textures, pigment);
}

function hairCap(sub: Submaterial, mask: Texture | undefined, pigment: HairParams, kind: 'cap' | 'coat'): Material {
  // A cap's `Diffuse` is black on every one in the archive -- the brows', the
  // beard's, the scalps' -- and a coat's white: a cap is shadow on the skin,
  // not hair colour. Drawn in the hair's colour, a white-dyed beard's cap
  // painted the jaw grey; drawn black it is the dark base the game shows
  // under a salt-and-pepper beard, and the dark of the brows.
  const tint: [number, number, number] = sub.diffuse ? [sub.diffuse[0]!, sub.diffuse[1]!, sub.diffuse[2]!] : [1, 1, 1];
  const material = new MeshStandardMaterial({
    name: sub.name,
    color: hairColour(pigment).multiply(new Color(tint[0], tint[1], tint[2])),
    roughness: 1,
    metalness: 0,
    side: DoubleSide,
  });
  // What the colour was made from, so a character's own melanin and dye can
  // be laid over it (CHARACTER.md Phase 2).
  material.userData.hairPigment = pigment;
  material.userData.hairTint = tint;
  if (!mask) return material;
  material.alphaMap = densityMask(mask, kind);
  material.transparent = true;
  material.depthWrite = false;
  material.polygonOffset = true;
  material.polygonOffsetFactor = -1;
  material.polygonOffsetUnits = -1;
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <alphamap_fragment>',
      `#ifdef USE_ALPHAMAP
        diffuseColor.a *= texture2D(alphaMap, vAlphaMapUv).r;
      #endif`,
    );
  };
  material.customProgramCacheKey = () => 'fw-hair-cap';
  return material;
}

function hairCards(
  sub: Submaterial,
  mask: Texture | undefined,
  textures: SurfaceTextures,
  pigment: HairParams,
): Material {
  const smoothness = scalar(sub.params?.Smoothness, 0.5);
  const strandId = sub.textures.strand_id ? textures.byPath.get(sub.textures.strand_id) : undefined;
  const direction = sub.textures.strand_direction ? textures.byPath.get(sub.textures.strand_direction) : undefined;
  const strands = strandLooks(pigment);
  const material = new MeshPhysicalMaterial({
    name: sub.name,
    color: hairColour(pigment),
    roughness: Math.min(1, Math.max(HAIR_MIN_ROUGHNESS, 1 - smoothness)),
    metalness: 0,
    side: DoubleSide,
    // The map's blue is the strand's lean out of the card, about half on
    // every texel, and three.js scales the strength by it.
    anisotropy: direction ? HAIR_ANISOTROPY * 2 : HAIR_ANISOTROPY,
    anisotropyMap: direction ?? null,
    // Strands run down the card's V; without a map, turn the default U onto it.
    anisotropyRotation: direction ? 0 : Math.PI / 2,
    specularIntensity: HAIR_SPECULAR,
  });
  const uniforms = {
    uStrandId: { value: strandId ?? null },
    uHairLight: { value: strands.light },
    uHairDark: { value: strands.dark },
    uDye: { value: strands.dye },
    uDyeAmount: { value: strands.amount },
    uDyeSoft: { value: strands.soft },
    // Where the head is, in the mesh's own space, and how far the cards'
    // normals bend toward it. Set by the caller once the mesh is built
    // (`setHairVolume`); zero bend until then.
    uHairCentre: { value: new Vector3() },
    uHairSphere: { value: 0 },
  };
  material.userData.hairPigment = pigment;
  material.userData.hairStrands = uniforms;
  if (!mask) return material;
  material.alphaMap = densityMask(mask, 'strands', Math.max(1, scalar(sub.params?.OpacityMipScale, 1)));
  material.alphaTest = HAIR_ALPHA_TEST;
  material.alphaToCoverage = true;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    // Hair cards lie every which way, and lit by their own normals a head of
    // them averaged a fraction of the light: Ilucide's hair read a quarter as
    // bright against his skin as in game (0.016 against 0.068). Bent toward a
    // sphere round the head, before skinning so the pose carries it, the mass
    // shades as one volume, and the highlight becomes a band across it -- the
    // grey sheen of the captures.
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uHairCentre;
        uniform float uHairSphere;`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        objectNormal = normalize(mix(objectNormal, normalize(position - uHairCentre), uHairSphere));`);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <normal_fragment_begin>',
        // Both faces of a card face out from the head.
        `#include <normal_fragment_begin>
        #ifdef DOUBLE_SIDED
          normal = normalize(mix(normal, normal * faceDirection, uHairSphere));
        #endif`,
      )
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uHairSphere;
        uniform vec3 uHairLight;
        uniform vec3 uHairDark;
        uniform vec3 uDye;
        uniform float uDyeAmount;
        uniform float uDyeSoft;
        ${strandId ? 'uniform sampler2D uStrandId;' : ''}`,
      )
      // Each strand its own shade, and its own dye: the ID map is a random
      // grey per strand. The melanin varies by it; whether the strand takes
      // the dye is a second draw from it, so the dyed strands are not simply
      // the palest ones.
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        ${strandId ? `{
          float id = texture2D(uStrandId, vAlphaMapUv).r;
          vec3 natural = mix(uHairLight, uHairDark, id);
          // Held clear of both ends by the softness, so an amount of 0 dyes
          // no strand and 1 every strand. Unheld, the softening reached below
          // zero and dyed 8% of strands at amount 0: white specks all over
          // Ilucide's hair.
          float draw = uDyeSoft + fract(id * 7.31 + 0.137) * (1.0 - 2.0 * uDyeSoft);
          float dyed = smoothstep(draw - uDyeSoft, draw + uDyeSoft, uDyeAmount);
          diffuseColor.rgb = mix(natural, uDye, dyed);
        }` : ''}`,
      )
      .replace(
        '#include <alphamap_fragment>',
        `#ifdef USE_ALPHAMAP
          diffuseColor.a *= texture2D(alphaMap, vAlphaMapUv).r;
        #endif`,
      );
  };
  material.customProgramCacheKey = () => `fw-hair${strandId ? '-id' : ''}`;
  return material;
}

type HairParams = Record<string, number | Float32Array>;

/** What a head of strands is made of: the lightest and darkest natural
 * strand -- the pigment with its melanin moved either way by
 * `BaseMelaninVariation` -- and the dye, which a strand takes or does not.
 *
 * **Dye is per strand.** `DyeAmount` is the share of strands that take the
 * `DyeColor`, and `DyePigmentVariation` how soft that choice is. Ilucide's
 * beard is black melanin with a near-white dye at 0.71, and in game it is
 * salt and pepper: a dark beard with many white strands. A flat mix painted
 * it grey, a flat absorption black; strand by strand it is both. How far a
 * variation of one moves the melanin is not in the data
 * (`STRAND_MELANIN_SPREAD`, chosen). */
function strandLooks(params: HairParams): { light: Color; dark: Color; dye: Color; amount: number; soft: number } {
  const melanin = scalar(params.BaseMelanin, 0.5);
  const spread = scalar(params.BaseMelaninVariation, 0) * STRAND_MELANIN_SPREAD;
  const natural = { ...params, DyeAmount: 0 };
  const at = (m: number) => hairColour({ ...natural, BaseMelanin: Math.min(0.999, Math.max(0, m)) });
  const dye = vector(params.DyeColor) ?? [1, 1, 1];
  return {
    light: at(melanin - spread),
    dark: at(melanin + spread),
    dye: new Color().setRGB(dye[0] * DYE_ALBEDO, dye[1] * DYE_ALBEDO, dye[2] * DYE_ALBEDO),
    amount: Math.min(1, Math.max(0, scalar(params.DyeAmount, 0))) * DYE_SHARE,
    soft: 0.02 + 0.25 * Math.min(1, Math.max(0, scalar(params.DyePigmentVariation, 0))),
  };
}

/** A mask's density, in both channels of a two-channel texture.
 *
 * The strand mask is red and green over a flat blue -- two strand sets, of
 * which the first is drawn -- and `hair_31`'s scalp density is grey. But most
 * caps keep their density in **alpha** over white RGB -- the brows', the
 * beards', `m_hair_02_scalp`, all BC3 or BC7 -- and read by red they were
 * solid: an opaque sheet over the forehead, the brows and the jaw. So density
 * is alpha wherever alpha varies, else red. It goes in both channels because
 * three.js's shadow pass reads an alpha map's green.
 *
 * **A strand mask's mips keep its coverage** (`strands`). The strands are
 * authored 1.25-2 px wide at 4096; box-filtered down to the mip a head on
 * screen samples, a strand is a faint smear, and an alpha test turned the
 * smears into clumps -- the scratches on an undercut's sides, the lumps under
 * a beard. The flat 1.6x lift that stood in for this made every mip about
 * twice as dense as the strands are. Instead each level is scaled so the
 * fraction of it that passes the test is its mean opacity -- which box
 * filtering preserves exactly, and which is the strands' true coverage (8.1%
 * mean against 8.3% of `texture_6` over half at full size). Castano's
 * coverage-preserving mipmaps; three.js's alpha to coverage then sharpens each
 * strand's edge by its screen footprint.
 *
 * **A cap is read against its own peak.** The scalp shade under a hairstyle
 * is a soft mask, and most ship peaking far below one: the universal scalp's
 * `m_hair_02_scalp` at 0.29, the beard's at 0.28, the brows' at 0.44, where
 * `hair_31`'s reaches 1.0. Taken as absolute, the scalp under a head of hair
 * took at most 29% of its colour and showed as bare skin between the strands.
 * The cluster reads as a convention the shader scales, so the peak is drawn
 * as full shade and the falloff to the hairline keeps its shape. Inferred.
 * Coats are left as they are: their strands already reach one. */
function densityMask(texture: Texture, kind: 'strands' | 'cap' | 'coat', density = 1): Texture {
  const strands = kind === 'strands';
  const image = texture.image as { data?: Uint8Array; width?: number; height?: number } | undefined;
  const data = image?.data;
  if (!data || !image?.width || !image.height) return texture;
  const texels = image.width * image.height;
  let alphaVaries = false;
  for (let i = 0; i < texels && !alphaVaries; i += 1) alphaVaries = data[i * 4 + 3] !== 255;
  const channel = alphaVaries ? 3 : 0;
  let level = new Float32Array(texels);
  for (let i = 0; i < texels; i += 1) {
    // Cards draw both strand sets: one alone reads as thinning hair.
    const v = strands && !alphaVaries ? Math.max(data[i * 4]!, data[i * 4 + 1]!) : data[i * 4 + channel]!;
    level[i] = v / 255;
  }
  if (kind === 'cap') {
    let peak = 0;
    for (const v of level) peak = Math.max(peak, v);
    if (peak > 0) for (let i = 0; i < texels; i += 1) level[i] = level[i]! / peak;
  }
  // A coat is short hair laid over the scalp, fine strands within a region.
  // Averaged down to the mip a head on screen samples, the region reads a
  // third opaque and the back of an undercut showed bare skin, where the game
  // draws it solid. Each level is read against its own dense part.
  const coatScale = (values: Float32Array) => {
    const inside = [...values].filter((v) => v > 0.02).sort((a, b) => a - b);
    if (inside.length < 16) return 1;
    return 1 / Math.max(0.05, inside[Math.floor(inside.length * 0.5)]!);
  };
  let width = image.width;
  let height = image.height;
  const mipmaps: Array<{ data: Uint8Array<ArrayBuffer>; width: number; height: number }> = [];
  for (;;) {
    const scale = strands ? coverageScale(level, HAIR_ALPHA_TEST, density) : kind === 'coat' ? coatScale(level) : 1;
    const out = new Uint8Array(width * height * 2);
    for (let i = 0; i < width * height; i += 1) {
      const v = Math.min(255, Math.round(level[i]! * scale * 255));
      out[i * 2] = v;
      out[i * 2 + 1] = v;
    }
    mipmaps.push({ data: out, width, height });
    if (width === 1 && height === 1) break;
    const w = Math.max(1, width >> 1);
    const h = Math.max(1, height >> 1);
    const next = new Float32Array(w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let sum = 0;
        let n = 0;
        for (let dy = 0; dy < 2; dy += 1) {
          for (let dx = 0; dx < 2; dx += 1) {
            const sx = Math.min(width - 1, x * 2 + dx);
            const sy = Math.min(height - 1, y * 2 + dy);
            sum += level[sy * width + sx]!;
            n += 1;
          }
        }
        next[y * w + x] = sum / n;
      }
    }
    level = next;
    width = w;
    height = h;
  }
  const mask = new DataTexture(mipmaps[0]!.data, mipmaps[0]!.width, mipmaps[0]!.height, RGFormat, UnsignedByteType);
  mask.mipmaps = mipmaps;
  mask.colorSpace = NoColorSpace;
  mask.wrapS = RepeatWrapping;
  mask.wrapT = RepeatWrapping;
  mask.anisotropy = texture.anisotropy;
  mask.generateMipmaps = false;
  mask.minFilter = LinearMipmapLinearFilter;
  mask.needsUpdate = true;
  return mask;
}

/** The factor that makes the fraction of `level` passing `threshold` equal
 * its mean: a 256-bin histogram, read from the top down. */
export function coverageScale(level: Float32Array, threshold: number, density = 1): number {
  const bins = new Uint32Array(256);
  let sum = 0;
  for (const v of level) {
    bins[Math.min(255, Math.floor(v * 255))]! += 1;
    sum += v;
  }
  const target = Math.min(0.95, (sum / level.length) * density);
  if (target <= 0) return 1;
  let passing = 0;
  for (let b = 255; b > 0; b -= 1) {
    passing += bins[b]!;
    if (passing / level.length >= target) return Math.max(1, threshold / (b / 255));
  }
  return 1;
}

const HAIR_ALPHA_TEST = 0.35;
/** The share of strands a dye reaches at a `DyeAmount` of one, and how bright
 * a dyed strand is against its dye colour. Neither is in the data; both are
 * calibrated on Ilucide's chin, the most-dyed part of his beard in the
 * captures: 29% of it reads bright, and its brightest strands at 0.6 of the
 * skin. Drawn at the full amount and the dye colour as paint, 72% read bright
 * at 4.5 times the skin. A white strand is not white paint: the game's hair
 * shading takes it well below the dye colour. */
const DYE_SHARE = 0.45;
const DYE_ALBEDO = 0.3;
/** How far a hair card's normal bends toward the head's sphere. Chosen
 * against the captures' hair-to-skin brightness. */
const HAIR_SPHERE = 0.8;
/** The glossiest a strand card is drawn. The highlight is anisotropic now,
 * a band across the strands; isotropic, anything glossier than 0.75 spread
 * into a grey-white sheet over cards that lie flat. */
const HAIR_MIN_ROUGHNESS = 0.5;
/** The highlight's strength. At full strength the thin strands glinted white
 * against dark hair; the game's read "dark with grey highlights". Chosen. */
const HAIR_SPECULAR = 0.5;
/** How stretched the highlight is across the strands, 0 to 1. Chosen. */
const HAIR_ANISOTROPY = 0.85;
/** Melanin either side of the pigment at a `BaseMelaninVariation` of one.
 * Chosen: the data says a head varies, not by how much. */
const STRAND_MELANIN_SPREAD = 0.15;

function scalar(value: number | Float32Array | undefined, fallback: number): number {
  if (typeof value === 'number') return value;
  return value?.[0] ?? fallback;
}

function vector(value: number | Float32Array | undefined): [number, number, number] | null {
  if (!value || typeof value === 'number' || value.length < 3) return null;
  return [value[0]!, value[1]!, value[2]!];
}

/** Hair colour, linear, from melanin and dye.
 *
 * CryEngine does not document its mapping, so this is the published one it
 * most resembles -- Chiang et al.'s melanin parametrisation as Blender's
 * Principled Hair implements it: melanin 0-1 becomes a concentration by
 * `-ln(1 - m)`, split into eumelanin and pheomelanin by redness, absorbed per
 * channel, and converted to the colour a strand reads as at a moderate
 * azimuthal roughness. The dye then mixes over it. Inferred, not confirmed:
 * the parameter names match exactly, the curve is a reasonable guess. */
export function hairColour(params: Record<string, number | Float32Array>): Color {
  const melanin = Math.min(0.999, Math.max(0, scalar(params.BaseMelanin, 0.5)));
  const redness = Math.min(1, Math.max(0, scalar(params.BaseMelaninRedness, 0)));
  const quantity = -Math.log(Math.max(1 - melanin, 1e-4));
  const eu = quantity * (1 - redness);
  const pheo = quantity * redness;
  const sigma = [
    eu * 0.506 + pheo * 0.343,
    eu * 0.841 + pheo * 0.733,
    eu * 1.653 + pheo * 1.924,
  ];
  // Blender's roughness-dependent factor at an azimuthal roughness of 0.3.
  const beta = 0.3;
  const k = 5.969 - 0.215 * beta + 2.532 * beta ** 2 - 10.73 * beta ** 3 + 5.574 * beta ** 4 + 0.245 * beta ** 5;
  const tint = vector(params.BaseTintColor) ?? [1, 1, 1];
  let rgb = sigma.map((s, i) => Math.exp(-Math.sqrt(s) * k) * tint[i]!);
  // The flat colour of a head of hair: the dye mixed in by `DyeAmount`, which
  // is the share of strands that take it (`strandLooks`). Strand cards draw
  // each strand dyed or not; this is their average, for everything drawn as
  // one colour. Absorbing instead -- `pigment x dye ^ amount`, tried -- turned
  // a near-white dye into nothing, where the game shows Ilucide's beard as
  // black and white strands together.
  const dye = vector(params.DyeColor);
  const amount = Math.min(1, Math.max(0, scalar(params.DyeAmount, 0)));
  if (dye && amount > 0) rgb = rgb.map((c, i) => c + (dye[i]! * DYE_ALBEDO - c) * amount * DYE_SHARE);
  return new Color().setRGB(rgb[0]!, rgb[1]!, rgb[2]!);
}

/** `HumanSkin_V2`'s tone adjustment: the skin texture recoloured from its
 * own average to one target, and the flat target where the tone mask says.
 *
 * Every skin material declares `SourceAverageColor`, its texture's average,
 * and `FinalSkinTone`, the tone to draw -- which a character's `BodyColor`
 * sets for head and body alike. So a texel becomes `texel x Final / Source`,
 * and the head and body, drawn from different textures, arrive at one skin.
 *
 * **The mask decides where the texture shows at all.** Slot 7's green is white
 * over nearly all of both textures and black in exactly one place on each:
 * the lower neck on the head, the collar on the body -- where the two meshes
 * meet. Even recoloured, the textures disagree there (the male head reads a
 * fifth lighter than the body at the 45 vertices they share), so both fall to
 * the flat target and the seam goes. That is the mask's reading here, and it
 * is inferred: the shader is compiled into the engine. The multiply is
 * inferred too; `CalibrationPower` is 1 and `CalibrationSlope` 0 on every
 * skin material in the archive, which is what makes it the plain ratio. */
function withSkinTone(material: MeshStandardMaterial, sub: Submaterial, textures: SurfaceTextures): void {
  const source = vector(sub.params?.SourceAverageColor);
  if (!source || !material.map) return;
  const final = vector(sub.params?.FinalSkinTone) ?? source;
  const mask = sub.textures.tone_mask ? textures.byPath.get(sub.textures.tone_mask) : undefined;
  const uniforms = {
    uToneSource: { value: new Vector3(...source) },
    uToneFinal: { value: new Vector3(...final) },
    uToneMask: { value: mask ?? null },
  };
  material.userData.skinTone = { own: new Vector3(...final), final: uniforms.uToneFinal };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uToneSource;
        uniform vec3 uToneFinal;
        ${mask ? 'uniform sampler2D uToneMask;' : ''}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          vec3 toned = diffuseColor.rgb * uToneFinal / max(uToneSource, vec3(1e-4));
          float keep = ${mask ? 'texture2D(uToneMask, vMapUv).g' : '1.0'};
          diffuseColor.rgb = mix(uToneFinal, toned, keep);
        }`,
      );
  };
  material.customProgramCacheKey = () => (mask ? 'fw-skin-tone-mask' : 'fw-skin-tone');
}

/** Set a skin material's tone: `BodyColor`, linear. A material without the
 * tone adjustment is left alone. */
export function setSkinTone(material: Material, tone: ArrayLike<number> | null): void {
  const found = material.userData.skinTone as { own: Vector3; final: { value: Vector3 } } | undefined;
  if (!found) return;
  if (tone) found.final.value.set(tone[0]!, tone[1]!, tone[2]!);
  else found.final.value.copy(found.own);
}

/** The skin tone a material draws with unless told otherwise, or null. */
export function ownSkinTone(material: Material): Vector3 | null {
  return (material.userData.skinTone as { own: Vector3 } | undefined)?.own ?? null;
}

/** The `Eye` shader's iris colour, for a character that sets one.
 *
 * The diffuse's alpha is the iris: 255 across it, 0 on the white. The
 * customizer's own eye (`human_white_eye_diff`) has a pale patterned iris for
 * `IrisColor` to colour -- `EyeColor` in the `.chf`, exactly. Inside the mask
 * the texel becomes `IrisColor` scaled by its brightness over the iris's
 * mean, which keeps the pattern and the dark pupil and puts the average on
 * the colour asked for. Off until set, so an eye texture that is already
 * coloured -- the protos head's brown one -- draws as it always has. */
function withIris(material: MeshStandardMaterial, sub: Submaterial, diffuse: Texture): void {
  const image = diffuse.image as { data?: Uint8Array; width?: number; height?: number } | undefined;
  const data = image?.data;
  if (!data) return;
  let weight = 0;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]! / 255;
    if (a <= 0) continue;
    const lum = 0.2126 * srgbToLinear(data[i]!) + 0.7152 * srgbToLinear(data[i + 1]!) + 0.0722 * srgbToLinear(data[i + 2]!);
    sum += lum * a;
    weight += a;
  }
  if (weight <= 0) return;
  const own = vector(sub.params?.IrisColor) ?? [0.25, 0.25, 0.25];
  const uniforms = {
    uIris: { value: new Vector3(...own) },
    uIrisMean: { value: Math.max(1e-3, sum / weight) },
    uIrisOn: { value: 0 },
  };
  material.userData.iris = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uIris;\nuniform float uIrisMean;\nuniform float uIrisOn;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          vec3 iris = uIris * lum / uIrisMean;
          diffuseColor.rgb = mix(diffuseColor.rgb, iris, sampledDiffuseColor.a * uIrisOn);
          diffuseColor.a = 1.0;
        }`,
      );
  };
  material.customProgramCacheKey = () => 'fw-iris';
}

/** Colour an eye's iris, linear; null puts the texture's own back. */
export function setIris(material: Material, colour: ArrayLike<number> | null): void {
  const found = material.userData.iris as { uIris: { value: Vector3 }; uIrisOn: { value: number } } | undefined;
  if (!found) return;
  if (colour) found.uIris.value.set(colour[0]!, colour[1]!, colour[2]!);
  found.uIrisOn.value = colour ? 1 : 0;
}

/** Recolour a hair material from a character's melanin and dye, laid over
 * the material's own parameters; null restores them. */
/** Point a hair card material's normals at the head: `centre` in the
 * mesh's own space, the middle of its bounds. */
export function setHairVolume(material: Material, centre: Vector3): void {
  const strands = material.userData.hairStrands as { uHairCentre: { value: Vector3 }; uHairSphere: { value: number } } | undefined;
  if (!strands) return;
  strands.uHairCentre.value.copy(centre);
  strands.uHairSphere.value = HAIR_SPHERE;
}

export function setHairLooks(material: Material, looks: Record<string, number | Float32Array> | null): void {
  const pigment = material.userData.hairPigment as HairParams | undefined;
  if (!pigment || !(material instanceof MeshStandardMaterial)) return;
  const params = looks ? { ...pigment, ...looks } : pigment;
  const tint = (material.userData.hairTint as [number, number, number] | undefined) ?? [1, 1, 1];
  material.color.copy(hairColour(params)).multiply(new Color(tint[0], tint[1], tint[2]));
  const strands = material.userData.hairStrands as {
    uHairLight: { value: Color }; uHairDark: { value: Color }; uDye: { value: Color };
    uDyeAmount: { value: number }; uDyeSoft: { value: number };
  } | undefined;
  if (strands) {
    const next = strandLooks(params);
    strands.uHairLight.value.copy(next.light);
    strands.uHairDark.value.copy(next.dark);
    strands.uDye.value.copy(next.dye);
    strands.uDyeAmount.value = next.amount;
    strands.uDyeSoft.value = next.soft;
  }
}

function srgbToLinear(byte: number): number {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Which of a submaterial's textures the renderer needs, and in what space. */
export function texturesWanted(sub: Submaterial): Array<{ path: string; srgb: boolean; alpha?: boolean }> {
  const out: Array<{ path: string; srgb: boolean; alpha?: boolean }> = [];
  // Skin's gloss lives in its normal map's smoothness stream, as armour
  // layers' does; the plain decode leaves that stream out.
  if (sub.textures.normal) out.push({ path: sub.textures.normal, srgb: false, alpha: isSkin(sub) });
  // Skin's tone mask: data, not colour.
  if (isSkin(sub) && sub.textures.tone_mask) out.push({ path: sub.textures.tone_mask, srgb: false });
  // Hair's slot 1 is a mask, not a colour, and an sRGB decode would thin it.
  const hair = sub.shader.toLowerCase().includes('hair');
  if (!sub.tintable && sub.textures.base_color) out.push({ path: sub.textures.base_color, srgb: !hair });
  // A strand's shade and its direction: data, not colour.
  if (hair && sub.textures.strand_id) out.push({ path: sub.textures.strand_id, srgb: false });
  if (hair && sub.textures.strand_direction) out.push({ path: sub.textures.strand_direction, srgb: false });
  return out;
}

function isSkin(sub: Submaterial): boolean {
  return sub.shader.toLowerCase().includes('humanskin');
}

/** Skin roughness from the normal map's smoothness stream.
 *
 * `HumanSkin_V2` carries Shininess 1 on the body and the head, and taken as a
 * constant that is a mirror: the figure came out wet and plastic. In CryEngine
 * the constant scales the per-pixel smoothness in the `_ddna` alpha, exactly
 * as it does for an armour layer, so roughness is `1 - alpha x shininess`. */
function skinRoughness(normal: Texture, shininess: number): DataTexture | null {
  const image = normal.image as { data?: Uint8Array; width?: number; height?: number } | undefined;
  const data = image?.data;
  if (!data || !image?.width || !image.height) return null;
  const out = new Uint8Array(image.width * image.height * 4);
  let varied = false;
  for (let i = 0; i < image.width * image.height; i += 1) {
    const alpha = data[i * 4 + 3]!;
    if (alpha !== 255) varied = true;
    const r = 255 - Math.round(alpha * Math.min(1, shininess));
    out[i * 4] = 255;
    out[i * 4 + 1] = r;
    out[i * 4 + 2] = 0;
    out[i * 4 + 3] = 255;
  }
  if (!varied) return null;
  const texture = new DataTexture(out, image.width, image.height, RGBAFormat, UnsignedByteType);
  texture.colorSpace = NoColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** Prepare a decoded texture for binding on a mesh. */
export function meshTexture(texture: DataTexture, srgb: boolean): DataTexture {
  texture.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}
