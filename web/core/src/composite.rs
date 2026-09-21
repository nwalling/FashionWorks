//! Compositing a LayerBlend_V2 submaterial's albedo.
//!
//! Armour ships **no albedo texture**. The shader composites up to four base
//! layers through a blend mask, each layer worn through to a paired layer by a
//! wear mask, and the colours come from the tint palette. This is that, on
//! decoded buffers, so the same code serves a CPU check here and a shader's
//! reference implementation later.
//!
//! Deliberately *not* here:
//!
//! * **Decals (TexSlot9).** Declared by 5599 of 11436 layer-blend
//!   submaterials, and not placeable: the sheet is authored against a second UV
//!   channel, the mesh reaches us with one, and sampling it on UV0 renders
//!   metre-high "WARNING" across the chest. That was tried and reverted.
//! * **The Detail map.** `DetailDiffuse` and friends appear on 475 of 495 layer
//!   materials as template defaults -- 458 at exactly 0.5 -- and **no detail
//!   texture is bound**: TexSlot7 appears on one layer material in 495. With no
//!   texture the parameters do nothing.
//!
//! Ambient occlusion is computed but belongs in the ORM's red channel, not the
//! albedo, so [`Composite::albedo_mean`] excludes it.

use crate::blend;

/// A decoded, tiling texture.
pub struct Texture {
    pub width: usize,
    pub height: usize,
    /// Row-major RGB, 8 bits per channel.
    pub rgb: Vec<u8>,
}

impl Texture {
    /// Sample at normalised `(u, v)`, wrapping, nearest-neighbour.
    pub fn sample(&self, u: f32, v: f32) -> [u8; 3] {
        if self.width == 0 || self.height == 0 {
            return [0, 0, 0];
        }
        let x = ((u.rem_euclid(1.0)) * self.width as f32) as usize % self.width;
        let y = ((v.rem_euclid(1.0)) * self.height as f32) as usize % self.height;
        let i = (y * self.width + x) * 3;
        [self.rgb[i], self.rgb[i + 1], self.rgb[i + 2]]
    }
}

impl Texture {
    /// Bilinear sample, wrapping.
    ///
    /// The blend mask uses this and **not** nearest, which is worth stating
    /// because the opposite sounds more reasonable: the mask is a selector, so
    /// interpolating it seems to invent colours between two saturated ones. But
    /// the pipeline resizes the mask bilinearly to the bake resolution and
    /// *then* thresholds each channel at half, so the interpolation happens
    /// before the selection, and a port that samples nearest disagrees along
    /// every boundary between two layers.
    pub fn sample_bilinear(&self, u: f32, v: f32) -> [u8; 3] {
        if self.width == 0 || self.height == 0 {
            return [0, 0, 0];
        }
        let fx = u.rem_euclid(1.0) * self.width as f32 - 0.5;
        let fy = v.rem_euclid(1.0) * self.height as f32 - 0.5;
        let x0 = fx.floor();
        let y0 = fy.floor();
        let tx = fx - x0;
        let ty = fy - y0;
        let wrap = |v: f32, n: usize| ((v as i64).rem_euclid(n as i64)) as usize;
        let (x0i, y0i) = (wrap(x0, self.width), wrap(y0, self.height));
        let (x1i, y1i) = (wrap(x0 + 1.0, self.width), wrap(y0 + 1.0, self.height));
        let at = |x: usize, y: usize, c: usize| self.rgb[(y * self.width + x) * 3 + c] as f32;
        let mut out = [0u8; 3];
        for c in 0..3 {
            let top = at(x0i, y0i, c) * (1.0 - tx) + at(x1i, y0i, c) * tx;
            let bottom = at(x0i, y1i, c) * (1.0 - tx) + at(x1i, y1i, c) * tx;
            out[c] = (top * (1.0 - ty) + bottom * ty).round().clamp(0.0, 255.0) as u8;
        }
        out
    }
}

/// One base layer's resolved response, before the mask picks between them.
pub struct Layer {
    /// Linear colour from the palette and the layer's own TintColor.
    pub tint: [f32; 3],
    /// The layer's TexSlot1, if it has one.
    pub diffuse: Option<Texture>,
    /// A metal's texture is pattern, not albedo, and is normalised to its mean.
    pub metallic: bool,
    pub uv_tiling: f32,
    /// What this layer looks like worn through, when wear is enabled for it.
    pub worn: Option<Box<Layer>>,
}

pub fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

pub fn linear_to_srgb(c: f32) -> f32 {
    if c <= 0.0031308 { c * 12.92 } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 }
}

