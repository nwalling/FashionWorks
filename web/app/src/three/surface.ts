/** Compositing a piece's surfaces with the LayerBlend shader.
 *
 * This is where `web/gpu/` meets real geometry. The shader itself is verified
 * against the Python's baked PNGs -- 356 of 357 submaterials within 3 sRGB
 * units -- so what is new here is only the plumbing: pulling the control maps
 * and the detail library out of the archive, packing the library into a texture
 * array, and running one pass per submaterial into a texture the renderer can
 * bind.
 *
 * The result is a bake, done on the GPU, at load. That is a deliberate middle
 * ground: compositing live in the object's own fragment shader would be better
 * still -- a colourway change would cost nothing -- but it means replacing
 * three.js's material, and this keeps the standard lighting model while proving
 * the rules produce the right pixels on real meshes.
 */

import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshStandardMaterial,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  UnsignedByteType,
} from 'three';

import { createProgram, createLayerArray, createTarget, render, linearMean } from '../../../gpu/bake.js';
import type { LayerRef, MaterialPayload, TexturePayload } from '../worker/archive.worker';

/** Bake resolution. The pipeline uses 1024 and the comparison numbers are
 * measured there, so matching it keeps them comparable. */
export const BAKE_SIZE = 1024;

/** WEB.md caps layer textures at 512 for VRAM. Every slice of an array texture
 * must be the same size, so the library is packed at this one resolution. */
export const LAYER_SIZE = 512;

/** One palette entry: a tint colour, a specular colour and a glossiness.
 *
 * **A metal takes the specular and a dielectric the colour.** A metal has no
 * diffuse albedo -- its appearance *is* its F0 -- and reading the tint colour
 * instead rendered ten Lynx colourways as the same grey arm.
 */
export interface PaletteEntry {
  color: [number, number, number];
  spec: [number, number, number];
  glossiness: number;
}

export type FetchTexture = (path: string, maxSize: number) => Promise<TexturePayload | null>;

function toTexture(payload: TexturePayload, srgb: boolean): DataTexture {
  // The buffer really is ArrayBuffer-backed -- it comes out of wasm as a fresh
  // copy -- but `Uint8Array` is generic over the buffer kind, and three.js
  // wants the narrower one.
  const bytes = payload.rgba as Uint8Array<ArrayBuffer>;
  const texture = new DataTexture(
    bytes, payload.width, payload.height, RGBAFormat, UnsignedByteType,
  );
  if (srgb) texture.colorSpace = SRGBColorSpace;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = true;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

/** Scale an RGBA buffer to a square, by nearest sampling.
 *
 * Only the layer library goes through this, and only to make every slice of the
 * array texture the same size. Nearest rather than a box filter because the
 * alternative is a second full pass over 786,432 texels per slice for a
 * difference the tiling washes out -- these are sampled at an effective tiling
 * of up to 2560.
 */
function square(payload: TexturePayload, size: number): Uint8Array {
  if (payload.width === size && payload.height === size) return payload.rgba;
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const sy = Math.min(payload.height - 1, Math.floor((y * payload.height) / size));
    for (let x = 0; x < size; x += 1) {
      const sx = Math.min(payload.width - 1, Math.floor((x * payload.width) / size));
      const from = (sy * payload.width + sx) * 4;
      const to = (y * size + x) * 4;
      out[to] = payload.rgba[from]!;
      out[to + 1] = payload.rgba[from + 1]!;
      out[to + 2] = payload.rgba[from + 2]!;
      out[to + 3] = payload.rgba[from + 3]!;
    }
  }
  return out;
}

export interface Composited {
  /** Per submaterial name. */
  surfaces: Map<string, { albedo: Texture; orm: Texture }>;
  /** Mean sRGB of each composite, for comparison with the pipeline's bakes. */
  means: Map<string, [number, number, number]>;
  /** Submaterials whose shader is not LayerBlend and so were not composited. */
  skipped: string[];
  layerSlices: number;
  ms: number;
}

