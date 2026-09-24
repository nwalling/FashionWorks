/** LayerBlend on the mesh, per pixel. RENDERING.md Phase 3.
 *
 * The viewer used to composite each piece into one 1024 atlas and then add the
 * layers' grain back on the mesh (`surface.ts`, `materials.ts`). That capped
 * detail at the atlas, cost a bake per piece and a moire workaround, and kept
 * about 46 MB of textures for a torso. Here the same rules run in the mesh's
 * own fragment shader, sampling the tiling layer textures at their own
 * resolution with mipmaps, so detail stays sharp at any zoom and there is no
 * bake at all.
 *
 * **The rules are the bake's, unchanged**, and `web/gpu/layerblend.js` is
 * where each is cited: the blend table and its splat order, `PaletteTint` as
 * an absolute index, a metal taking the palette's specular, the palette
 * modulating the layer's own tint, a metal layer's diffuse normalised around
 * its mean, wear paired on the slot number with dark as worn, `_hal` green as
 * occlusion mapped into 0.35-1, gloss as the `_ddna` smoothness stream times
 * GlossMult times the palette's glossiness. What changes is *where* they run:
 * inside three.js's `MeshStandardMaterial`, so the key light, its shadow, the
 * probe and the ambient occlusion all still apply.
 *
 * **Textures, and what they cost.** Per piece:
 *
 * - the layer library it uses, as texture arrays: colour 512 (BC1 uploaded
 *   still compressed where the GPU takes S3TC, 171 KB a layer; decoded
 *   otherwise) and normal-plus-gloss 256 -- the `_ddna` normal in RG and its
 *   smoothness stream, which the plain decode never reads, in A;
 * - three control maps: blend mask and wear at 1024 (RGBA), the armour's own
 *   `_ddn` normal at 2048 (RG, first decoded at 1024 and refined once the
 *   piece is on screen), and `_hal` occlusion at 1024 (one channel).
 *
 * CPU copies are released once uploaded: a decoded texture would otherwise sit
 * in memory twice for the life of the piece.
 */

import {
  Color,
  CompressedArrayTexture,
  DataArrayTexture,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshStandardMaterial,
  NoColorSpace,
  RGBAFormat,
  RGFormat,
  RGB_S3TC_DXT1_Format,
  RedFormat,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
  UnsignedByteType,
  Vector2,
} from 'three';

import { DEFAULT_PALETTE, linearMean } from '../../../gpu/bake.js';
import type { ArchiveClient } from '../archive/client';
import type { LayerRef, MaterialPayload, TexturePayload } from '../worker/archive.worker';
import type { PaletteEntry } from './surface';

export type Submaterial = MaterialPayload['submaterials'][number];

/** Sizes, in texels. The control maps ship at 2048; the layers at 512. */
export interface LiveOptions {
  readonly wear: boolean;
  /** Upload BC1 layer colour still compressed (`WEBGL_compressed_texture_s3tc`). */
  readonly compressed: boolean;
  readonly layerSize: number;
  readonly normalSize: number;
  readonly controlSize: number;
  readonly surfaceSize: number;
}

export const LIVE_DEFAULTS: Omit<LiveOptions, 'wear' | 'compressed'> = {
  layerSize: 512,
  normalSize: 256,
  controlSize: 1024,
  surfaceSize: 2048,
};

export interface LiveSurfaces {
  /** Per LayerBlend submaterial name. */
  readonly materials: Map<string, MeshStandardMaterial>;
  /** Every texture made, for accounting and disposal. */
  readonly textures: Texture[];
  /** Bytes on the GPU, mips included. */
  readonly bytes: number;
  readonly ms: number;
  /** Swap the armour's own normal and occlusion up to `surfaceSize`, after the
   * piece is on screen. Resolves to the bytes it added. */
  refine(): Promise<number>;
}

