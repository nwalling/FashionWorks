//! Measuring how much of a surface is the armour's accent colour.
//!
//! This is the measure the blend table was settled on, and it is the one WEB.md
//! phase 3 re-runs: *Sunchaser torso 36.0% and upper back 33.0% gold against
//! CIG's store renders.* Two rules from `CLAUDE.md` govern how it is taken, and
//! both were learned by getting them wrong:
//!
//! * **Compare contrast, not absolute luminance.** Two in-game captures of the
//!   same armour disagree on brightness because their scenes differ -- the
//!   Sunchaser non-gold median reads 32.7 on one sheet and 42.3 on the store
//!   render. The lighting-invariant measure is the ratio of the gold median to
//!   the non-gold median *within one image*.
//! * **Measure against a real silhouette.** Masking the body by "brighter than
//!   the backdrop" counts the backdrop and reported 4% gold over 442k pixels
//!   where the truth was 17.5% over 105k.
//!
//! A third applies to this file specifically. **An atlas fraction is not a
//! silhouette fraction**: it counts unused UV space, and the Sunchaser arms
//! read 7.7% of their atlas against 3% of their silhouette. So the figures here
//! are used two ways and only two ways -- to compare the port against the bake
//! on identical input, which is exact, and to compare *ratios* between them.
//! Comparing an atlas percentage to a store render's percentage directly is the
//! mistake this comment exists to prevent.

/// Hue band, in degrees, for the Sunchaser gold. Its median is (190, 136, 49),
/// which sits at hue 37, saturation 0.74, value 0.75.
pub const GOLD_HUE: (f32, f32) = (30.0, 55.0);
/// Below this saturation a pixel is one of the greys the armour is mostly made
/// of, whatever its hue reads as. Dark paint has an unstable hue.
pub const GOLD_MIN_SATURATION: f32 = 0.35;
/// Below this value the hue is noise.
pub const GOLD_MIN_VALUE: f32 = 0.20;

/// Hue in degrees, saturation and value, each 0-1 except the hue.
pub fn hsv(rgb: [f32; 3]) -> (f32, f32, f32) {
    let (r, g, b) = (rgb[0] / 255.0, rgb[1] / 255.0, rgb[2] / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let delta = max - min;
    let hue = if delta <= f32::EPSILON {
        0.0
    } else if max == r {
        60.0 * (((g - b) / delta) % 6.0)
    } else if max == g {
        60.0 * ((b - r) / delta + 2.0)
    } else {
        60.0 * ((r - g) / delta + 4.0)
    };
    let hue = if hue < 0.0 { hue + 360.0 } else { hue };
    let saturation = if max <= f32::EPSILON { 0.0 } else { delta / max };
    (hue, saturation, max)
}

pub fn is_gold(rgb: [f32; 3]) -> bool {
    let (h, s, v) = hsv(rgb);
    h >= GOLD_HUE.0 && h <= GOLD_HUE.1 && s >= GOLD_MIN_SATURATION && v >= GOLD_MIN_VALUE
}

fn luminance(rgb: [f32; 3]) -> f32 {
    0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
}

fn median(values: &mut Vec<f32>) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    values[values.len() / 2]
}

/// How close to a band boundary a texel may sit before its membership is
/// decided by noise rather than by colour.
pub const EDGE_HUE: f32 = 2.0;
pub const EDGE_SATURATION: f32 = 0.02;

/// A texel whose band membership a sub-unit colour difference could flip.
pub fn on_the_edge(rgb: [f32; 3]) -> bool {
    let (h, s, v) = hsv(rgb);
    if v < GOLD_MIN_VALUE {
        return false;
    }
    let near_hue = (h - GOLD_HUE.0).abs() <= EDGE_HUE || (h - GOLD_HUE.1).abs() <= EDGE_HUE;
    let near_saturation = (s - GOLD_MIN_SATURATION).abs() <= EDGE_SATURATION;
    // Only counts where the other axis would admit it.
    (near_hue && s >= GOLD_MIN_SATURATION - EDGE_SATURATION)
        || (near_saturation && h >= GOLD_HUE.0 - EDGE_HUE && h <= GOLD_HUE.1 + EDGE_HUE)
}