/// Mean of a texture's linear values, for the metal normalisation.
fn linear_mean(texture: &Texture) -> f32 {
    if texture.rgb.is_empty() {
        return 1.0;
    }
    let sum: f64 = texture
        .rgb
        .iter()
        .map(|&c| srgb_to_linear(c as f32 / 255.0) as f64)
        .sum();
    (sum / texture.rgb.len() as f64) as f32
}

impl Layer {
    /// This layer's linear colour at `(u, v)`.
    fn colour_at(&self, u: f32, v: f32, mean: f32) -> [f32; 3] {
        let Some(texture) = &self.diffuse else { return self.tint };
        let sample = texture.sample(u * self.uv_tiling, v * self.uv_tiling);
        let mut out = [0.0f32; 3];
        for i in 0..3 {
            let mut linear = srgb_to_linear(sample[i] as f32 / 255.0);
            if self.metallic {
                // A metal's colour is its F0, already in `tint`. TexSlot1 is
                // brushed or scratched surface pattern, and these layers set
                // their Diffuse constant to black -- CryEngine's signature for
                // metal -- so there is no diffuse term for the texture to be.
                // Multiplying it in raw scales reflectance down by its own
                // mean: on anodized_black that took a sleeve the artist tinted
                // (189,189,189) to sRGB 50. Normalising keeps the detail
                // without the darkening.
                linear /= mean.max(1e-4);
            }
            out[i] = linear * self.tint[i];
        }
        out
    }
}

/// The composited albedo's mean, in sRGB 0-255, which is what the phase 3 exit
/// criterion compares.
pub struct Composite<'a> {
    pub layers: &'a [Layer],
    pub blend: &'a Texture,
    /// Single-channel wear mask, if the material has one.
    pub wear: Option<&'a Texture>,
    pub wear_threshold: f32,
    pub wear_falloff: f32,
}