/** The size the armour's normal map is first decoded at. Decoding it at 2048
 * straight away made a cold equip 9-15% slower than the bake, 250 ms a piece;
 * at 1024 first the live path equips faster than the bake did, and the 2048
 * arrives a moment later. */
const FIRST_SURFACE = 1024;

/** Wear curve, as the bake runs it. */
const WEAR_THRESHOLD = 0.5;
const WEAR_FALLOFF = 0.5;
/** Layer normals are authored for a surface otherwise flat; on top of the
 * armour's own `_ddn` they read a little strong, so they are eased back. */
const DETAIL_NORMAL = 0.8;
/** A fraction of the surface's own colour, emitted. Same as the bake path. */
const GLOW_GAIN = 25;

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Drop a texture's CPU copy once the GPU has it. */
export function releaseAfterUpload(texture: Texture): Texture {
  texture.userData.released = true;
  const release = () => {
    const image = texture.image as { data?: unknown } | undefined;
    if (image && 'data' in image) image.data = null;
    for (const mip of (texture as Texture & { mipmaps?: Array<{ data?: unknown }> }).mipmaps ?? []) mip.data = null;
    texture.onUpdate = () => {};
  };
  texture.onUpdate = release;
  return texture;
}

/** Nearest-sample an RGBA buffer to a square of `size`. */
function square(payload: TexturePayload, size: number): Uint8Array {
  if (payload.width === size && payload.height === size) return payload.rgba;
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const sy = Math.min(payload.height - 1, Math.floor((y * payload.height) / size));
    for (let x = 0; x < size; x += 1) {
      const sx = Math.min(payload.width - 1, Math.floor((x * payload.width) / size));
      out.set(payload.rgba.subarray((sy * payload.width + sx) * 4, (sy * payload.width + sx) * 4 + 4), (y * size + x) * 4);
    }
  }
  return out;
}

function arrayTexture(data: Uint8Array, size: number, depth: number, srgb: boolean): DataArrayTexture {
  const texture = new DataArrayTexture(data as Uint8Array<ArrayBuffer>, size, size, depth);
  texture.format = RGBAFormat;
  texture.type = UnsignedByteType;
  texture.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return releaseAfterUpload(texture) as DataArrayTexture;
}

type ControlFormat = typeof RGBAFormat | typeof RGFormat | typeof RedFormat;

function controlTexture(data: Uint8Array, size: number, format: ControlFormat = RGBAFormat): DataTexture {
  const texture = new DataTexture(data as Uint8Array<ArrayBuffer>, size, size, format, UnsignedByteType);
  // Rows of an RG8 or R8 texture are not 4-byte aligned at every mip.
  texture.unpackAlignment = 1;
  texture.colorSpace = NoColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.flipY = false;
  texture.needsUpdate = true;
  return releaseAfterUpload(texture) as DataTexture;
}

/** GPU bytes of a texture, mips included. */
function gpuBytes(texture: Texture): number {
  const image = texture.image as { width?: number; height?: number; depth?: number };
  const texels = (image.width ?? 0) * (image.height ?? 0) * (image.depth ?? 1);
  if ((texture as CompressedArrayTexture).isCompressedArrayTexture) return texels * 0.5 * 1.34;
  const channels = texture.format === RGFormat ? 2 : texture.format === RedFormat ? 1 : 4;
  return texels * channels * 1.34;
}

