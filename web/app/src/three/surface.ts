/** Compositing a piece's surfaces with the LayerBlend shader.
 *
 * This is where `web/gpu/` meets real geometry. The shader itself is verified
 * against the Python's baked PNGs -- 356 of 357 submaterials within 3 sRGB
 * units -- so what is new here is only the plumbing: pulling the control maps
 * and the detail library out of the archive, running one pass per submaterial,
 * and handing the renderer textures it can bind.
 *
 * Three decisions shape it, each forced by a bug:
 *
 * **One WebGL context, shared.** Each composite used to create its own and
 * never release it. Chrome keeps sixteen live and, past that, *drops the
 * oldest* -- which is the viewer's own. The whole viewport went white with a
 * broken-image icon, and stayed that way until something re-rendered it.
 * Equipping a family of twenty colourways was enough to get there, because
 * every swatch was a composite too.
 *
 * **One atlas per piece, not one texture pair per submaterial.** A piece's
 * submaterials share its UV space and each covers only its own islands, yet
 * each was baked to a full 1024 square: eight submaterials came to sixteen
 * 1024 textures, about 85 MB of GPU memory for one torso, never released. Now
 * every pass writes only the texels its own triangles own ({@link rasterOwners})
 * into one shared target, read back once.
 *
 * **The bake holds colour; the grain is drawn live.** A layer's diffuse tiles
 * at an effective 20-2560 repeats across the UV square, so a 1024 bake has a
 * few texels per repeat -- which cannot hold a weave, and without mips aliased
 * it into coarse grey stripes. The bake now takes each layer's mean, and
 * `detail.ts` multiplies the grain back on the mesh at screen resolution,
 * where it can actually be resolved.
 */