/// What one surface reads as.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Reading {
    /// Fraction of texels in the gold band.
    pub gold: f32,
    /// Median luminance of the gold texels, and of everything else.
    pub gold_median: f32,
    pub other_median: f32,
    pub texels: usize,
    /// Fraction of texels sitting on a band boundary.
    ///
    /// Where this is large the coverage figure is **not a measurement of the
    /// compositing rules**, because a sub-unit colour difference moves whole
    /// regions across the boundary at once. The Ana set is the case: its accent
    /// has a median hue of exactly 30.0 against a band starting at 30, and 31%
    /// of one atlas sits in a single uniform region right there, so the port
    /// and the bake differ by 9.4 coverage points while their mean albedo
    /// agrees to under 3 sRGB units. The band was defined for the Sunchaser
    /// gold at hue 37; nothing says it discriminates for an unrelated family.
    pub edge: f32,
}

impl Reading {
    /// Gold median over non-gold median: the lighting-invariant figure.
    ///
    /// The reference band is 2.95 to 3.47 across CIG's two captures of the same
    /// set; the viewer read 2.33-2.55 before the blend-table fix and 3.81 after.
    pub fn contrast(&self) -> f32 {
        if self.other_median <= f32::EPSILON {
            return 0.0;
        }
        self.gold_median / self.other_median
    }
}

/// Accumulates texels across several surfaces before taking one reading.
///
/// **A whole-piece contrast is not the mean of its submaterials' contrasts,**
/// and reading it that way is the trap this type exists to close. A render
/// measures gold against everything else *in one image*, pooling every material
/// the piece wears. A single submaterial's ratio compares its gold against its
/// own non-gold, which for a mostly-dark bracket with a gold edge is a
/// different and much lower number: the Sunchaser's eight gold-bearing
/// materials read 0.78 to 3.50 individually, and averaging those says nothing
/// about what the piece looks like. Pooled, the same piece lands in the
/// reference band.
///
/// What pooling atlas texels still cannot fix is that an atlas weights each
/// material by its UV area rather than its surface area. That is why coverage
/// is only ever compared port-to-bake, and only the ratio is held against the
/// reference.
#[derive(Default)]
pub struct Pool {
    gold: Vec<f32>,
    other: Vec<f32>,
    edge: usize,
}

impl Pool {
    pub fn add(&mut self, rgb: &[f32]) {
        for texel in rgb.chunks_exact(3) {
            let sample = [texel[0], texel[1], texel[2]];
            if on_the_edge(sample) {
                self.edge += 1;
            }
            if is_gold(sample) {
                self.gold.push(luminance(sample));
            } else {
                self.other.push(luminance(sample));
            }
        }
    }

    pub fn finish(mut self) -> Reading {
        let texels = self.gold.len() + self.other.len();
        let edge = self.edge;
        Reading {
            gold: if texels == 0 {
                0.0
            } else {
                self.gold.len() as f32 / texels as f32
            },
            gold_median: median(&mut self.gold),
            other_median: median(&mut self.other),
            texels,
            edge: if texels == 0 { 0.0 } else { edge as f32 / texels as f32 },
        }
    }
}