/** The linear mean luminance of a BC1 texture, from one small mip's blocks. */
export function bc1Mean(mips: readonly Uint8Array[], size: number): number {
  // The level nearest 16x16 that exists, else the smallest.
  let level = mips.length - 1;
  for (let l = 0; l < mips.length; l += 1) {
    if ((size >> l) <= 16) { level = l; break; }
  }
  const data = mips[level]!;
  const lin = (v: number) => srgbToLinear(v / 255);
  const rgb = (c: number) => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
  let sum = 0;
  let count = 0;
  for (let b = 0; b + 8 <= data.length; b += 8) {
    const c0 = data[b]! | (data[b + 1]! << 8);
    const c1 = data[b + 2]! | (data[b + 3]! << 8);
    const e0 = rgb(c0);
    const e1 = rgb(c1);
    const palette = c0 > c1
      ? [e0, e1, e0.map((v, i) => (2 * v + e1[i]!) / 3), e0.map((v, i) => (v + 2 * e1[i]!) / 3)]
      : [e0, e1, e0.map((v, i) => (v + e1[i]!) / 2), [0, 0, 0]];
    for (let t = 0; t < 16; t += 1) {
      const index = (data[b + 4 + (t >> 2)]! >> ((t & 3) * 2)) & 3;
      const c = palette[index]!;
      sum += (lin(c[0]!) + lin(c[1]!) + lin(c[2]!)) / 3;
      count += 1;
    }
  }
  return count ? sum / count : 1;
}

interface Library {
  diffuse: Texture | null;
  normal: Texture | null;
  diffuseSlice: Map<string, number>;
  normalSlice: Map<string, number>;
  /** Linear mean luminance of each colour layer, for the metal rule. */
  mean: Map<string, number>;
}

async function buildLibrary(
  material: MaterialPayload,
  client: ArchiveClient,
  options: LiveOptions,
): Promise<Library> {
  const colours = new Set<string>();
  const normals = new Set<string>();
  for (const sub of material.submaterials) {
    if (!sub.tintable) continue;
    for (const layer of sub.layers) {
      for (const entry of [layer, layer.worn]) {
        const resolved = entry && material.library[entry.path.toLowerCase()];
        if (resolved?.diffuseTex) colours.add(resolved.diffuseTex);
        if (resolved?.normalTex) normals.add(resolved.normalTex);
      }
    }
  }

  const mean = new Map<string, number>();
  const diffuseSlice = new Map<string, number>();
  let diffuse: Texture | null = null;

  // Compressed first, where the GPU takes it: every layer must be BC1 at one
  // size with one mip chain, or the whole set falls back to decoding.
  if (options.compressed && colours.size) {
    const blocks: Array<{ path: string; mips: Uint8Array[] }> = [];
    let ok = true;
    for (const path of colours) {
      const got = await client.blocks(path, options.layerSize);
      if (!got || got.width !== options.layerSize || got.height !== options.layerSize) { ok = false; break; }
      blocks.push({ path, mips: got.mips });
    }
    if (ok && blocks.length) {
      const levels = Math.min(...blocks.map((b) => b.mips.length));
      const mipmaps = Array.from({ length: levels }, (_, level) => {
        const size = options.layerSize >> level;
        const bytes = blocks[0]!.mips[level]!.length;
        const data = new Uint8Array(bytes * blocks.length);
        blocks.forEach((b, i) => data.set(b.mips[level]!, i * bytes));
        return { data, width: size, height: size };
      });
      const texture = new CompressedArrayTexture(
        mipmaps as unknown as ImageData[], options.layerSize, options.layerSize, blocks.length, RGB_S3TC_DXT1_Format,
      );
      texture.colorSpace = SRGBColorSpace;
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;
      texture.minFilter = LinearMipmapLinearFilter;
      texture.magFilter = LinearFilter;
      texture.generateMipmaps = false;
      texture.anisotropy = 4;
      texture.needsUpdate = true;
      releaseAfterUpload(texture);
      diffuse = texture;
      blocks.forEach((b, i) => diffuseSlice.set(b.path, i));
      // The metal rule needs each layer's linear mean. Decoding a 16x16 mip's
      // blocks here costs nothing; asking the worker for a small decoded copy
      // cost a round trip per layer and made a cold equip slower than the bake.
      for (const { path, mips } of blocks) mean.set(path, bc1Mean(mips, options.layerSize));
    }
  }

  if (!diffuse && colours.size) {
    const slices: Uint8Array[] = [];
    for (const path of colours) {
      const payload = (await client.texture(path, options.layerSize)).texture;
      if (!payload) continue;
      const rgba = square(payload, options.layerSize);
      mean.set(path, linearMean(rgba));
      diffuseSlice.set(path, slices.length);
      slices.push(rgba);
    }
    if (slices.length) {
      const size = options.layerSize * options.layerSize * 4;
      const data = new Uint8Array(size * slices.length);
      slices.forEach((s, i) => data.set(s, i * size));
      diffuse = arrayTexture(data, options.layerSize, slices.length, true);
    }
  }

  // Normal and gloss: the `_ddna` normal in RG, its smoothness stream in A.
  const normalSlice = new Map<string, number>();
  let normal: Texture | null = null;
  const nslices: Uint8Array[] = [];
  for (const path of normals) {
    const payload = (await client.texture(path, options.normalSize, true)).texture;
    if (!payload) continue;
    normalSlice.set(path, nslices.length);
    nslices.push(square(payload, options.normalSize));
  }
  if (nslices.length) {
    const size = options.normalSize * options.normalSize * 4;
    const data = new Uint8Array(size * nslices.length);
    nslices.forEach((s, i) => data.set(s, i * size));
    normal = arrayTexture(data, options.normalSize, nslices.length, false);
  }

  return { diffuse, normal, diffuseSlice, normalSlice, mean };
}

