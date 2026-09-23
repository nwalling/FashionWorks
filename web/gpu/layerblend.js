// The LayerBlend_V2 shader, on the GPU.
//
// `tint.compose_layered` bakes this on the CPU into a 1024x1024 albedo and a
// packed ORM, about half an hour and 21 GB of cache for the catalogue. In the
// browser there is nowhere to put 21 GB and no time to spend half an hour, so
// the same rules run per pixel instead. That is not only cheaper: the palette
// becomes a uniform, so a colourway change is a uniform update rather than a
// re-bake, and `uUserTint` is live.
//
// Every rule here was expensive to learn and each is cited where it appears.
// The reference implementation stays `extract/sc_extract/tint.py`; this file
// must agree with it, and `check.html` scores that against the Python's own
// baked PNGs.
//
// Two differences from the bake are deliberate and both are improvements:
//
//   * **Layer textures are sampled continuously**, where the bake downsamples
//     a layer to a quantised tile -- `tile_px = round(size / repeat)` -- and
//     repeats it. At an effective tiling of 144 on a 1024 bake that tile is 7
//     pixels, and reducing a detail texture that far shifts its mean. This is
//     the whole of the residual `composite_diff` reports on 5 of 40
//     submaterials, and it should not be closed by imitating the bake.
//   * **Boundaries between layers are anti-aliased.** The bake picks one
//     layer per texel, which is exact away from an edge and a one-texel
//     staircase along it. Here each channel's crossing is measured against
//     its change across the texel, so an edge texel mixes the two layers by
//     how much of it lies on each side. Everywhere else one layer carries all
//     the weight and only that layer is evaluated, as before.
//
// And one the web port adds for the renderer: with `uFlatDetail` a layer
// contributes its mean colour rather than its tiling texture, which a bake
// cannot resolve anyway, and the ORM's alpha records which layer each texel
// shows so `web/app/src/three/materials.ts` can draw that layer's grain on
// the mesh at screen resolution.

/// Which base layer each of the eight saturated blend-mask colours selects,
/// keyed by `red | green<<1 | blue<<2`.
///
/// **This table took four attempts and three readings are refuted.** The mask
/// is a splat -- a ground layer with blue, green and red lerping over it in
/// that order, highest channel winning -- and the layers are numbered **from
/// the top**, which is the natural reading reversed. See `web/core/src/blend.rs`
/// for the evidence and for the four readings that failed.
export const BLEND_BUCKETS = [3, 0, 1, 0, 2, 0, 1, 0];

/// Up to eight layers per submaterial: 0-3 are the base layers, and 4-7 are the
/// wear layer paired with base layer i-4. 2044 of 2737 submaterials are exactly
/// four and four.
export const MAX_LAYERS = 8;
export const MAX_BASE_LAYERS = 4;