impl Composite<'_> {
    /// The composited albedo's mean, in sRGB 0-255.
    ///
    /// Summed in `f64` from the unquantised values, where the Python writes
    /// `astype(np.uint8)` and so truncates. That costs the bake **0.575 sRGB
    /// units** of mean brightness, measured over two million samples, and it is
    /// the single largest term in the residual either port shows against it --
    /// so the difference is the bake's, not the port's.
    pub fn albedo_mean(&self, size: usize) -> [f32; 3] {
        let image = self.albedo(size);
        let mut total = [0.0f64; 3];
        for texel in image.chunks_exact(3) {
            for i in 0..3 {
                total[i] += f64::from(texel[i]);
            }
        }
        let n = (size * size) as f64;
        [
            (total[0] / n) as f32,
            (total[1] / n) as f32,
            (total[2] / n) as f32,
        ]
    }

    /// Fraction of the surface that composites as metal.
    ///
    /// The bake packs metalness into the ORM's blue channel and the audit reads
    /// it back with a `> 127.5` threshold, so the same half-way test is used
    /// here. This is what `cloth_reads_metal` is measured on: the Beacon
    /// undersuit shipped at 58.9% metallic on its jumpsuit because an earlier
    /// blend table sent the body of the garment to `anodized_black`.
    pub fn metal_fraction(&self, size: usize) -> f32 {
        let mut metal = 0usize;
        for y in 0..size {
            let v = (y as f32 + 0.5) / size as f32;
            for x in 0..size {
                let u = (x as f32 + 0.5) / size as f32;
                let index =
                    blend::layer_for(self.blend.sample_bilinear(u, v)).min(self.layers.len() - 1);
                let layer = &self.layers[index];
                let mut value = if layer.metallic { 1.0f32 } else { 0.0 };
                // Wear blends metalness the same way it blends colour, which is
                // how paint worn through to bare metal reads as metal.
                if let (Some(worn), Some(mask)) = (&layer.worn, self.wear) {
                    let m = mask.sample_bilinear(u, v)[0] as f32 / 255.0;
                    let amount = ((self.wear_threshold - m) / self.wear_falloff).clamp(0.0, 1.0);
                    let worn_value = if worn.metallic { 1.0f32 } else { 0.0 };
                    value += (worn_value - value) * amount;
                }
                if value > 0.5 {
                    metal += 1;
                }
            }
        }
        metal as f32 / (size * size) as f32
    }

    /// The composited albedo as an sRGB image, row-major RGB.
    pub fn albedo(&self, size: usize) -> Vec<f32> {
        // Precompute each layer's texture mean once; it is over the whole
        // image and does not vary per pixel.
        let means: Vec<f32> = self
            .layers
            .iter()
            .map(|l| l.diffuse.as_ref().map_or(1.0, linear_mean))
            .collect();
        let worn_means: Vec<f32> = self
            .layers
            .iter()
            .map(|l| {
                l.worn
                    .as_ref()
                    .and_then(|w| w.diffuse.as_ref())
                    .map_or(1.0, linear_mean)
            })
            .collect();

        let mut out = Vec::with_capacity(size * size * 3);
        for y in 0..size {
            let v = (y as f32 + 0.5) / size as f32;
            for x in 0..size {
                let u = (x as f32 + 0.5) / size as f32;
                let index = blend::layer_for(self.blend.sample_bilinear(u, v)).min(self.layers.len() - 1);
                let layer = &self.layers[index];
                let mut colour = layer.colour_at(u, v, means[index]);

                // Wear happens *within* a layer, before the mask picks between
                // them -- a layer worn through shows its own paired material,
                // not its neighbour's. Dark is worn: hard-surface masks average
                // 0.72-0.90 and armour is mostly intact paint with scuffed
                // patches, so the bright majority is the unworn side.
                if let (Some(worn), Some(mask)) = (&layer.worn, self.wear) {
                    let m = mask.sample_bilinear(u, v)[0] as f32 / 255.0;
                    let amount = ((self.wear_threshold - m) / self.wear_falloff).clamp(0.0, 1.0);
                    if amount > 0.0 {
                        let worn_colour = worn.colour_at(u, v, worn_means[index]);
                        for i in 0..3 {
                            colour[i] += (worn_colour[i] - colour[i]) * amount;
                        }
                    }
                }

                for i in 0..3 {
                    out.push(linear_to_srgb(colour[i].max(0.0)) * 255.0);
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(rgb: [u8; 3]) -> Texture {
        Texture { width: 1, height: 1, rgb: rgb.to_vec() }
    }

    fn layer(tint: [f32; 3]) -> Layer {
        Layer { tint, diffuse: None, metallic: false, uv_tiling: 1.0, worn: None }
    }

    #[test]
    fn a_black_mask_selects_the_last_layer_not_the_first() {
        // The refuted first reading put the ground on BaseLayer1.
        let layers = [layer([1.0, 0.0, 0.0]), layer([0.0, 1.0, 0.0]), layer([0.0, 0.0, 1.0]), layer([1.0, 1.0, 1.0])];
        let blend = flat([0, 0, 0]);
        let c = Composite { layers: &layers, blend: &blend, wear: None, wear_threshold: 0.5, wear_falloff: 0.25 };
        let mean = c.albedo_mean(4);
        assert!(mean[0] > 250.0 && mean[2] > 250.0, "white ground layer, got {mean:?}");
    }

    #[test]
    fn a_metal_texture_modulates_around_one_rather_than_darkening() {
        // A mid-grey pattern over a bright F0 must not halve it.
        let tex = Texture { width: 2, height: 1, rgb: vec![128, 128, 128, 128, 128, 128] };
        let metal = Layer { tint: [0.5, 0.5, 0.5], diffuse: Some(tex), metallic: true, uv_tiling: 1.0, worn: None };
        let blend = flat([255, 0, 0]);
        let layers = [metal, layer([0.0; 3]), layer([0.0; 3]), layer([0.0; 3])];
        let c = Composite { layers: &layers, blend: &blend, wear: None, wear_threshold: 0.5, wear_falloff: 0.25 };
        let mean = c.albedo_mean(4);
        let expected = linear_to_srgb(0.5) * 255.0;
        assert!((mean[0] - expected).abs() < 1.0, "got {mean:?}, expected about {expected}");
    }

    #[test]
    fn wear_blends_within_a_layer_towards_its_own_pair() {
        let mut base = layer([1.0, 0.0, 0.0]);
        base.worn = Some(Box::new(layer([0.0, 0.0, 1.0])));
        let layers = [base, layer([0.0; 3]), layer([0.0; 3]), layer([0.0; 3])];
        let blend = flat([255, 0, 0]);
        // A fully dark wear mask is fully worn.
        let wear = flat([0, 0, 0]);
        let c = Composite { layers: &layers, blend: &blend, wear: Some(&wear), wear_threshold: 0.5, wear_falloff: 0.25 };
        let mean = c.albedo_mean(4);
        assert!(mean[2] > 250.0 && mean[0] < 5.0, "should be the worn blue, got {mean:?}");
    }

    #[test]
    fn a_bright_wear_mask_leaves_the_layer_alone() {
        let mut base = layer([1.0, 0.0, 0.0]);
        base.worn = Some(Box::new(layer([0.0, 0.0, 1.0])));
        let layers = [base, layer([0.0; 3]), layer([0.0; 3]), layer([0.0; 3])];
        let blend = flat([255, 0, 0]);
        let wear = flat([255, 255, 255]);
        let c = Composite { layers: &layers, blend: &blend, wear: Some(&wear), wear_threshold: 0.5, wear_falloff: 0.25 };
        let mean = c.albedo_mean(4);
        assert!(mean[0] > 250.0 && mean[2] < 5.0, "should stay unworn red, got {mean:?}");
    }
}
