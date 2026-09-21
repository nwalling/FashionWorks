//! The catalogue invariants, ported to run against the web port's output.
//!
//! WEB.md phase 3's third exit criterion, and the plan's stated mitigation for
//! its largest risk: *the audit invariants (`sc_extract/audit.py`) are ported to
//! run against the web port's output as well.* Each check here exists because
//! it caught a real regression, and each one is a property of a **composited
//! surface** rather than of the manifest -- the manifest-shaped checks
//! (duplicate names, fragments, an item wearing another item's GLB) belong to
//! the catalogue and are already covered by phase 1's field diff.
//!
//! What makes these worth porting rather than trusting: every one of them is
//! visible without a reference image. They do not ask whether a surface looks
//! right, which needs a photograph and a judgement; they ask whether it has
//! failed in one of the specific ways this pipeline has actually failed before.

use crate::gold;

/// One thing that is wrong.
#[derive(Debug, Clone, PartialEq)]
pub struct Finding {
    pub check: &'static str,
    pub subject: String,
    pub detail: String,
}

/// Fabric reading as metal means layer selection is wrong.
///
/// The Beacon undersuit shipped at **58.9% metalness** on its jumpsuit because
/// the blend table then in force sent the body of the garment to an
/// `anodized_black` layer. Cloth is never mostly metal, so this needs no
/// reference to adjudicate.
pub const CLOTH_METAL_LIMIT: f32 = 0.40;

/// Submaterial names that are cloth. Matched case-insensitively as substrings,
/// the way the Python's regex does.
pub const CLOTH_WORDS: [&str; 10] = [
    "undersuit", "jumpsuit", "fabric", "cloth", "nylon", "strap", "cusion", "cushion", "glove",
    "sock",
];

pub fn is_cloth(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    CLOTH_WORDS.iter().any(|w| lower.contains(w))
}

pub fn cloth_reads_metal(item: &str, sub: &str, metal_fraction: f32) -> Option<Finding> {
    if !is_cloth(sub) || metal_fraction <= CLOTH_METAL_LIMIT {
        return None;
    }
    Some(Finding {
        check: "cloth-reads-metal",
        subject: item.to_string(),
        detail: format!("{sub} is {:.0}% metallic", metal_fraction * 100.0),
    })
}

/// A composited surface should not come out saturated pure red.
///
/// 63 of 44,164 armour BaseLayer entries carry a TintColor of pure saturated
/// red, almost all on BaseLayer1, and they are **not albedo**: the value is
/// frozen across colourways while its siblings move, and where the parent
/// submaterial is emissive the material's `Emissive` colour is byte-identical
/// to that layer's tint. Corbel's `arms01_m` is `Emissive="1,0,0.001214108"`
/// against a BaseLayer1 tint of exactly (1, 0, 0.001214108) -- the layer marks
/// *where the glow is* and the emission supplies the colour.
///
/// Composited as albedo they are bright red blotches, up to 80.2% of one QRT
/// core submaterial. The real fix routes them to an emissive output, which
/// needs emissive plumbed through bake, Blender and glTF; until then this keeps
/// the damage visible and sized. The port inherits the same gap, so it inherits
/// the same check.
pub const SENTINEL_RED_LIMIT: f32 = 0.02;

/// The Python's test, kept exactly: bright, and both other channels far below.
pub fn is_sentinel_red(rgb: [f32; 3]) -> bool {
    rgb[0] > 120.0 && rgb[1] < rgb[0] * 0.45 && rgb[2] < rgb[0] * 0.45
}

pub fn red_fraction(rgb: &[f32]) -> f32 {
    let texels = rgb.len() / 3;
    if texels == 0 {
        return 0.0;
    }
    let hot = rgb
        .chunks_exact(3)
        .filter(|t| is_sentinel_red([t[0], t[1], t[2]]))
        .count();
    hot as f32 / texels as f32
}

/// Names that mean a colourway is *supposed* to bake red.
///
/// The first run of the Python's version reported 410 surfaces and led with
/// "ADP Arms Red" and "ADP-mk4 Arms Red Alert", which are correct renders, not
/// markers.
pub const NAMED_RED: [&str; 7] = [
    "red", "crimson", "scarlet", "ruby", "blood", "rust", "maroon",
];

pub fn named_red(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    NAMED_RED
        .iter()
        .any(|w| lower.split(|c: char| !c.is_alphanumeric()).any(|t| t == *w))
}