/// A full-screen triangle, so the fragment shader runs once per texel of UV
/// space. In the scene the same fragment code runs on the mesh's own UVs; this
/// vertex stage exists so the harness can bake the identical surface the Python
/// writes to PNG and compare them pixel for pixel.
export const VERTEX = `#version 300 es
out vec2 vUv;
void main() {
  // Three vertices covering the clip cube, no buffers bound.
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2DArray;

in vec2 vUv;

// Albedo is written sRGB-encoded, matching the PNG the bake writes and what a
// three.js base-colour map expects. ORM is linear: occlusion, roughness,
// metalness, in that order, which is the glTF packing.
layout(location = 0) out vec4 oAlbedo;
layout(location = 1) out vec4 oOrm;

// --- the submaterial's own control maps ------------------------------------
// One blend mask serves every submaterial of a piece; wear and hal likewise.
uniform sampler2D uBlend;
uniform sampler2D uWear;
uniform sampler2D uHal;
uniform bool uHasBlend;
uniform bool uHasWear;
uniform bool uHasHal;

// --- the layer library, as texture arrays ----------------------------------
// A submaterial samples up to 8 layers x (diffuse + gloss) plus blend, wear and
// hal: 19 textures, against the 16 per-fragment units WebGL2 guarantees.
// Packing the library into arrays brings it to five samplers regardless of how
// many layers the submaterial declares.
uniform sampler2DArray uDiffuse;
uniform sampler2DArray uGloss;

// **Flat detail.** When set, a layer's diffuse texture contributes only its
// linear mean colour, and the tiling grain is left for the renderer to draw on
// the mesh at screen resolution.
//
// Sampling the grain into a 1024 bake cannot work: at an effective tiling of
// 144 one repeat is seven texels, far below what a texture can hold, and
// without a mip chain the sampler aliased it into moire -- the Defiance
// Sunchaser's padding came out as coarse grey diagonal stripes where the game
// shows a solid colour with a fine weave on it. A mean is exactly what a
// correctly filtered sample of that grain converges to, so the bake keeps its
// colour and loses nothing it could have held.
uniform bool uFlatDetail;
uniform vec3 uLayerMean[8];

// **One atlas per piece.** Every submaterial of a mesh shares its UV space,
// so instead of a full-size bake each, one target is shared and each pass
// writes only the texels its own triangles own. uOwner is that map.
uniform sampler2D uOwner;
uniform bool uHasOwner;
uniform int uOwnerId;

// --- the palette, live ------------------------------------------------------
// Three entries, each carrying a tint colour, a specular colour and a
// glossiness. Uniforms rather than baked constants: this is what makes a
// colourway change free.
uniform vec3 uPaletteColor[3];
uniform vec3 uPaletteSpec[3];
uniform float uPaletteGloss[3];

// --- per layer --------------------------------------------------------------
// rgb: the layer reference's own TintColor, linear, from the armour .mtl.
// a:   PaletteTint, 0 for "the artist already chose this colour" and 1-3 for a
//      palette entry. 17332 of 19981 armour layers are 0 -- 87% -- which is why
//      painting every layer with the palette was the original colour bug.
uniform vec4 uLayerTint[8];
// rgb: the layer material's own response -- its Specular for a metal, its
//      Diffuse for a dielectric, resolved when the library is built because
//      both are material constants. 168 of 317 dielectric layers set Diffuse
//      to something other than white, so ignoring it rendered them at full
//      brightness.
// a:   metalness, 0 or 1. Decided by PublicParams TintMode where the material
//      states one (mode 2 metal, mode 1 not) and by the layer's own reflectance
//      otherwise -- never by the directory it lives in, which misses the whole
//      metallic/ category and promotes the 24% of metal/ that is dielectric by
//      its own numbers.
uniform vec4 uLayerResponse[8];
// x: slice in uDiffuse, or -1 for a layer with no diffuse texture.
// y: slice in uGloss, or -1. A metal layer routinely ships only a _ddna.
// z: effective tiling, the layer reference's UVTiling times the layer
//    material's own TexMod.
// w: the mean of that diffuse slice in linear space, for the metal
//    normalisation below.
uniform vec4 uLayerTex[8];
// x: the layer material's Shininess, 0-1. y: the layer reference's GlossMult.
uniform vec2 uLayerGlossParams[8];

// Which layer (4-7) each base layer wears through to, or -1. 2744 of 9436
// pairs point the wear entry back at the base material, which is the artist
// disabling wear; those arrive here as -1 rather than as a lerp of a material
// with itself.
uniform float uWearPair[4];

uniform int uLayerCount;
uniform float uWearThreshold;
uniform float uWearFalloff;
// The viewer's wear toggle. 0 bakes the piece as it left the factory: 85% of
// submaterials have at least one live wear pair, so this is a visibly
// different surface across most of the catalogue.
uniform float uWearAmount;
// An explicit user tint, multiplied at the end. This is the only flat colour
// multiply left; tinting the whole albedo by a palette entry repainted the 87%
// of layers the artist never palette-tinted.
uniform vec3 uUserTint;

const int BLEND_BUCKETS[8] = int[8](3, 0, 1, 0, 2, 0, 1, 0);

float srgbToLinear(float c) {
  return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);
}

vec3 srgbToLinear(vec3 c) {
  return vec3(srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b));
}

float linearToSrgb(float c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

vec3 linearToSrgb(vec3 c) {
  return vec3(linearToSrgb(c.r), linearToSrgb(c.g), linearToSrgb(c.b));
}

/// One layer's linear colour, roughness and metalness at this texel.
void evaluateLayer(int i, vec2 uv, out vec3 colour, out float rough, out float metal) {
  vec4 tintRow = uLayerTint[i];
  vec4 response = uLayerResponse[i];
  vec4 tex = uLayerTex[i];
  vec2 glossParams = uLayerGlossParams[i];

  // Metalness has to be settled before the palette is read, because it decides
  // *which* of the palette entry's two colours applies.
  metal = response.a;

  vec3 tint = tintRow.rgb;
  float glossScale = 1.0;
  int index = int(tintRow.a + 0.5);
  if (index > 0 && index <= 3) {
    // A palette entry carries two colours and the visible one depends on the
    // layer. A metal has no diffuse albedo -- its appearance *is* its F0 -- so
    // a metal layer takes the entry's specular and its tint colour says
    // nothing. The Lynx arms and Oracle helmets put all four base layers on
    // iron_scratched_* with TintColor white, so their entire colourway lives in
    // the palette specular; reading the tint colour rendered ten Lynx
    // colourways as the same grey arm.
    vec3 source = metal > 0.5 ? uPaletteSpec[index - 1] : uPaletteColor[index - 1];
    // The palette *modulates* the layer's own TintColor, it does not replace
    // it. 966 of 1984 palette-tinted base layers carry a non-white one, median
    // 0.50, so substituting rendered half of them up to twice as bright as the
    // game.
    tint = srgbToLinear(source) * tintRow.rgb;
    glossScale = clamp(uPaletteGloss[index - 1], 0.05, 1.0);
  }
  tint *= response.rgb;

  colour = tint;
  if (tex.x >= 0.0) {
    vec3 linear = uFlatDetail
      ? uLayerMean[i]
      : srgbToLinear(texture(uDiffuse, vec3(uv * tex.z, tex.x)).rgb);
    if (metal > 0.5) {
      // A metal's colour is its F0, already in tint. TexSlot1 is brushed or
      // scratched surface pattern, not albedo -- these layers set their
      // material Diffuse to black, CryEngine's own signature for metal, so
      // there is no diffuse term for the texture to be. Multiplying it in raw
      // scales reflectance down by the texture's own mean: on anodized_black
      // that took a sleeve the artist tinted (189,189,189) to sRGB 50.
      // Normalising makes it modulate around 1.0, keeping the detail without
      // the darkening.
      linear /= max(tex.w, 1e-4);
    }
    colour = linear * tint;
  }

  // Per-pixel gloss lives in the layer's _ddna alpha, which the DDS-to-PNG
  // conversion drops -- a converted _ddna comes out with a constant-255 alpha,
  // which looks like "this texture has no gloss". It is decoded separately.
  float gloss = glossParams.x * glossParams.y * glossScale;
  if (tex.y >= 0.0) {
    gloss = texture(uGloss, vec3(uv * tex.z, tex.y)).r * glossParams.y * glossScale;
  }
  rough = clamp(1.0 - gloss, 0.04, 1.0);
}

void main() {
  vec2 uv = vUv;
  if (uHasOwner && int(texture(uOwner, uv).r * 255.0 + 0.5) != uOwnerId) discard;

  // The mask is a hard-edged selector, not a gradient: four saturated colours
  // cover 96% of a real armour mask, and one channel cannot express a weight
  // for four layers. It is nonetheless sampled *bilinearly* and thresholded
  // afterwards, which sounds backwards -- interpolating a selector seems to
  // invent indices between two saturated colours -- but the bake resizes the
  // mask bilinearly and then thresholds, so the interpolation precedes the
  // selection. Sampling nearest disagrees along every boundary between layers.
  // **Weighted, not picked, at an edge.** The mask is a splat -- ground, then
  // blue, green and red lerped over it in that order -- and away from an edge
  // every weight is 0 or 1, which is exactly the table above. A hard threshold
  // per texel, though, turns every boundary into a staircase one bake texel
  // tall, which zoomed in reads as pixelated paint. Measuring each channel's
  // crossing against its own change across the texel (fwidth) gives the
  // fraction of the texel on each side, so the boundary is anti-aliased at the
  // bake's resolution and nothing else moves.
  float weights[4] = float[4](1.0, 0.0, 0.0, 0.0);
  if (uHasBlend) {
    vec3 m = texture(uBlend, uv).rgb;
    vec3 cover = clamp((m - 0.5) / max(fwidth(m), vec3(1e-4)) + 0.5, 0.0, 1.0);
    float wr = cover.r;
    float wg = cover.g * (1.0 - wr);
    float wb = cover.b * (1.0 - cover.g) * (1.0 - wr);
    float ground = (1.0 - cover.b) * (1.0 - cover.g) * (1.0 - wr);
    weights = float[4](wr, wg, wb, ground);
    // Never point at a layer this submaterial does not declare: a missing
    // layer's share goes to the last one it does.
    for (int k = 3; k > 0; k -= 1) {
      if (k >= uLayerCount) {
        weights[uLayerCount - 1] += weights[k];
        weights[k] = 0.0;
      }
    }
  }

  // How far this texel has worn through. The mask is a single BC4 channel --
  // one scalar, so it cannot choose between four layers, only say how much; the
  // layer comes from the pairing. Dark is worn: hard-surface masks average
  // 0.72-0.90, and armour is mostly intact paint with scuffed patches rather
  // than mostly bare metal, so the bright majority is the unworn side.
  float worn = 0.0;
  if (uHasWear) {
    worn = clamp((uWearThreshold - texture(uWear, uv).r) / uWearFalloff, 0.0, 1.0) * uWearAmount;
  }

  vec3 colour = vec3(0.0);
  float rough = 0.0;
  float metal = 0.0;
  float strongest = -1.0;
  // Which layer the renderer should draw grain from here: the dominant base
  // layer, or its wear partner where the surface has worn more than half way.
  float slot = 0.0;
  for (int k = 0; k < 4; k += 1) {
    float w = weights[k];
    if (w <= 0.0) continue;
    vec3 layerColour;
    float layerRough;
    float layerMetal;
    evaluateLayer(k, uv, layerColour, layerRough, layerMetal);
    // Wear happens *within* a layer, before the mask picks between them: a
    // layer worn through shows its own paired material, not its neighbour's.
    float pair = uWearPair[k];
    if (pair >= 0.0 && worn > 0.0) {
      vec3 wornColour;
      float wornRough;
      float wornMetal;
      evaluateLayer(int(pair + 0.5), uv, wornColour, wornRough, wornMetal);
      layerColour = mix(layerColour, wornColour, worn);
      layerRough = mix(layerRough, wornRough, worn);
      layerMetal = mix(layerMetal, wornMetal, worn);
    }
    colour += layerColour * w;
    rough += layerRough * w;
    metal += layerMetal * w;
    if (w > strongest) {
      strongest = w;
      slot = (pair >= 0.0 && worn > 0.5) ? pair : float(k);
    }
  }

  // Occlusion from the _hal map. The shader flag %HUE_AO_LUMINANCE_MAP and the
  // engine's own layerblendHueLUT.dds confirm the name: Hue / AO / Luminance,
  // and green is the channel carrying data -- red and blue sit at a neutral
  // 126. Mapped into 0.35-1.0 so a wrong reading is a mild darkening rather
  // than a black suit.
  float ao = 1.0;
  if (uHasHal) {
    ao = clamp(0.35 + 0.65 * texture(uHal, uv).g, 0.0, 1.0);
  }

  // Decals (TexSlot9) are deliberately absent, though 5599 of 11436 layer-blend
  // submaterials declare one. The sheet is authored against a second UV
  // channel, the mesh reaches us with exactly one, and sampling it on UV0
  // renders metre-high "WARNING" across the chest. That was implemented,
  // rendered and reverted. The Detail map is absent for a different reason:
  // DetailDiffuse and friends appear on 475 of 495 layer materials as template
  // defaults, and TexSlot7 binds a texture on exactly one of them, so with
  // nothing bound the parameters do nothing.

  oAlbedo = vec4(linearToSrgb(max(colour * uUserTint, 0.0)), 1.0);
  // Alpha carries the layer slot, 0-7, for the renderer's detail pass.
  oOrm = vec4(ao, rough, metal, slot / 7.0);
}
`;

