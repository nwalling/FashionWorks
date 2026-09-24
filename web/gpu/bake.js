// WebGL2 plumbing for the LayerBlend shader: compile it, pack the layer
// library into texture arrays, render a submaterial and read it back.
//
// The read-back exists for the check harness. In the viewer the same program
// draws straight into the scene, and nothing comes back across the bus.

import { FRAGMENT, VERTEX, UNIFORM_NAMES, MAX_LAYERS, MAX_BASE_LAYERS, packLayers } from './layerblend.js';

/// WEB.md caps layer textures at 512 on the web, for VRAM. Every slice of an
/// array texture must be the same size, so the library is packed at this one
/// resolution; a library packed by resolution would use one array per size.
export const LAYER_SIZE = 512;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || 'shader compile failed');
  }
  return shader;
}

export function createProgram(gl) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || 'link failed');
  }
  const uniforms = {};
  for (const name of UNIFORM_NAMES) {
    // An array uniform is looked up by its first element.
    uniforms[name] = gl.getUniformLocation(program, name)
      ?? gl.getUniformLocation(program, `${name}[0]`);
  }
  return { program, uniforms };
}

/// Draw an image into a canvas at `size` and return its RGBA bytes.
///
/// This is the resize the browser has: bilinear, not the Lanczos the bake uses.
/// It matters only for the layer library, where the two differ by less than the
/// tiling quantisation already does.
export function rasterise(image, size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, size, size);
  return context.getImageData(0, 0, size, size).data;
}

/// A layer slice's mean in linear space, measured on the bytes the shader will
/// actually sample rather than on the source file, so the metal normalisation
/// is self-consistent with what is uploaded.
export function linearMean(rgba) {
  // A 256-entry table: the conversion is per byte and this runs over 786,432
  // of them per slice.
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i += 1) {
    const c = i / 255;
    table[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  let sum = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    sum += table[rgba[i]] + table[rgba[i + 1]] + table[rgba[i + 2]];
  }
  return sum / (rgba.length / 4) / 3;
}

/// Upload a set of rasterised layer images as one `TEXTURE_2D_ARRAY`.
export function createLayerArray(gl, slices, size = LAYER_SIZE) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
  // **A full mip chain.** A layer texture is sampled at an effective tiling of
  // up to 2560, so one repeat can be a few texels of the bake; with a single
  // level and LINEAR the sampler skips most of the texture and aliases what is
  // left into moire. With mips the hardware picks the level whose texels match
  // the footprint, which is what the pipeline's Lanczos resize did.
  const levels = Math.floor(Math.log2(size)) + 1;
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, gl.RGBA8, size, size, Math.max(slices.length, 1));
  slices.forEach((rgba, index) => {
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY, 0, 0, 0, index, size, size, 1,
      gl.RGBA, gl.UNSIGNED_BYTE, rgba,
    );
  });
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return texture;
}

/// The linear mean colour of an sRGB RGBA buffer, per channel.
export function linearMeanRgb(rgba) {
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i += 1) {
    const c = i / 255;
    table[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    r += table[rgba[i]];
    g += table[rgba[i + 1]];
    b += table[rgba[i + 2]];
  }
  const n = Math.max(1, rgba.length / 4);
  return [r / n, g / n, b / n];
}

/// A single-channel owner map: which submaterial each texel of UV space
/// belongs to. Nearest, because an owner is an id, not a quantity.
export function createOwnerMap(gl, owners, size) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, size, size, 0, gl.RED, gl.UNSIGNED_BYTE, owners);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return texture;
}

/// A control map -- blend, wear or hal. Bilinear and clamped: these are per
/// piece and are sampled once over their own UV space, never tiled.
export function createControlMap(gl, image) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return texture;
}

/// A framebuffer with two colour attachments: albedo and ORM in one pass.
export function createTarget(gl, size) {
  const make = () => {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, size, size);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return texture;
  };
  const albedo = make();
  const orm = make();
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, albedo, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, orm, 0);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`framebuffer incomplete: 0x${status.toString(16)}`);
  }
  return { framebuffer, albedo, orm };
}