/** Pack a submaterial's control maps, cached across the piece's submaterials,
 * which usually share them:
 *
 * - **A**, RGBA at the control size: the blend mask in RGB, wear in A;
 * - **B**, RG at the surface size: the armour's own `_ddn` normal, z rebuilt
 *   in the shader -- two channels, because packing it into RGBA beside the
 *   occlusion put a refined piece at about 55 MB against the bake's 46;
 * - **C**, one channel at the control size: `_hal` green, the occlusion. */
async function buildControls(
  sub: Submaterial,
  client: ArchiveClient,
  options: LiveOptions,
  cache: Map<string, DataTexture | null>,
  surfaceSize: number,
  surfaceOnly = false,
): Promise<{ a: DataTexture | null; b: DataTexture | null; c: DataTexture | null }> {
  const t = sub.textures;
  const keyA = `a|${t.blend ?? ''}|${t.wear ?? ''}`;
  const keyB = `b|${t.normal ?? ''}`;
  const keyC = `c|${t.hal ?? ''}`;
  const fetch = async (path: string | undefined, size: number) => {
    if (!path) return null;
    const payload = (await client.texture(path, size)).texture;
    return payload ? square(payload, size) : null;
  };
  if (!surfaceOnly && !cache.has(keyA)) {
    const size = options.controlSize;
    const [blend, wear] = [await fetch(t.blend, size), await fetch(t.wear, size)];
    if (!blend && !wear) {
      cache.set(keyA, null);
    } else {
      const data = new Uint8Array(size * size * 4);
      for (let i = 0; i < size * size; i += 1) {
        data[i * 4] = blend ? blend[i * 4]! : 0;
        data[i * 4 + 1] = blend ? blend[i * 4 + 1]! : 0;
        data[i * 4 + 2] = blend ? blend[i * 4 + 2]! : 0;
        // Bright is unworn; no wear map is no wear.
        data[i * 4 + 3] = wear ? wear[i * 4]! : 255;
      }
      cache.set(keyA, controlTexture(data, size));
    }
  }
  if (!cache.has(keyB)) {
    const normal = await fetch(t.normal, surfaceSize);
    if (!normal) {
      cache.set(keyB, null);
    } else {
      const data = new Uint8Array(surfaceSize * surfaceSize * 2);
      for (let i = 0; i < surfaceSize * surfaceSize; i += 1) {
        data[i * 2] = normal[i * 4]!;
        data[i * 2 + 1] = normal[i * 4 + 1]!;
      }
      cache.set(keyB, controlTexture(data, surfaceSize, RGFormat));
    }
  }
  if (!surfaceOnly && !cache.has(keyC)) {
    const size = options.controlSize;
    const hal = await fetch(t.hal, size);
    if (!hal) {
      cache.set(keyC, null);
    } else {
      const data = new Uint8Array(size * size);
      // `_hal` green is the occlusion channel; red and blue sit neutral.
      for (let i = 0; i < size * size; i += 1) data[i] = hal[i * 4 + 1]!;
      cache.set(keyC, controlTexture(data, size, RedFormat));
    }
  }
  return { a: cache.get(keyA) ?? null, b: cache.get(keyB) ?? null, c: cache.get(keyC) ?? null };
}

