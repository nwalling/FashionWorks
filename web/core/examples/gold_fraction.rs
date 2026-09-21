//! Re-run the store-render comparison against the port's own composite.
//!
//! WEB.md phase 3's second exit criterion. `CLAUDE.md` records the anchor: CIG's
//! store renders put the Sunchaser torso at **36.0% gold** and the upper back at
//! **33.0%**, with a gold-to-non-gold contrast of 2.48 on that sheet and 3.47 on
//! the user's; the viewer read 2.33-2.55 before the blend-table fix and 3.81
//! after.
//!
//! What this harness can and cannot say is worth being exact about, because the
//! easy version of it is wrong.
//!
//! * **It can compare the port to the bake exactly.** Identical inputs,
//!   identical UV space, so any difference in gold coverage is a difference in
//!   the compositing rules -- which is what the exit criterion is really asking.
//!   A blend-table regression moves this number hard: the third table left the
//!   Sunchaser back 13 points short.
//! * **It cannot compare an atlas percentage to a render's percentage.** An
//!   atlas counts unused UV space, and the Sunchaser arms read 7.7% of their
//!   atlas against 3% of their silhouette. The store-render figure is quoted
//!   here as the anchor the *bake* was validated against, not as something this
//!   number should equal.
//!
//! So the pass condition is: the port reproduces the bake's gold coverage and
//! contrast on every reference submaterial, and the bake still shows gold where
//! the reference set has gold and none where it does not.
//!
//!   cargo run --example gold_fraction --release -- data/interim/golden.json

use std::collections::BTreeMap;

use fashionworks_core::composite::{Composite, Layer, Texture};
use fashionworks_core::gold;
use serde_json::Value;

const SIZE: usize = 1024;

/// The anchor, from `CLAUDE.md`: the gold-to-non-gold contrast CIG's two
/// captures of the Sunchaser show, 2.95 on the store render and 3.47 on the
/// user's sheet.
///
/// **It is quoted here and deliberately not used as a pass condition.** It was
/// measured on a lit render and this harness measures an albedo atlas, which is
/// a lower number for three reasons that have nothing to do with the
/// compositing rules: the gold is metallic and a render gives it a specular
/// response its albedo does not carry, occlusion darkens the non-gold crevices,
/// and an atlas includes UV space no camera ever sees. Measured, the atlas runs
/// 2.44-2.77 where the render band is 2.95-3.47, for both the port *and* the
/// bake alike -- which is the point. Judging the atlas against the band would
/// report a failure of the renderer as a failure of the port.
const REFERENCE_CONTRAST: (f32, f32) = (2.95, 3.47);

/// How far the port's whole-piece contrast may sit from the bake's. This *is*
/// the pass condition: identical inputs through two implementations of the same
/// rules, so anything beyond sampling noise is a rule difference.
const CONTRAST_TOLERANCE: f32 = 0.25;

/// A piece needs at least this much accent before its contrast ratio means
/// anything. Below it the gold median is taken over a handful of texels and
/// moves freely: `Defiance Core Scorched` reported a drift of 1.21 purely
/// because the bake found *no* gold at all, so its ratio was the 0.0 that
/// `Reading::contrast` returns for "undefined", and `Corbel Helmet Mire` read
/// 0.91 against 1.29 on a piece that is barely gold to begin with. Neither is a
/// rule difference; both are ratios of almost nothing.
const CONTRAST_MINIMUM_GOLD: f32 = 0.02;

#[derive(Default)]
struct Piece {
    /// Every submaterial's texels pooled, because a piece's contrast is not
    /// the mean of its materials' contrasts -- see `gold::Pool`.
    ours: gold::Pool,
    theirs: gold::Pool,
    subs: usize,
}

/// Coverage may differ from the bake by this many percentage points before it
/// counts as a rule difference. The bake and the port sample layer textures
/// differently -- quantised Lanczos tiles against continuous sampling -- which
/// moves a texel either side of a hue boundary but cannot move a region.
const COVERAGE_TOLERANCE: f32 = 1.0;

/// Above this share of band-edge texels a surface's coverage is decided by
/// noise rather than by the compositing rules, so it is reported apart instead
/// of scored. See `gold::Reading::edge`: the Ana set's accent has a median hue
/// of exactly 30.0 against a band starting at 30.
const EDGE_SHARE: f32 = 0.05;