/// Names of every uniform the fragment stage declares, so the harness and the
/// viewer look them up once rather than per draw.
export const UNIFORM_NAMES = [
  'uBlend', 'uWear', 'uHal', 'uHasBlend', 'uHasWear', 'uHasHal',
  'uDiffuse', 'uGloss',
  'uPaletteColor', 'uPaletteSpec', 'uPaletteGloss',
  'uLayerTint', 'uLayerResponse', 'uLayerTex', 'uLayerGlossParams',
  'uWearPair', 'uLayerCount', 'uWearThreshold', 'uWearFalloff', 'uWearAmount',
  'uUserTint', 'uFlatDetail', 'uLayerMean', 'uOwner', 'uHasOwner', 'uOwnerId',
];

/// The blend table, in JavaScript, for anything that needs to reason about a
/// mask outside the shader.
export function layerFor(r, g, b) {
  const bucket = (r > 127 ? 1 : 0) | (g > 127 ? 2 : 0) | (b > 127 ? 4 : 0);
  return BLEND_BUCKETS[bucket];
}

export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/// Pack a submaterial's layer stack into the flat arrays the uniforms take.
///
/// `layers` is up to four base layers, each optionally carrying a `worn`
/// pairing. The packing puts base layer i at slot i and its wear layer at slot
/// i+4, which is what `uWearPair` indexes.
export function packLayers(layers) {
  const tint = new Float32Array(MAX_LAYERS * 4);
  const response = new Float32Array(MAX_LAYERS * 4);
  const tex = new Float32Array(MAX_LAYERS * 4);
  const glossParams = new Float32Array(MAX_LAYERS * 2);
  const wearPair = new Float32Array(MAX_BASE_LAYERS).fill(-1);
  const mean = new Float32Array(MAX_LAYERS * 3).fill(1);

  const put = (slot, layer) => {
    tint.set([layer.tint[0], layer.tint[1], layer.tint[2], layer.paletteTint ?? 0], slot * 4);
    response.set(
      [layer.response[0], layer.response[1], layer.response[2], layer.metal ? 1 : 0],
      slot * 4,
    );
    tex.set(
      [layer.diffuseSlice ?? -1, layer.glossSlice ?? -1, layer.tiling ?? 1, layer.diffuseMean ?? 1],
      slot * 4,
    );
    glossParams.set([layer.shininess ?? 0.5, layer.glossMult ?? 1], slot * 2);
    if (layer.meanRgb) mean.set(layer.meanRgb, slot * 3);
  };

  layers.slice(0, MAX_BASE_LAYERS).forEach((layer, i) => {
    put(i, layer);
    if (layer.worn) {
      put(i + MAX_BASE_LAYERS, layer.worn);
      wearPair[i] = i + MAX_BASE_LAYERS;
    }
  });

  return {
    tint, response, tex, glossParams, wearPair, mean,
    count: Math.min(layers.length, MAX_BASE_LAYERS),
  };
}