const MAX_LAYERS = 8;

interface Packed {
  tint: number[];
  response: number[];
  tex: number[];
  gloss: number[];
  wearPair: number[];
  count: number;
}

function pack(sub: Submaterial, material: MaterialPayload, library: Library): Packed {
  const tint = new Array<number>(MAX_LAYERS * 4).fill(0);
  const response = new Array<number>(MAX_LAYERS * 4).fill(0);
  const tex = new Array<number>(MAX_LAYERS * 4).fill(-1);
  const gloss = new Array<number>(MAX_LAYERS * 2).fill(0);
  const wearPair = [-1, -1, -1, -1];
  const put = (slot: number, ref: LayerRef) => {
    const resolved = material.library[ref.path.toLowerCase()];
    const metal = resolved?.metal ?? false;
    tint.splice(slot * 4, 4, ref.tintColor[0]!, ref.tintColor[1]!, ref.tintColor[2]!, ref.paletteTint);
    // A metal's response is its Specular, a dielectric's its Diffuse.
    const r = metal ? (resolved?.specular ?? [0.04, 0.04, 0.04]) : (resolved?.diffuse ?? [1, 1, 1]);
    response.splice(slot * 4, 4, r[0]!, r[1]!, r[2]!, metal ? 1 : 0);
    const colour = resolved?.diffuseTex ? library.diffuseSlice.get(resolved.diffuseTex) : undefined;
    const normal = resolved?.normalTex ? library.normalSlice.get(resolved.normalTex) : undefined;
    tex.splice(slot * 4, 4,
      colour ?? -1,
      normal ?? -1,
      ref.uvTiling * (resolved?.tileU ?? 1),
      resolved?.diffuseTex ? (library.mean.get(resolved.diffuseTex) ?? 1) : 1);
    gloss.splice(slot * 2, 2, resolved?.shininess ?? 0.5, ref.glossMult);
  };
  sub.layers.slice(0, 4).forEach((layer, i) => {
    put(i, layer);
    if (layer.worn) {
      put(i + 4, layer.worn);
      wearPair[i] = i + 4;
    }
  });
  return { tint, response, tex, gloss, wearPair, count: Math.min(sub.layers.length, 4) };
}