pub fn sentinel_red_baked(item: &str, sub: &str, rgb: &[f32]) -> Option<Finding> {
    if named_red(item) {
        return None;
    }
    let fraction = red_fraction(rgb);
    if fraction <= SENTINEL_RED_LIMIT {
        return None;
    }
    Some(Finding {
        check: "sentinel-red-baked",
        subject: item.to_string(),
        detail: format!(
            "{sub} is {:.0}% saturated red (emissive marker composited as albedo)",
            fraction * 100.0
        ),
    })
}

/// Colourways of one family must not all composite to the same colour.
///
/// Reading `TintMode=0` as "not tinted" forced 1185 layer references to white
/// and baked 12 of the 28 Venture undersuits to a near-identical (220,220,219).
/// A family collapsing onto one colour is the signature of a tint being
/// discarded, and it needs no reference image to see.
pub const COLOURWAY_SPREAD_MINIMUM: f32 = 6.0;
/// Below this many members the spread is not meaningful.
pub const COLOURWAY_MINIMUM_MEMBERS: usize = 4;

/// Mean distance of each member's mean colour from the family's mean colour.
pub fn colourway_spread(members: &[[f32; 3]]) -> f32 {
    if members.is_empty() {
        return 0.0;
    }
    let mut centre = [0.0f32; 3];
    for m in members {
        for i in 0..3 {
            centre[i] += m[i];
        }
    }
    for c in centre.iter_mut() {
        *c /= members.len() as f32;
    }
    let total: f32 = members
        .iter()
        .map(|m| {
            (0..3)
                .map(|i| (m[i] - centre[i]).powi(2))
                .sum::<f32>()
                .sqrt()
        })
        .sum();
    total / members.len() as f32
}

/// Whether a family of colourways has collapsed onto one colour.
///
/// `per_sub` is one entry per submaterial, each holding that submaterial's mean
/// colour in every colourway of the family.
///
/// **The family fails only when it collapses on *every* submaterial**, and that
/// is a deliberate tightening of the Python's version, which samples whichever
/// submaterial happens to come first. Sweeping all of them instead turned up two
/// families that the per-submaterial test calls collapsed and that are plainly
/// fine: the Defiance helmet's `camera_m` agrees to 5.9 across six colourways
/// while its `coated_metal_m` spreads 44.1, and the Corbel helmet's `helmet02_m`
/// and `helmet03_m` agree to 2.9 and 0.0 while `helmet01_m` spreads 42.7. A
/// camera lens and an interior shell being the same colour on every colourway is
/// the artist's intent, not a discarded tint.
///
/// What the invariant is actually for is the Venture collapse, where all twelve
/// undersuits went flat near-white *together*, on every surface at once. Taking
/// the widest-spreading submaterial as the family's verdict catches that and
/// nothing else.
pub fn colourways_identical(family: &str, per_sub: &[Vec<[f32; 3]>]) -> Option<Finding> {
    let members = per_sub.iter().map(Vec::len).max().unwrap_or(0);
    if members < COLOURWAY_MINIMUM_MEMBERS {
        return None;
    }
    let widest = per_sub
        .iter()
        .filter(|m| m.len() >= COLOURWAY_MINIMUM_MEMBERS)
        .map(|m| colourway_spread(m))
        .fold(0.0f32, f32::max);
    if widest >= COLOURWAY_SPREAD_MINIMUM {
        return None;
    }
    Some(Finding {
        check: "colourways-identical",
        subject: family.to_string(),
        detail: format!(
            "{members} colourways agree to within {widest:.1} on every one of \
             {} submaterials; a tint is being discarded",
            per_sub.len()
        ),
    })
}

/// A surface whose accent colour vanished.
///
/// Narrower than the Python's `named_colour_present`, and deliberately so: that
/// check searches an item's name for one of nineteen colour words, which is a
/// catalogue-level operation. What the port can assert from a composite alone is
/// the case the store-render comparison already anchors -- a piece the
/// reference shows as gold must composite some gold. The Corbel lineup rendered
/// black where the game shows yellow under the third blend table, and that is
/// exactly what this catches.
pub const ACCENT_MINIMUM: f32 = 0.02;

pub fn accent_absent(item: &str, coverage: f32) -> Option<Finding> {
    if coverage >= ACCENT_MINIMUM {
        return None;
    }
    Some(Finding {
        check: "accent-absent",
        subject: item.to_string(),
        detail: format!(
            "{:.1}% of the surface is in the accent band; the reference set shows it plainly",
            coverage * 100.0
        ),
    })
}