import {
  ClampToEdgeWrapping,
  DataArrayTexture,
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

import {
  createControlMap,
  createLayerArray,
  createOwnerMap,
  createProgram,
  createTarget,
  linearMean,
  linearMeanRgb,
  readTarget,
  render,
} from '../../../gpu/bake.js';
import type { LayerRef, MaterialPayload, TexturePayload } from '../worker/archive.worker';

/** Bake resolution. The pipeline uses 1024 and the comparison numbers are
 * measured there, so matching it keeps them comparable. */
export const BAKE_SIZE = 1024;

/** WEB.md caps layer textures at 512 for VRAM. Every slice of an array texture
 * must be the same size, so the library is packed at this one resolution. */
export const LAYER_SIZE = 512;

/** Resolution of the grain drawn at render time.
 *
 * A layer repeats 20-2560 times across a piece's UV square, so even a
 * full-screen chest plate shows each repeat at tens of pixels. 256 is already
 * more than that holds, and it keeps a piece's grain to a few MB. */
export const DETAIL_SIZE = 256;

/** How much of a composited surface a `Glow` of 1.0 emits.
 *
 * CryEngine's `Glow` is a fraction of the surface's own albedo emitted. Our
 * lighting is not the game's, so the scale is chosen, not read: calibrated on
 * the ADP-mk4 Big Boss, whose graffiti (Glow 0.02 on a bright green layer)
 * glows in CIG's render while the near-black plate it sits on stays dark. */
export const GLOW_GAIN = 25;

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

/** The parts of a mesh a composite needs: where each submaterial sits in UV
 * space. A piece can be several meshes -- arms ship a left and a right -- and
 * they share one material, so they share one atlas. */
export interface CompositeGeometry {
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
  readonly submeshes: ReadonlyArray<{ materialId: number; start: number; count: number }>;
}

function dataTexture(rgba: Uint8Array, width: number, height: number, srgb: boolean): DataTexture {
  // The buffer really is ArrayBuffer-backed -- it comes out of wasm or a
  // read-back as a fresh copy -- but `Uint8Array` is generic over the buffer
  // kind, and three.js wants the narrower one.
  const texture = new DataTexture(
    rgba as Uint8Array<ArrayBuffer>, width, height, RGBAFormat, UnsignedByteType,
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

/** Scale an RGBA buffer to a square, by nearest sampling. Only for packing a
 * texture array, whose slices must all be one size. */
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

/** No owner. Ids are submaterial indices, and a `.mtl` never has 255. */
export const UNOWNED = 255;

export interface Owners {
  /** `size * size` submaterial ids, row 0 at v = 0, dilated into the gutters. */
  readonly map: Uint8Array;
  /** Undilated, for measuring: a texel here really is under a triangle. */
  readonly core: Uint8Array;
  /** Per submaterial, the fraction of its texels another submaterial also
   * claims. High means the two share UV space and an atlas cannot hold both. */
  readonly overlap: Map<number, number>;
}

/** Which submaterial owns each texel of UV space.
 *
 * A plain scanline rasteriser over the UV triangles. Every triangle claims at
 * least the texel under its centroid, so a sliver narrower than a texel still
 * lands somewhere rather than sampling a neighbour's colour.
 *
 * Then **dilated** by `gutter` texels: a mip level, or bilinear filtering at
 * an island's edge, reads a little outside the triangle, and an unowned texel
 * there is black -- which shows as a dark seam around every island.
 */
export function rasterOwners(
  geometry: readonly CompositeGeometry[],
  size: number,
  materialCount: number,
  gutter = Math.max(2, Math.round(size / 128)),
): Owners {
  const core = new Uint8Array(size * size).fill(UNOWNED);
  const owned = new Map<number, number>();
  const shared = new Map<number, number>();
  const claim = (x: number, y: number, id: number) => {
    const at = y * size + x;
    const current = core[at]!;
    if (current === UNOWNED) {
      core[at] = id;
      owned.set(id, (owned.get(id) ?? 0) + 1);
    } else if (current !== id) {
      shared.set(id, (shared.get(id) ?? 0) + 1);
    }
  };
  const clampUv = (v: number) => Math.min(1, Math.max(0, v));

  for (const mesh of geometry) {
    const { uvs, indices } = mesh;
    for (const group of mesh.submeshes) {
      const id = group.materialId;
      if (id >= materialCount || id >= UNOWNED) continue;
      for (let t = group.start; t + 2 < group.start + group.count; t += 3) {
        const a = indices[t]!;
        const b = indices[t + 1]!;
        const c = indices[t + 2]!;
        const ax = clampUv(uvs[a * 2]!) * size;
        const ay = clampUv(uvs[a * 2 + 1]!) * size;
        const bx = clampUv(uvs[b * 2]!) * size;
        const by = clampUv(uvs[b * 2 + 1]!) * size;
        const cx = clampUv(uvs[c * 2]!) * size;
        const cy = clampUv(uvs[c * 2 + 1]!) * size;

        const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
        const maxX = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx)));
        const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
        const maxY = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy)));
        let hit = false;
        if (Math.abs(area) > 1e-9) {
          const sign = area > 0 ? 1 : -1;
          for (let y = minY; y <= maxY; y += 1) {
            const py = y + 0.5;
            for (let x = minX; x <= maxX; x += 1) {
              const px = x + 0.5;
              const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * sign;
              const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * sign;
              const w2 = ((ax - px) * (by - py) - (ay - py) * (bx - px)) * sign;
              if (w0 >= 0 && w1 >= 0 && w2 >= 0) {
                claim(x, y, id);
                hit = true;
              }
            }
          }
        }
        if (!hit) {
          const x = Math.min(size - 1, Math.floor((ax + bx + cx) / 3));
          const y = Math.min(size - 1, Math.floor((ay + by + cy) / 3));
          claim(x, y, id);
        }
      }
    }
  }

  // Grow each island outwards one texel per pass, into texels nobody owns.
  let frontier = core.slice();
  for (let pass = 0; pass < gutter; pass += 1) {
    const next = frontier.slice();
    let grew = false;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const at = y * size + x;
        if (frontier[at] !== UNOWNED) continue;
        let id = UNOWNED;
        if (x > 0 && frontier[at - 1] !== UNOWNED) id = frontier[at - 1]!;
        else if (x < size - 1 && frontier[at + 1] !== UNOWNED) id = frontier[at + 1]!;
        else if (y > 0 && frontier[at - size] !== UNOWNED) id = frontier[at - size]!;
        else if (y < size - 1 && frontier[at + size] !== UNOWNED) id = frontier[at + size]!;
        if (id !== UNOWNED) {
          next[at] = id;
          grew = true;
        }
      }
    }
    frontier = next;
    if (!grew) break;
  }
  const map = frontier;

  const overlap = new Map<number, number>();
  for (const [id, count] of owned) {
    overlap.set(id, (shared.get(id) ?? 0) / Math.max(1, count + (shared.get(id) ?? 0)));
  }
  for (const [id, count] of shared) {
    if (!owned.has(id)) overlap.set(id, count > 0 ? 1 : 0);
  }
  return { map, core, overlap };
}

