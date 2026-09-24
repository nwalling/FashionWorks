/** Types for `bake.js`.
 *
 * `web/gpu/` is plain ESM with no build step, so it can be opened straight in a
 * browser -- that is the point of it, and the reason the types live here rather
 * than in the source. `layerblend.js` needs none: it exports strings and two
 * pure functions.
 */

export const LAYER_SIZE: number;

/** The stand-in palette for an item that carries none: three near-greys. */
export const DEFAULT_PALETTE: ReadonlyArray<{
  readonly color: [number, number, number];
  readonly spec: [number, number, number];
  readonly glossiness: number;
}>;

export interface Program {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

export interface Target {
  framebuffer: WebGLFramebuffer;
  albedo: WebGLTexture;
  orm: WebGLTexture;
}

export interface LayerArrays {
  diffuse: WebGLTexture;
  gloss: WebGLTexture;
  blank: WebGLTexture | null;
}

export function createProgram(gl: WebGL2RenderingContext): Program;

export function createLayerArray(
  gl: WebGL2RenderingContext,
  slices: Uint8Array[],
  size?: number,
): WebGLTexture;

export function createControlMap(gl: WebGL2RenderingContext, image: TexImageSource): WebGLTexture;

export function createTarget(gl: WebGL2RenderingContext, size: number): Target;

export function render(
  gl: WebGL2RenderingContext,
  program: Program,
  target: Target,
  size: number,
  material: Record<string, unknown>,
  arrays: LayerArrays,
  options?: { clear?: boolean; read?: true },
): { albedo: Uint8Array; orm: Uint8Array };
export function render(
  gl: WebGL2RenderingContext,
  program: Program,
  target: Target,
  size: number,
  material: Record<string, unknown>,
  arrays: LayerArrays,
  options: { clear?: boolean; read: false },
): null;

/** Read both attachments of a bake target back to the CPU. */
export function readTarget(
  gl: WebGL2RenderingContext,
  target: Target,
  size: number,
): { albedo: Uint8Array; orm: Uint8Array };

/** A single-channel owner map, one submaterial id per texel. */
export function createOwnerMap(gl: WebGL2RenderingContext, owners: Uint8Array, size: number): WebGLTexture;

/** The linear mean colour of an sRGB RGBA buffer, per channel. */
export function linearMeanRgb(rgba: Uint8Array | Uint8ClampedArray): [number, number, number];

export function rasterise(image: TexImageSource, size: number): Uint8ClampedArray;

export function linearMean(rgba: Uint8Array | Uint8ClampedArray): number;

export function meanRgb(pixels: Uint8Array): [number, number, number];