const DECLARE = /* glsl */ `
uniform sampler2D fwControlA;
uniform sampler2D fwControlB;
uniform sampler2D fwControlC;
uniform bool fwHasBlend;
uniform bool fwHasWear;
uniform bool fwHasNormal;
uniform bool fwHasHal;
uniform sampler2DArray fwDiffuse;
uniform sampler2DArray fwNormalGloss;
uniform vec3 fwPaletteColor[3];
uniform vec3 fwPaletteSpec[3];
uniform float fwPaletteGloss[3];
uniform vec4 fwLayerTint[8];
uniform vec4 fwLayerResponse[8];
uniform vec4 fwLayerTex[8];
uniform vec2 fwLayerGloss[8];
uniform float fwWearPair[4];
uniform int fwLayerCount;
uniform float fwWearThreshold;
uniform float fwWearFalloff;
uniform float fwWearAmount;
uniform vec3 fwUserTint;
uniform float fwGlow;
uniform float fwDetailNormal;
uniform int fwDebug;

vec3 fwColour;
float fwRough;
float fwMetal;
float fwAo;
vec2 fwDetail;

void fwLayer(int i, vec2 uv, vec2 dx, vec2 dy, out vec3 colour, out float rough, out float metal, out vec2 detail) {
  vec4 tintRow = fwLayerTint[i];
  vec4 response = fwLayerResponse[i];
  vec4 tex = fwLayerTex[i];
  vec2 gp = fwLayerGloss[i];
  metal = response.a;
  vec3 tint = tintRow.rgb;
  float glossScale = 1.0;
  int index = int(tintRow.a + 0.5);
  if (index > 0 && index <= 3) {
    // A metal takes the entry's specular, a dielectric its colour; either
    // modulates the layer's own tint rather than replacing it.
    vec3 source = metal > 0.5 ? fwPaletteSpec[index - 1] : fwPaletteColor[index - 1];
    tint = source * tintRow.rgb;
    glossScale = clamp(fwPaletteGloss[index - 1], 0.05, 1.0);
  }
  tint *= response.rgb;
  colour = tint;
  vec2 tuv = uv * tex.z;
  vec2 tdx = dx * tex.z;
  vec2 tdy = dy * tex.z;
  if (tex.x >= 0.0) {
    vec3 lin = textureGrad(fwDiffuse, vec3(tuv, tex.x), tdx, tdy).rgb;
    // A metal's diffuse texture is pattern around its F0, not albedo.
    if (metal > 0.5) lin /= max(tex.w, 1e-4);
    colour = lin * tint;
  }
  float gloss = gp.x * gp.y * glossScale;
  detail = vec2(0.0);
  if (tex.y >= 0.0) {
    vec4 ng = textureGrad(fwNormalGloss, vec3(tuv, tex.y), tdx, tdy);
    gloss = ng.a * gp.y * glossScale;
    detail = ng.rg * 2.0 - 1.0;
  }
  rough = clamp(1.0 - gloss, 0.04, 1.0);
}

void fwComposite(vec2 uv) {
  // Gradients taken here, in uniform control flow: the layer loop below skips
  // layers with no weight, and implicit derivatives inside it are undefined.
  vec2 dx = dFdx(uv);
  vec2 dy = dFdy(uv);
  vec4 ca = texture2D(fwControlA, uv);
  float weights[4] = float[4](1.0, 0.0, 0.0, 0.0);
  if (fwHasBlend) {
    // The splat: ground, then blue, green and red lerped over it. Each
    // channel's crossing measured against its change across the pixel, so a
    // boundary is anti-aliased at screen resolution.
    vec3 m = ca.rgb;
    vec3 cover = clamp((m - 0.5) / max(fwidth(m), vec3(1e-4)) + 0.5, 0.0, 1.0);
    float wr = cover.r;
    float wg = cover.g * (1.0 - wr);
    float wb = cover.b * (1.0 - cover.g) * (1.0 - wr);
    float ground = (1.0 - cover.b) * (1.0 - cover.g) * (1.0 - wr);
    weights = float[4](wr, wg, wb, ground);
    for (int k = 3; k > 0; k -= 1) {
      if (k >= fwLayerCount) {
        weights[fwLayerCount - 1] += weights[k];
        weights[k] = 0.0;
      }
    }
  }
  // Dark is worn.
  float worn = fwHasWear ? clamp((fwWearThreshold - ca.a) / fwWearFalloff, 0.0, 1.0) * fwWearAmount : 0.0;

  fwColour = vec3(0.0);
  fwRough = 0.0;
  fwMetal = 0.0;
  fwDetail = vec2(0.0);
  for (int k = 0; k < 4; k += 1) {
    float w = weights[k];
    if (w <= 0.0) continue;
    vec3 c; float r; float mt; vec2 d;
    fwLayer(k, uv, dx, dy, c, r, mt, d);
    float pair = fwWearPair[k];
    if (pair >= 0.0 && worn > 0.0) {
      vec3 wc; float wro; float wm; vec2 wd;
      fwLayer(int(pair + 0.5), uv, dx, dy, wc, wro, wm, wd);
      c = mix(c, wc, worn);
      r = mix(r, wro, worn);
      mt = mix(mt, wm, worn);
      d = mix(d, wd, worn);
    }
    fwColour += c * w;
    fwRough += r * w;
    fwMetal += mt * w;
    fwDetail += d * w;
  }
  fwColour *= fwUserTint;
  fwAo = fwHasHal ? clamp(0.35 + 0.65 * texture2D(fwControlC, uv).r, 0.0, 1.0) : 1.0;
}
`;