/**
 * Composite every LayerBlend submaterial of one piece.
 *
 * `palette` is the item's tint palette from the catalogue. It may be empty --
 * 268 of 491 canonical items carry none, and that shader supplies no albedo, so
 * without a stand-in they render blown-out white.
 */
export interface CompositeOptions {
  readonly wear?: boolean;
  /** Bake resolution. `BAKE_SIZE` for a surface that goes on a mesh; far
   * smaller when all that is wanted is the mean colour, which is what a
   * listing swatch needs. A 64px bake reads the same average as a 1024px one
   * and costs a fraction of the texture decode and the read-back. */
  readonly size?: number;
  /** Resolution of the tiling detail layers. The dominant cost of a composite
   * is decoding these, and a mean does not need them sharp. */
  readonly layerSize?: number;
}

export async function compositeSurfaces(
  material: MaterialPayload,
  palette: PaletteEntry[],
  fetchTexture: FetchTexture,
  wearOrOptions: boolean | CompositeOptions = true,
): Promise<Composited> {
  const options: CompositeOptions = typeof wearOrOptions === 'boolean'
    ? { wear: wearOrOptions }
    : wearOrOptions;
  const wear = options.wear ?? true;
  const bakeSize = options.size ?? BAKE_SIZE;
  const layerSize = options.layerSize ?? LAYER_SIZE;
  const started = performance.now();

  // One offscreen context for the whole piece. Creating one per submaterial
  // exhausts the browser's WebGL context limit at around sixteen.
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { antialias: false });
  if (!gl) throw new Error('WebGL2 is required to composite armour surfaces');
  const program = createProgram(gl);
  const target = createTarget(gl, bakeSize);

  // Every distinct layer texture the piece needs, fetched once and packed into
  // one array. A submaterial samples up to eight layers; binding them
  // individually would want 19 texture units against WebGL2's guaranteed 16.
  const wanted = new Set<string>();
  for (const sub of material.submaterials) {
    for (const layer of sub.layers) {
      for (const entry of [layer, layer.worn]) {
        const resolved = entry && material.library[entry.path.toLowerCase()];
        if (resolved?.diffuseTex) wanted.add(resolved.diffuseTex);
      }
    }
  }

  const slices: Uint8Array[] = [];
  const sliceOf = new Map<string, number>();
  const meanOf = new Map<string, number>();
  for (const path of wanted) {
    const payload = await fetchTexture(path, layerSize);
    if (!payload) continue;
    const rgba = square(payload, layerSize);
    // The mean is measured on the bytes the shader samples, so the metal
    // normalisation is self-consistent with what is uploaded.
    meanOf.set(path, linearMean(rgba));
    sliceOf.set(path, slices.length);
    slices.push(rgba);
  }
  const diffuseArray = createLayerArray(
    gl, slices.length ? slices : [new Uint8Array(layerSize * layerSize * 4)], layerSize,
  );
  // No gloss array yet: the per-pixel gloss lives in the `_ddna` alpha, which
  // needs its own decode. The shader falls back to the layer's own Shininess,
  // which is what the pipeline used before that decode existed.
  const glossArray = createLayerArray(
    gl, [new Uint8Array(layerSize * layerSize * 4).fill(255)], layerSize,
  );
  const blank = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, blank);
  gl.texImage2D(
    gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 0, 255]),
  );

  const controls = new Map<string, WebGLTexture | null>();
  const control = async (path: string | undefined) => {
    if (!path) return null;
    if (!controls.has(path)) {
      const payload = await fetchTexture(path, bakeSize);
      if (!payload) {
        controls.set(path, null);
      } else {
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(
          gl.TEXTURE_2D, 0, gl.RGBA8, payload.width, payload.height, 0,
          gl.RGBA, gl.UNSIGNED_BYTE, payload.rgba as Uint8Array<ArrayBuffer>,
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        controls.set(path, texture);
      }
    }
    return controls.get(path) ?? null;
  };

  const toShaderLayer = (ref: LayerRef | null) => {
    if (!ref) return null;
    const resolved = material.library[ref.path.toLowerCase()];
    const metal = resolved?.metal ?? false;
    return {
      tint: Array.from(ref.tintColor),
      paletteTint: ref.paletteTint,
      // A metal's response is its Specular, a dielectric's its Diffuse. 168 of
      // 317 dielectric layers set Diffuse to something other than white, so
      // ignoring it renders them at full brightness.
      response: Array.from(metal ? (resolved?.specular ?? [0.04, 0.04, 0.04])
        : (resolved?.diffuse ?? [1, 1, 1])),
      metal,
      diffuseSlice: resolved?.diffuseTex ? (sliceOf.get(resolved.diffuseTex) ?? -1) : -1,
      glossSlice: -1,
      diffuseMean: resolved?.diffuseTex ? (meanOf.get(resolved.diffuseTex) ?? 1) : 1,
      tiling: ref.uvTiling,
      shininess: resolved?.shininess ?? 0.5,
      glossMult: ref.glossMult,
      worn: null as unknown,
    };
  };

  const surfaces = new Map<string, { albedo: Texture; orm: Texture }>();
  const means = new Map<string, [number, number, number]>();
  const skipped: string[] = [];

  for (const sub of material.submaterials) {
    if (!sub.tintable || sub.layers.length === 0) {
      skipped.push(sub.name);
      continue;
    }
    const layers = sub.layers.map((ref) => {
      const packed = toShaderLayer(ref)!;
      packed.worn = toShaderLayer(ref.worn);
      return packed;
    });

    const result = render(gl, program, target, bakeSize, {
      layers,
      palette,
      blend: await control(sub.textures.blend),
      wear: await control(sub.textures.wear),
      hal: await control(sub.textures.hal),
      wearThreshold: 0.5,
      wearFalloff: 0.5,
      wearAmount: wear ? 1 : 0,
    }, { diffuse: diffuseArray, gloss: glossArray, blank });

    // The mean of the composite, for comparison with the pipeline's bake of
    // the same submaterial. Computed here because the read-back buffer is
    // already in hand.
    let total = [0, 0, 0];
    for (let i = 0; i < result.albedo.length; i += 4) {
      total[0]! += result.albedo[i]!;
      total[1]! += result.albedo[i + 1]!;
      total[2]! += result.albedo[i + 2]!;
    }
    const texels = result.albedo.length / 4;
    means.set(sub.name, total.map((v) => v / texels) as [number, number, number]);

    surfaces.set(sub.name, {
      albedo: toTexture(
        { path: sub.name, width: bakeSize, height: bakeSize, rgba: result.albedo }, true,
      ),
      orm: toTexture(
        { path: sub.name, width: bakeSize, height: bakeSize, rgba: result.orm }, false,
      ),
    });
  }

  return { surfaces, means, skipped, layerSlices: slices.length, ms: performance.now() - started };
}

/** A three.js material for one submaterial, using its composited surface. */
export function materialFor(
  name: string,
  composited: Composited,
  normal?: Texture,
): MeshStandardMaterial {
  const surface = composited.surfaces.get(name);
  const material = new MeshStandardMaterial({
    // White, with the colour arriving entirely through the map. The flat
    // palette multiply that used to sit on top repainted the 87% of layers the
    // artist never palette-tinted.
    color: 0xffffff,
    roughness: 1,
    metalness: 1,
  });
  if (surface) {
    material.map = surface.albedo;
    // glTF's ORM packing: occlusion in red, roughness in green, metalness in
    // blue, all read off the one texture.
    material.aoMap = surface.orm;
    material.roughnessMap = surface.orm;
    material.metalnessMap = surface.orm;
  } else {
    material.color.setHex(0x8a929a);
    material.roughness = 0.55;
    material.metalness = 0.25;
  }
  if (normal) {
    normal.wrapS = RepeatWrapping;
    normal.wrapT = RepeatWrapping;
    material.normalMap = normal;
  }
  return material;
}