/// Convenience: the accent coverage of a composited image.
pub fn accent_coverage(rgb: &[f32]) -> f32 {
    gold::measure(rgb).gold
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_jumpsuit_at_beacon_s_old_metalness_is_caught() {
        // The exact number the Beacon undersuit shipped at.
        let finding = cloth_reads_metal("Beacon Undersuit", "jumpsuit_m", 0.589);
        assert!(finding.is_some());
        assert_eq!(finding.unwrap().check, "cloth-reads-metal");
    }

    #[test]
    fn a_metal_plate_may_be_metal() {
        assert!(cloth_reads_metal("Defiance Core", "core_plate_m", 0.98).is_none());
    }

    #[test]
    fn a_little_metal_in_cloth_is_fine() {
        // Zips, buckles and press studs are real.
        assert!(cloth_reads_metal("Beacon Undersuit", "glove_m", 0.21).is_none());
    }

    #[test]
    fn the_sentinel_is_saturated_red_and_a_warm_tan_is_not() {
        assert!(is_sentinel_red([255.0, 0.0, 0.3]), "the marker itself");
        assert!(!is_sentinel_red([190.0, 136.0, 49.0]), "Sunchaser gold");
        assert!(!is_sentinel_red([120.0, 40.0, 40.0]), "dark red paint, not bright");
        assert!(!is_sentinel_red([200.0, 100.0, 90.0]), "pink, other channels too high");
    }

    #[test]
    fn a_colourway_named_red_is_allowed_to_be_red() {
        // These are the two that made the Python's first run useless.
        assert!(named_red("ADP Arms Red"));
        assert!(named_red("ADP-mk4 Arms Red Alert"));
        assert!(!named_red("Defiance Core Sunchaser"));
        // A word merely containing "red" must not match.
        assert!(!named_red("Corbel Arms Shredder"), "substring, not a word");
    }

    #[test]
    fn the_venture_collapse_is_caught() {
        // Twelve undersuits baked to within a point of (220, 220, 219), and
        // the collapse was on every surface at once -- which is the signature.
        let flat = vec![
            [220.0, 220.0, 219.0],
            [222.0, 222.0, 220.0],
            [223.0, 224.0, 223.0],
            [221.0, 221.0, 220.0],
        ];
        let per_sub = vec![flat.clone(), flat.clone(), flat];
        assert!(colourways_identical("Venture Undersuit", &per_sub).is_some());
    }

    #[test]
    fn genuinely_different_colourways_pass() {
        // Beacon's named colourways: crimson, yellow, purple, aqua.
        let members = vec![
            [164.0, 43.0, 43.0],
            [239.0, 215.0, 33.0],
            [94.0, 74.0, 138.0],
            [132.0, 226.0, 223.0],
        ];
        assert!(colourways_identical("Beacon Undersuit", &[members]).is_none());
    }

    #[test]
    fn one_constant_part_does_not_condemn_the_family() {
        // The Defiance helmet: `camera_m` agrees to 5.9 across six colourways
        // while `coated_metal_m` spreads 44.1. A camera lens being one colour
        // on every colourway is intent, not a discarded tint -- and the
        // per-submaterial reading called this a failure.
        let camera = vec![
            [40.0, 40.0, 40.0],
            [42.0, 42.0, 41.0],
            [43.0, 44.0, 43.0],
            [41.0, 41.0, 40.0],
        ];
        let shell = vec![
            [164.0, 43.0, 43.0],
            [239.0, 215.0, 33.0],
            [94.0, 74.0, 138.0],
            [132.0, 226.0, 223.0],
        ];
        assert!(colourways_identical("Defiance Helmet", &[camera.clone()]).is_some());
        assert!(
            colourways_identical("Defiance Helmet", &[camera, shell]).is_none(),
            "the family varies where it matters"
        );
    }

    #[test]
    fn two_colourways_are_not_enough_to_judge() {
        let members = vec![[220.0, 220.0, 219.0], [220.0, 220.0, 220.0]];
        assert!(colourways_identical("whatever", &[members]).is_none());
    }

    #[test]
    fn a_gold_piece_with_no_gold_is_a_finding() {
        assert!(accent_absent("Corbel Helmet Halcyon", 0.0).is_some());
        assert!(accent_absent("Corbel Helmet Halcyon", 0.40).is_none());
    }
}