/** A submaterial that shares more than this much of its UV space with
 * another gets a bake of its own; an atlas would give it the other's colour. */
const OVERLAP_LIMIT = 0.1;

/** The grain a piece's layers carry, for drawing at render time.
 *
 * One array for diffuse and one for normals, a slice per distinct layer
 * texture. Per submaterial, a table maps each of its eight layer slots (four
 * base, four worn) to those slices and a tiling.
 */
export interface DetailLibrary {
  readonly diffuse: DataArrayTexture | null;
  readonly normal: DataArrayTexture | null;
  /** Per submaterial name: eight `[diffuseSlice, normalSlice, tiling, 0]`. */
  readonly slots: Map<string, Float32Array>;
  /** Per submaterial name: eight linear mean colours, the ones the bake used. */
  readonly means: Map<string, Float32Array>;
}

export interface Composited {
  /** Per submaterial name. With an atlas, every entry is the same pair. */
  surfaces: Map<string, { albedo: Texture; orm: Texture }>;
  /** Mean sRGB of each submaterial's own texels. */
  means: Map<string, [number, number, number]>;
  /** Submaterials whose shader is not LayerBlend and so were not composited. */
  skipped: string[];
  detail: DetailLibrary | null;
  layerSlices: number;
  /** How many distinct texture pairs came out: 1 with an atlas. */
  textures: number;
  ms: number;
}

export interface CompositeOptions {
  readonly wear?: boolean;
  /** Bake resolution. `BAKE_SIZE` for a surface that goes on a mesh; far
   * smaller when all that is wanted is the mean colour. */
  readonly size?: number;
  /** Resolution the layer textures are fetched at, to take their means. */
  readonly layerSize?: number;
  /** Where each submaterial sits in UV space. Without it every submaterial
   * gets a full bake of its own, as before. */
  readonly geometry?: readonly CompositeGeometry[];
  /** Build the render-time grain library as well. Off for a swatch. */
  readonly detail?: boolean;
}

interface Shared {
  gl: WebGL2RenderingContext;
  program: ReturnType<typeof createProgram>;
  targets: Map<number, ReturnType<typeof createTarget>>;
  blank: WebGLTexture;
}

let shared: Shared | null = null;

/** The one compositing context. Recreated only if the browser took it away. */
function context(): Shared {
  if (shared && !shared.gl.isContextLost()) return shared;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false });
  if (!gl) throw new Error('WebGL2 is required to composite armour surfaces');
  const blank = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, blank);
  gl.texImage2D(
    gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 0, 255]),
  );
  shared = { gl, program: createProgram(gl), targets: new Map(), blank };
  return shared;
}

function targetFor(ctx: Shared, size: number) {
  let target = ctx.targets.get(size);
  if (!target) {
    target = createTarget(ctx.gl, size);
    ctx.targets.set(size, target);
  }
  return target;
}