fn load(path: &str) -> Option<Texture> {
    let image = image::open(path).ok()?.to_rgb8();
    Some(Texture {
        width: image.width() as usize,
        height: image.height() as usize,
        rgb: image.into_raw(),
    })
}

fn layer_from(value: &Value) -> Layer {
    let tint = value["tint"]
        .as_array()
        .map(|a| {
            let mut out = [0.0f32; 3];
            for (i, v) in a.iter().take(3).enumerate() {
                out[i] = v.as_f64().unwrap_or(0.0) as f32;
            }
            out
        })
        .unwrap_or([0.0; 3]);
    let uv_tiling = value["uv_tiling"].as_f64().unwrap_or(1.0) as f32
        * value["tile_u"].as_f64().unwrap_or(1.0) as f32;
    Layer {
        tint,
        diffuse: value["diffuse"].as_str().and_then(load),
        metallic: value["metal"].as_bool().unwrap_or(false),
        uv_tiling,
        worn: value
            .get("worn")
            .filter(|w| !w.is_null())
            .map(|w| Box::new(layer_from(w))),
    }
}

/// The bake's PNG, as the same float sRGB image the port produces.
fn baked_image(path: &str) -> Option<Vec<f32>> {
    let image = image::open(path).ok()?.to_rgb8();
    Some(image.into_raw().iter().map(|&b| f32::from(b)).collect())
}

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: gold_fraction <golden.json>");
    let golden: Vec<Value> =
        serde_json::from_slice(&std::fs::read(&path).expect("golden")).expect("json");

    // Per item, the coverage summed over its submaterials, so a piece can be
    // read as a whole as well as by material.
    let mut by_item: BTreeMap<String, Piece> = BTreeMap::new();
    let mut rows: Vec<(String, String, gold::Reading, gold::Reading)> = Vec::new();
    let (mut checked, mut agree) = (0usize, 0usize);
    let mut worst = (0.0f32, String::new());
    let mut on_edge: Vec<(String, f32, f32)> = Vec::new();

    for case in &golden {
        let (Some(blend), Some(baked)) = (
            case["blend"].as_str().and_then(load),
            case["baked"].as_str().and_then(baked_image),
        ) else {
            continue;
        };
        let layers: Vec<Layer> = case["layers"]
            .as_array()
            .map(|a| a.iter().map(layer_from).collect())
            .unwrap_or_default();
        if layers.is_empty() {
            continue;
        }
        let wear = case["wear"].as_str().and_then(load);

        let composite = Composite {
            layers: &layers,
            blend: &blend,
            wear: wear.as_ref(),
            wear_threshold: case["wear_threshold"].as_f64().unwrap_or(0.5) as f32,
            wear_falloff: case["wear_falloff"].as_f64().unwrap_or(0.5) as f32,
        };

        let ours_image = composite.albedo(SIZE);
        let ours = gold::measure(&ours_image);
        let theirs = gold::measure(&baked);

        let item = case["name"].as_str().unwrap_or("?").to_string();
        let sub = case["sub"].as_str().unwrap_or("?").to_string();

        let off = (ours.gold - theirs.gold).abs() * 100.0;
        if ours.edge.max(theirs.edge) > EDGE_SHARE {
            on_edge.push((format!("{item} / {sub}"), off, ours.edge.max(theirs.edge)));
        } else {
            checked += 1;
            if off <= COVERAGE_TOLERANCE {
                agree += 1;
            } else if off > worst.0 {
                worst = (off, format!("{item} / {sub}"));
            }
        }

        let slot = by_item.entry(item.clone()).or_default();
        slot.ours.add(&ours_image);
        slot.theirs.add(&baked);
        slot.subs += 1;

        rows.push((item, sub, ours, theirs));
    }

    println!("submaterials measured    {checked}");
    println!(
        "coverage within {COVERAGE_TOLERANCE} point  {agree} of {checked}  ({:.1}%)",
        agree as f64 / checked.max(1) as f64 * 100.0
    );
    if !worst.1.is_empty() {
        println!("    worst: {} off by {:.2} points", worst.1, worst.0);
    }
    if !on_edge.is_empty() {
        on_edge.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        println!(
            "\n{} surface(s) sit on the band boundary and are not scored:",
            on_edge.len()
        );
        println!("  their coverage is decided by noise, not by the rules -- mean albedo");
        println!("  is the measure that still means something there.");
        for (name, off, edge) in on_edge.iter().take(6) {
            println!(
                "    {:<44} off {:>5.2}pt, {:>4.1}% of texels on the boundary",
                &name[..name.len().min(44)],
                off,
                edge * 100.0
            );
        }
        if on_edge.len() > 6 {
            println!("    ... {} more", on_edge.len() - 6);
        }
    }

    println!(
        "\nby piece, every submaterial's texels pooled into one reading:"
    );
    println!(
        "  {:<34} {:>8} {:>8} {:>9} {:>9} {:>9}",
        "piece", "port", "bake", "delta", "contrast", "bake"
    );
    let mut pieces: Vec<(String, gold::Reading, gold::Reading)> = Vec::new();
    for (item, piece) in by_item {
        if piece.subs == 0 {
            continue;
        }
        let ours = piece.ours.finish();
        let theirs = piece.theirs.finish();
        println!(
            "  {:<34} {:>7.1}% {:>7.1}% {:>+8.2}pt {:>9.2} {:>9.2}",
            &item[..item.len().min(34)],
            ours.gold * 100.0,
            theirs.gold * 100.0,
            (ours.gold - theirs.gold) * 100.0,
            ours.contrast(),
            theirs.contrast(),
        );
        pieces.push((item, ours, theirs));
    }

    // The pieces the anchor is about, named so a regression is legible.
    println!("\nthe Sunchaser submaterials, in detail:");
    for (item, sub, ours, theirs) in rows.iter().filter(|(i, ..)| i.contains("Sunchaser")) {
        println!(
            "  {:<22} {:<18} port {:>5.1}%  bake {:>5.1}%  contrast {:>5.2} / {:>5.2}",
            &item[..item.len().min(22)],
            &sub[..sub.len().min(18)],
            ours.gold * 100.0,
            theirs.gold * 100.0,
            ours.contrast(),
            theirs.contrast(),
        );
    }

    // The gold-bearing Sunchaser materials against the reference band. This is
    // the comparison the exit criterion names, and the only one that survives
    // the difference between an atlas and a photograph.
    // The pass condition: the port reproduces the bake. Both are albedo
    // atlases, so they are directly comparable to each other in a way neither
    // is to a lit render.
    let mut held = 0usize;
    let mut total = 0usize;
    let mut drift = 0.0f32;
    println!("\nwhole-piece contrast, port against bake:");
    let mut too_little = 0usize;
    for (item, ours, theirs) in &pieces {
        if ours.gold <= 0.0 && theirs.gold <= 0.0 {
            continue;
        }
        if ours.gold < CONTRAST_MINIMUM_GOLD || theirs.gold < CONTRAST_MINIMUM_GOLD {
            too_little += 1;
            continue;
        }
        total += 1;
        let off = (ours.contrast() - theirs.contrast()).abs();
        drift = drift.max(off);
        if off <= CONTRAST_TOLERANCE {
            held += 1;
        }
        println!(
            "  {:<34} {:>5.2} vs {:>5.2}   {:+.2}{}",
            &item[..item.len().min(34)],
            ours.contrast(),
            theirs.contrast(),
            ours.contrast() - theirs.contrast(),
            if off <= CONTRAST_TOLERANCE { "" } else { "   OVER" },
        );
    }
    println!("  {held} of {total} within {CONTRAST_TOLERANCE}, worst drift {drift:.2}");
    if too_little > 0 {
        println!(
            "  {too_little} piece(s) skipped: under {:.0}% accent, so the ratio is noise",
            CONTRAST_MINIMUM_GOLD * 100.0
        );
    }

    // And the absolute figure, recorded rather than judged.
    println!(
        "\nthe Sunchaser pieces, atlas contrast (the render band is {:.2}-{:.2},",
        REFERENCE_CONTRAST.0, REFERENCE_CONTRAST.1
    );
    println!("and an atlas is expected to sit below it -- see REFERENCE_CONTRAST):");
    for (item, ours, _) in pieces.iter().filter(|(i, ..)| i.contains("Sunchaser")) {
        if ours.gold <= 0.0 {
            continue;
        }
        println!(
            "  {:<34} {:>5.2}   gold {:>5.1}% of atlas",
            &item[..item.len().min(34)],
            ours.contrast(),
            ours.gold * 100.0
        );
    }
}