/// Measure one sRGB image. `rgb` is row-major, three samples per texel.
pub fn measure(rgb: &[f32]) -> Reading {
    let mut pool = Pool::default();
    pool.add(rgb);
    pool.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sunchaser_gold_is_in_the_band() {
        // (190, 136, 49) is the median gold measured off CIG's store renders.
        assert!(is_gold([190.0, 136.0, 49.0]));
    }

    #[test]
    fn grey_armour_is_not_gold_however_warm() {
        // The non-gold body is where a loose band does damage: a warm grey has
        // the right hue and must still be excluded on saturation.
        assert!(!is_gold([90.0, 86.0, 80.0]), "warm grey");
        assert!(!is_gold([42.0, 42.0, 42.0]), "charcoal");
        assert!(!is_gold([20.0, 15.0, 6.0]), "gold hue but too dark to read");
    }

    #[test]
    fn a_red_or_green_accent_is_not_gold() {
        // The Chiron legs question turned on a bright red, #ea2d40.
        assert!(!is_gold([234.0, 45.0, 64.0]), "red");
        assert!(!is_gold([10.0, 146.0, 28.0]), "green");
    }

    #[test]
    fn a_surface_on_the_band_boundary_is_flagged() {
        // The Ana accent: hue exactly 30.0, the band's lower edge. Its
        // coverage is decided by noise, so the reading says so rather than
        // reporting a number the rules did not produce.
        let on_edge = hsv([200.0, 150.0, 100.0]);
        assert!((on_edge.0 - 30.0).abs() < 0.5, "hue is {}", on_edge.0);
        assert!(on_the_edge([200.0, 150.0, 100.0]), "sits on the hue boundary");
        // The Sunchaser gold is at hue 37, comfortably inside.
        assert!(!on_the_edge([190.0, 136.0, 49.0]), "hue 37 is not an edge case");
    }

    #[test]
    fn the_fraction_counts_texels_not_samples() {
        // Two gold texels and two grey ones.
        let image = vec![
            190.0, 136.0, 49.0, 190.0, 136.0, 49.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0,
        ];
        let reading = measure(&image);
        assert_eq!(reading.texels, 4);
        assert!((reading.gold - 0.5).abs() < 1e-6, "got {}", reading.gold);
    }

    #[test]
    fn contrast_is_a_ratio_of_medians() {
        let image = vec![190.0, 136.0, 49.0, 30.0, 30.0, 30.0];
        let reading = measure(&image);
        // Gold luminance is about 140, grey is 30.
        assert!(reading.contrast() > 4.0, "got {}", reading.contrast());
    }

    #[test]
    fn pooling_is_not_the_mean_of_the_parts() {
        // Two submaterials: one mostly gold, one a dark plate with a gold edge.
        // Individually the second reads a high ratio against its own darkness;
        // pooled, its darkness is part of the piece's non-gold and the piece's
        // ratio falls between them rather than averaging them.
        let mostly_gold = vec![190.0, 136.0, 49.0, 190.0, 136.0, 49.0, 90.0, 90.0, 90.0];
        let dark_plate = vec![190.0, 136.0, 49.0, 12.0, 12.0, 12.0, 12.0, 12.0, 12.0];

        let a = measure(&mostly_gold).contrast();
        let b = measure(&dark_plate).contrast();

        let mut pool = Pool::default();
        pool.add(&mostly_gold);
        pool.add(&dark_plate);
        let pooled = pool.finish();

        assert!(b > a, "the dark plate reads higher on its own: {b} vs {a}");
        assert!(
            (pooled.contrast() - (a + b) / 2.0).abs() > 0.5,
            "pooled {} must not be the mean of {a} and {b}",
            pooled.contrast()
        );
        // Pooling is area-weighted, so the piece's non-gold median follows
        // whichever surface contributes more texels rather than splitting the
        // difference. That is the behaviour a render has and an average of
        // per-material ratios does not.
        assert!((pooled.gold - 0.5).abs() < 1e-6, "three gold texels of six");
    }

    #[test]
    fn an_all_grey_surface_reads_no_gold_and_no_contrast() {
        let image = vec![60.0, 60.0, 60.0, 61.0, 61.0, 61.0];
        let reading = measure(&image);
        assert_eq!(reading.gold, 0.0);
        assert_eq!(reading.contrast(), 0.0, "no gold texels means no ratio");
    }
}