/** One composite at a time. They share a context, and a composite spends most
 * of its life awaiting textures from a worker that is single-threaded anyway. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Composite every LayerBlend submaterial of one piece.
 *
 * `palette` is the item's tint palette from the catalogue. It may be empty --
 * 268 of 491 canonical items carry none, and that shader supplies no albedo, so
 * without a stand-in they render blown-out white.
 */
export function compositeSurfaces(
  material: MaterialPayload,
  palette: PaletteEntry[],
  fetchTexture: FetchTexture,
  wearOrOptions: boolean | CompositeOptions = true,
): Promise<Composited> {
  const options: CompositeOptions = typeof wearOrOptions === 'boolean'
    ? { wear: wearOrOptions }
    : wearOrOptions;
  const run = queue.then(() => composite(material, palette, fetchTexture, options));
  queue = run.catch(() => undefined);
  return run;
}

async function composite(
  material: MaterialPayload,
  palette: PaletteEntry[],
  fetchTexture: FetchTexture,
  options: CompositeOptions,
): Promise<Composited> {
  const wear = options.wear ?? true;
  const bakeSize = options.size ?? BAKE_SIZE;
  const layerSize = options.layerSize ?? (options.detail ? DETAIL_SIZE : LAYER_SIZE);
  const started = performance.now();
  const ctx = context();
  const { gl } = ctx;

  // Every distinct layer texture the piece needs, fetched once: for its mean,
  // which is all the bake uses, and -- when asked -- for the grain library.
  const layerPaths = new Set<string>();
  const normalPaths = new Set<string>();
  for (const sub of material.submaterials) {
    for (const layer of sub.layers) {
      for (const entry of [layer, layer.worn]) {
        const resolved = entry && material.library[entry.path.toLowerCase()];
        if (resolved?.diffuseTex) layerPaths.add(resolved.diffuseTex);
        if (options.detail && resolved?.normalTex) normalPaths.add(resolved.normalTex);
      }
    }
  }

  const diffuseSlices: Uint8Array[] = [];
  const sliceOf = new Map<string, number>();
  const meanOf = new Map<string, number>();
  const meanRgbOf = new Map<string, [number, number, number]>();
  for (const path of layerPaths) {
    const payload = await fetchTexture(path, layerSize);
    if (!payload) continue;
    const rgba = square(payload, layerSize);
    // Measured on the bytes the shader would sample, so the metal
    // normalisation is self-consistent.
    meanOf.set(path, linearMean(rgba));
    meanRgbOf.set(path, linearMeanRgb(rgba) as [number, number, number]);
    sliceOf.set(path, diffuseSlices.length);
    if (options.detail) diffuseSlices.push(rgba);
    else diffuseSlices.push(new Uint8Array(0));
  }
  const normalSlices: Uint8Array[] = [];
  const normalSliceOf = new Map<string, number>();
  for (const path of normalPaths) {
    const payload = await fetchTexture(path, layerSize);
    if (!payload) continue;
    normalSliceOf.set(path, normalSlices.length);
    normalSlices.push(square(payload, layerSize));
  }

  // The bake itself samples no layer texture -- flat detail -- so the array it
  // is handed is a placeholder. The shader still declares the sampler.
  const diffuseArray = createLayerArray(gl, [new Uint8Array(4 * 4 * 4)], 4);
  const glossArray = createLayerArray(gl, [new Uint8Array(4 * 4 * 4).fill(255)], 4);

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
    const texture = resolved?.diffuseTex && sliceOf.has(resolved.diffuseTex) ? resolved.diffuseTex : null;
    return {
      tint: Array.from(ref.tintColor),
      paletteTint: ref.paletteTint,
      // A metal's response is its Specular, a dielectric's its Diffuse. 168 of
      // 317 dielectric layers set Diffuse to something other than white, so
      // ignoring it renders them at full brightness.
      response: Array.from(metal ? (resolved?.specular ?? [0.04, 0.04, 0.04])
        : (resolved?.diffuse ?? [1, 1, 1])),
      metal,
      diffuseSlice: texture ? 0 : -1,
      glossSlice: -1,
      diffuseMean: texture ? (meanOf.get(texture) ?? 1) : 1,
      meanRgb: texture ? meanRgbOf.get(texture) : undefined,
      tiling: ref.uvTiling * (resolved?.tileU ?? 1),
      shininess: resolved?.shininess ?? 0.5,
      glossMult: ref.glossMult,
      worn: null as unknown,
    };
  };

  const surfaces = new Map<string, { albedo: Texture; orm: Texture }>();
  const means = new Map<string, [number, number, number]>();
  const skipped: string[] = [];
  const slotTables = new Map<string, Float32Array>();
  const slotMeans = new Map<string, Float32Array>();

  const tintable = material.submaterials
    .map((sub, id) => ({ sub, id }))
    .filter(({ sub }) => {
      const ok = sub.tintable && sub.layers.length > 0;
      if (!ok) skipped.push(sub.name);
      return ok;
    });

  // The render-time slot table: which grain each of the eight layer slots
  // draws, at what tiling, around what mean.
  for (const { sub } of tintable) {
    const table = new Float32Array(32).fill(-1);
    const slotMean = new Float32Array(24).fill(1);
    const put = (slot: number, ref: LayerRef | null) => {
      if (!ref) return;
      const resolved = material.library[ref.path.toLowerCase()];
      const diffuse = resolved?.diffuseTex ? sliceOf.get(resolved.diffuseTex) : undefined;
      const normal = resolved?.normalTex ? normalSliceOf.get(resolved.normalTex) : undefined;
      table.set([
        diffuse ?? -1,
        normal ?? -1,
        ref.uvTiling * (resolved?.tileU ?? 1),
        resolved?.metal ? 1 : 0,
      ], slot * 4);
      const mean = resolved?.diffuseTex ? meanRgbOf.get(resolved.diffuseTex) : undefined;
      if (mean) slotMean.set(mean, slot * 3);
    };
    sub.layers.slice(0, 4).forEach((layer, i) => {
      put(i, layer);
      put(i + 4, layer.worn);
    });
    slotTables.set(sub.name, table);
    slotMeans.set(sub.name, slotMean);
  }

  // Who owns which texel. Submaterials that share UV space with another get a
  // bake of their own; everything else goes in the atlas.
  const owners = options.geometry?.length
    ? rasterOwners(options.geometry, bakeSize, material.submaterials.length)
    : null;
  const dedicated = new Set<number>();
  if (owners) {
    for (const { id } of tintable) {
      if ((owners.overlap.get(id) ?? 0) > OVERLAP_LIMIT) dedicated.add(id);
    }
  } else {
    for (const { id } of tintable) dedicated.add(id);
  }

  const created: WebGLTexture[] = [diffuseArray, glossArray];
  const ownerTexture = owners ? createOwnerMap(gl, owners.map, bakeSize) : null;
  if (ownerTexture) created.push(ownerTexture);
  const target = targetFor(ctx, bakeSize);
  const arrays = { diffuse: diffuseArray, gloss: glossArray, blank: ctx.blank };

  const pass = async (sub: MaterialPayload['submaterials'][number], id: number, owned: boolean, clear: boolean) => {
    const layers = sub.layers.map((ref) => {
      const packed = toShaderLayer(ref)!;
      packed.worn = toShaderLayer(ref.worn);
      return packed;
    });
    const blend = await control(sub.textures.blend);
    const wearMap = await control(sub.textures.wear);
    const hal = await control(sub.textures.hal);
    render(gl, ctx.program, target, bakeSize, {
      layers,
      palette,
      blend,
      wear: wearMap,
      hal,
      wearThreshold: 0.5,
      wearFalloff: 0.5,
      wearAmount: wear ? 1 : 0,
      flatDetail: true,
      owner: owned ? ownerTexture : null,
      ownerId: id,
    }, arrays, { clear, read: false });
  };

  const meanOver = (albedo: Uint8Array, mask: Uint8Array | null, id: number): [number, number, number] | null => {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0, t = 0; i < albedo.length; i += 4, t += 1) {
      if (mask && mask[t] !== id) continue;
      r += albedo[i]!;
      g += albedo[i + 1]!;
      b += albedo[i + 2]!;
      n += 1;
    }
    return n ? [r / n, g / n, b / n] : null;
  };

  let textures = 0;
  // The atlas: every submaterial that can share, in one target, read once.
  const shared = tintable.filter(({ id }) => !dedicated.has(id));
  if (shared.length && owners) {
    let first = true;
    for (const { sub, id } of shared) {
      await pass(sub, id, true, first);
      first = false;
    }
    const result = readTarget(gl, target, bakeSize);
    const pair = {
      albedo: dataTexture(result.albedo, bakeSize, bakeSize, true),
      orm: dataTexture(result.orm, bakeSize, bakeSize, false),
    };
    textures += 1;
    for (const { sub, id } of shared) {
      surfaces.set(sub.name, pair);
      // Measured over the texels this submaterial's triangles actually cover,
      // not the whole square -- which counted colour the mesh never shows.
      const mean = meanOver(result.albedo, owners.core, id) ?? meanOver(result.albedo, owners.map, id);
      if (mean) means.set(sub.name, mean);
    }
  }
  for (const { sub, id } of tintable.filter(({ id: i }) => dedicated.has(i))) {
    await pass(sub, id, false, true);
    const result = readTarget(gl, target, bakeSize);
    surfaces.set(sub.name, {
      albedo: dataTexture(result.albedo, bakeSize, bakeSize, true),
      orm: dataTexture(result.orm, bakeSize, bakeSize, false),
    });
    textures += 1;
    const mask = owners ? owners.core : null;
    const mean = (mask && meanOver(result.albedo, mask, id)) || meanOver(result.albedo, null, id);
    if (mean) means.set(sub.name, mean);
  }

  for (const texture of controls.values()) if (texture) gl.deleteTexture(texture);
  for (const texture of created) gl.deleteTexture(texture);

  let detail: DetailLibrary | null = null;
  if (options.detail) {
    const arrayOf = (slices: Uint8Array[], srgb: boolean) => {
      const real = slices.filter((s) => s.length);
      if (!real.length) return null;
      const data = new Uint8Array(layerSize * layerSize * 4 * slices.length);
      slices.forEach((slice, i) => {
        if (slice.length) data.set(slice, i * layerSize * layerSize * 4);
      });
      const texture = new DataArrayTexture(
        data as Uint8Array<ArrayBuffer>, layerSize, layerSize, slices.length,
      );
      texture.format = RGBAFormat;
      texture.type = UnsignedByteType;
      if (srgb) texture.colorSpace = SRGBColorSpace;
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;
      texture.minFilter = LinearMipmapLinearFilter;
      texture.magFilter = LinearFilter;
      texture.generateMipmaps = true;
      texture.anisotropy = 4;
      texture.needsUpdate = true;
      return texture;
    };
    detail = {
      diffuse: arrayOf(diffuseSlices, true),
      normal: arrayOf(normalSlices, false),
      slots: slotTables,
      means: slotMeans,
    };
  }

  return {
    surfaces,
    means,
    skipped,
    detail,
    layerSlices: diffuseSlices.length,
    textures,
    ms: performance.now() - started,
  };
}

/** A three.js material for one submaterial, using its composited surface.
 *
 * The plain version, without render-time grain: `detail.ts` builds the full
 * one. Kept for the development pages and for anything that only wants to see
 * the bake.
 */
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

export { dataTexture };