export const DEFAULT_PALETTE = [
  // The stand-in for the 268 canonical items that carry no palette at all.
  // Without it a LayerBlend material with nothing to tint renders blown-out
  // white; three near-greys keep the mask's panel variation visible.
  { color: [0.42, 0.43, 0.45], spec: [0.23, 0.23, 0.23], glossiness: 0.55 },
  { color: [0.30, 0.31, 0.33], spec: [0.23, 0.23, 0.23], glossiness: 0.65 },
  { color: [0.55, 0.56, 0.58], spec: [0.28, 0.28, 0.28], glossiness: 0.45 },
];

/// Render one submaterial and read both targets back.
///
/// `material` carries the layer stack, the control-map textures and the
/// palette; `arrays` the two library texture arrays.
export function render(gl, { program, uniforms }, target, size, material, arrays, options = {}) {
  const { clear = false, read = true } = options;
  const packed = packLayers(material.layers);
  const palette = (material.palette && material.palette.length ? material.palette : DEFAULT_PALETTE)
    .slice(0, 3);
  while (palette.length < 3) palette.push(DEFAULT_PALETTE[palette.length]);

  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  gl.viewport(0, 0, size, size);
  if (clear) {
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  gl.useProgram(program);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);

  const bind = (unit, kind, texture, location) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(kind, texture);
    gl.uniform1i(location, unit);
  };
  bind(0, gl.TEXTURE_2D_ARRAY, arrays.diffuse, uniforms.uDiffuse);
  bind(1, gl.TEXTURE_2D_ARRAY, arrays.gloss, uniforms.uGloss);
  bind(2, gl.TEXTURE_2D, material.blend ?? arrays.blank, uniforms.uBlend);
  bind(3, gl.TEXTURE_2D, material.wear ?? arrays.blank, uniforms.uWear);
  bind(4, gl.TEXTURE_2D, material.hal ?? arrays.blank, uniforms.uHal);
  bind(5, gl.TEXTURE_2D, material.owner ?? arrays.blank, uniforms.uOwner);
  gl.uniform1i(uniforms.uHasOwner, material.owner ? 1 : 0);
  gl.uniform1i(uniforms.uOwnerId, material.ownerId ?? 0);
  gl.uniform1i(uniforms.uFlatDetail, material.flatDetail ? 1 : 0);
  gl.uniform3fv(uniforms.uLayerMean, packed.mean);

  gl.uniform1i(uniforms.uHasBlend, material.blend ? 1 : 0);
  gl.uniform1i(uniforms.uHasWear, material.wear ? 1 : 0);
  gl.uniform1i(uniforms.uHasHal, material.hal ? 1 : 0);

  gl.uniform3fv(uniforms.uPaletteColor, palette.flatMap((p) => p.color));
  gl.uniform3fv(uniforms.uPaletteSpec, palette.flatMap((p) => p.spec));
  gl.uniform1fv(uniforms.uPaletteGloss, palette.map((p) => p.glossiness));

  gl.uniform4fv(uniforms.uLayerTint, packed.tint);
  gl.uniform4fv(uniforms.uLayerResponse, packed.response);
  gl.uniform4fv(uniforms.uLayerTex, packed.tex);
  gl.uniform2fv(uniforms.uLayerGlossParams, packed.glossParams);
  gl.uniform1fv(uniforms.uWearPair, packed.wearPair);

  gl.uniform1i(uniforms.uLayerCount, packed.count);
  gl.uniform1f(uniforms.uWearThreshold, material.wearThreshold ?? 0.5);
  gl.uniform1f(uniforms.uWearFalloff, material.wearFalloff ?? 0.5);
  gl.uniform1f(uniforms.uWearAmount, material.wearAmount ?? 1);
  gl.uniform3fv(uniforms.uUserTint, material.userTint ?? [1, 1, 1]);

  gl.drawArrays(gl.TRIANGLES, 0, 3);
  if (!read) return null;
  return readTarget(gl, target, size);
}

/// Read both attachments of a bake target back to the CPU.
export function readTarget(gl, target, size) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  const read = (attachment) => {
    gl.readBuffer(attachment);
    const pixels = new Uint8Array(size * size * 4);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  };
  return { albedo: read(gl.COLOR_ATTACHMENT0), orm: read(gl.COLOR_ATTACHMENT1) };
}

/// Mean of an RGBA read-back, per channel, in the units it was written in.
export function meanRgb(pixels) {
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    r += pixels[i];
    g += pixels[i + 1];
    b += pixels[i + 2];
  }
  const n = pixels.length / 4;
  return [r / n, g / n, b / n];
}

export { MAX_LAYERS, MAX_BASE_LAYERS };