const COMPOSITE = /* glsl */ `
  fwComposite(vNormalMapUv);
  diffuseColor.rgb = fwColour;
`;

const NORMAL = /* glsl */ `
  // The armour's own _ddn in RG, z rebuilt; the layers' grain rides on it.
  vec2 fwXY = fwHasNormal ? texture2D(fwControlB, vNormalMapUv).rg * 2.0 - 1.0 : vec2(0.0);
  vec3 mapN = vec3(fwXY, sqrt(max(0.0, 1.0 - dot(fwXY, fwXY))));
  vec2 fwD = fwDetail * fwDetailNormal;
  vec3 fwN = vec3(fwD, sqrt(max(0.0, 1.0 - dot(fwD, fwD))));
  // Whiteout blend.
  mapN = normalize(vec3(mapN.xy + fwN.xy, mapN.z * fwN.z));
  mapN.xy *= normalScale;
  normal = normalize( tbn * mapN );
`;

/** Build every LayerBlend submaterial of a piece as a live material. */
export async function liveSurfaces(
  material: MaterialPayload,
  palette: PaletteEntry[],
  client: ArchiveClient,
  options: LiveOptions,
): Promise<LiveSurfaces> {
  const started = performance.now();
  const library = await buildLibrary(material, client, options);
  const controls = new Map<string, DataTexture | null>();

  // Three entries, linear. An item with none gets the bake's three greys.
  const entries = (palette.length ? palette : DEFAULT_PALETTE).slice(0, 3);
  while (entries.length < 3) entries.push(DEFAULT_PALETTE[entries.length]!);
  const paletteColor = entries.map((p) => new Color(srgbToLinear(p.color[0]), srgbToLinear(p.color[1]), srgbToLinear(p.color[2])));
  const paletteSpec = entries.map((p) => new Color(srgbToLinear(p.spec[0]), srgbToLinear(p.spec[1]), srgbToLinear(p.spec[2])));
  const paletteGloss = entries.map((p) => p.glossiness);

  // An array sampler has to be bound even where unused, and to an array.
  const blank = placeholderArray();
  const materials = new Map<string, MeshStandardMaterial>();
  for (const sub of material.submaterials) {
    if (!sub.tintable || !sub.layers.length) continue;
    const { a, b, c } = await buildControls(sub, client, options, controls, Math.min(FIRST_SURFACE, options.surfaceSize));
    const packed = pack(sub, material, library);
    const out = new MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 1 });
    out.name = sub.name;
    // The normal map binding is what gives the shader its UVs and tangent
    // frame; the maps it actually samples are the uniforms below.
    out.normalMap = b ?? a ?? c;
    out.normalScale = new Vector2(1, 1);
    if (!out.normalMap) continue;
    if (sub.glow > 0) {
      out.emissive = new Color(1, 1, 1);
      out.emissiveIntensity = 0;
    }
    const uniforms = {
      fwControlA: { value: a ?? out.normalMap },
      fwControlB: { value: b ?? out.normalMap },
      fwControlC: { value: c ?? out.normalMap },
      fwHasBlend: { value: Boolean(a && sub.textures.blend) },
      fwHasWear: { value: Boolean(a && sub.textures.wear) },
      fwHasNormal: { value: Boolean(b) },
      fwHasHal: { value: Boolean(c) },
      fwDiffuse: { value: (library.diffuse ?? blank) as Texture },
      fwNormalGloss: { value: (library.normal ?? blank) as Texture },
      fwPaletteColor: { value: paletteColor },
      fwPaletteSpec: { value: paletteSpec },
      fwPaletteGloss: { value: paletteGloss },
      fwLayerTint: { value: packed.tint },
      fwLayerResponse: { value: packed.response },
      fwLayerTex: { value: packed.tex },
      fwLayerGloss: { value: packed.gloss },
      fwWearPair: { value: packed.wearPair },
      fwLayerCount: { value: packed.count },
      fwWearThreshold: { value: WEAR_THRESHOLD },
      fwWearFalloff: { value: WEAR_FALLOFF },
      fwWearAmount: { value: options.wear ? 1 : 0 },
      fwUserTint: { value: new Color(1, 1, 1) },
      fwGlow: { value: Math.min(4, sub.glow * GLOW_GAIN) },
      fwDetailNormal: { value: DETAIL_NORMAL },
      fwDebug: { value: 0 },
    };
    out.userData.fwLive = uniforms;
    out.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${DECLARE}`)
        .replace('#include <map_fragment>', `#include <map_fragment>\n${COMPOSITE}`)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = fwRough;')
        .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = fwMetal;')
        .replace('#include <normal_fragment_maps>', NORMAL)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += fwColour * fwGlow;')
        .replace('#include <aomap_fragment>', '#include <aomap_fragment>\n  reflectedLight.indirectDiffuse *= fwAo;\n  reflectedLight.indirectSpecular *= fwAo;')
        .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n  if (fwDebug == 1) gl_FragColor = vec4(fwColour, 1.0);');
    };
    out.customProgramCacheKey = () => 'fw-live';
    materials.set(sub.name, out);
  }

  const textures: Texture[] = [];
  if (library.diffuse) textures.push(library.diffuse);
  if (library.normal) textures.push(library.normal);
  for (const texture of controls.values()) if (texture) textures.push(texture);
  const bytes = textures.reduce((sum, t) => sum + gpuBytes(t), 0);

  const refine = async (): Promise<number> => {
    if (options.surfaceSize <= FIRST_SURFACE) return 0;
    const finer = new Map<string, DataTexture | null>();
    let added = 0;
    for (const sub of material.submaterials) {
      const out = materials.get(sub.name);
      const uniforms = out?.userData.fwLive as { fwControlB: { value: Texture } } | undefined;
      if (!out || !uniforms) continue;
      const { b } = await buildControls(sub, client, options, finer, options.surfaceSize, true);
      if (!b) continue;
      const old = uniforms.fwControlB.value;
      if (old === b) continue;
      uniforms.fwControlB.value = b;
      if (out.normalMap === old) out.normalMap = b;
    }
    for (const [key, texture] of controls) {
      if (!key.startsWith('b|') || !texture) continue;
      const replacement = finer.get(key);
      if (!replacement) continue;
      added += gpuBytes(replacement) - gpuBytes(texture);
      texture.dispose();
      textures.splice(textures.indexOf(texture), 1, replacement);
    }
    return added;
  };
  return { materials, textures, bytes, ms: performance.now() - started, refine };
}

let placeholder: DataArrayTexture | null = null;
/** A 1x1x1 array, shared, never disposed with a piece. */
function placeholderArray(): DataArrayTexture {
  if (!placeholder) {
    placeholder = new DataArrayTexture(new Uint8Array([128, 128, 255, 255]), 1, 1, 1);
    placeholder.format = RGBAFormat;
    placeholder.type = UnsignedByteType;
    placeholder.userData.shared = true;
    placeholder.needsUpdate = true;
  }
  return placeholder;
}

/** Whether this GPU takes S3TC (BC1) textures as they are. */
export function takesS3tc(renderer: { extensions: { has(name: string): boolean } }): boolean {
  return renderer.extensions.has('WEBGL_compressed_texture_s3tc') && renderer.extensions.has('WEBGL_compressed_texture_s3tc_srgb');
}
