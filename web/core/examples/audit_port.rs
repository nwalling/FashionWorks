//! Run the catalogue invariants against the port's own composited output.
//!
//! WEB.md phase 3's third exit criterion, and the plan's stated mitigation for
//! its largest risk: *the audit invariants are ported to run against the web
//! port's output as well.*
//!
//! The point is not to re-test the Python. It is that the port composites every
//! surface itself, so it can fail in the same ways the bake has failed, and
//! nothing would catch it. Each check here fired on a real regression:
//!
//! | check | what it caught |
//! | --- | --- |
//! | `cloth-reads-metal` | the Beacon undersuit at 58.9% metallic, from a wrong blend table |
//! | `colourways-identical` | twelve Venture undersuits baked flat near-white, from reading `TintMode=0` as "not tinted" |
//! | `sentinel-red-baked` | emissive glow markers composited as albedo, up to 80% of one surface |
//! | `accent-absent` | the Corbel lineup rendering black where the game shows yellow |
//!
//!   cargo run --example audit_port --release -- data/interim/golden.json

use std::collections::BTreeMap;

use fashionworks_core::audit::{self, Finding};
use fashionworks_core::composite::{Composite, Layer, Texture};
use serde_json::Value;

const SIZE: usize = 1024;

/// Pieces the reference set shows with a visible accent, so a composite with
/// none is a failure rather than a fact about the item. Corbel Halcyon is the
/// piece the blend table was derived on: yellow exists only as palette entry A,
/// and the refuted third table rendered its helmet shell and upper chest black.
const ACCENT_EXPECTED: [&str; 2] = ["Halcyon", "Sunchaser"];

/// Checks whose findings are a **known open gap in the pipeline itself**, not a
/// porting fault, and so do not fail the run.
///
/// Only `sentinel-red-baked` qualifies. CIG marks where a glow goes with a
/// pure-red BaseLayer tint and supplies the colour from the material's
/// `Emissive`; composited as albedo those become red blotches. Fixing it needs
/// an emissive output plumbed through the bake, Blender and glTF, which the
/// Python has not done either -- its own audit reports 267 of these across the
/// catalogue. The port matching that is the correct outcome: on the items both
/// cover the two agree to the percentage point, Corbel Arms Halcyon `arms01_m`
/// reading 5% in each. The finding is printed rather than swallowed, because
/// the whole point of the check is to keep the damage sized.
const KNOWN_GAPS: [&str; 1] = ["sentinel-red-baked"];

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

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: audit_port <golden.json>");
    let golden: Vec<Value> =
        serde_json::from_slice(&std::fs::read(&path).expect("golden")).expect("json");

    let mut findings: Vec<Finding> = Vec::new();
    // Keyed by the colourway group and the submaterial, so members of one
    // family are compared on the same surface rather than across surfaces.
    let mut colourways: BTreeMap<(String, String), Vec<[f32; 3]>> = BTreeMap::new();
    // Accent coverage per piece, pooled over its submaterials.
    let mut accent: BTreeMap<String, (f32, f32)> = BTreeMap::new();
    let mut composited = 0usize;

    for case in &golden {
        let Some(blend) = case["blend"].as_str().and_then(load) else {
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

        let item = case["name"].as_str().unwrap_or("?");
        let sub = case["sub"].as_str().unwrap_or("?");
        let group = case["variant_of"].as_str().unwrap_or(item).to_string();

        let image = composite.albedo(SIZE);
        composited += 1;

        findings.extend(audit::sentinel_red_baked(item, sub, &image));

        if audit::is_cloth(sub) {
            // Metalness costs a second pass over the surface, so it is only
            // computed where a check reads it.
            let metal = composite.metal_fraction(SIZE);
            findings.extend(audit::cloth_reads_metal(item, sub, metal));
        }

        let mut mean = [0.0f64; 3];
        for texel in image.chunks_exact(3) {
            for i in 0..3 {
                mean[i] += f64::from(texel[i]);
            }
        }
        let n = (SIZE * SIZE) as f64;
        colourways
            .entry((group, sub.to_string()))
            .or_default()
            .push([
                (mean[0] / n) as f32,
                (mean[1] / n) as f32,
                (mean[2] / n) as f32,
            ]);

        if ACCENT_EXPECTED.iter().any(|w| item.contains(w)) {
            let slot = accent.entry(item.to_string()).or_insert((0.0, 0.0));
            slot.0 += audit::accent_coverage(&image);
            slot.1 += 1.0;
        }
    }

    // Regroup by family, so the verdict is taken over all of a family's
    // submaterials at once rather than one at a time.
    let mut families: BTreeMap<String, Vec<Vec<[f32; 3]>>> = BTreeMap::new();
    for ((group, _sub), members) in colourways {
        families.entry(group).or_default().push(members);
    }
    let mut groups_checked = 0usize;
    for (group, per_sub) in &families {
        if per_sub
            .iter()
            .all(|m| m.len() < audit::COLOURWAY_MINIMUM_MEMBERS)
        {
            continue;
        }
        groups_checked += 1;
        findings.extend(audit::colourways_identical(
            &group[..group.len().min(8)],
            per_sub,
        ));
    }

    for (item, (total, n)) in &accent {
        if *n == 0.0 {
            continue;
        }
        findings.extend(audit::accent_absent(item, total / n));
    }

    println!("surfaces composited       {composited}");
    println!("colourway groups compared {groups_checked}");
    println!("pieces checked for accent {}", accent.len());

    let mut by_check: BTreeMap<&str, Vec<&Finding>> = BTreeMap::new();
    for finding in &findings {
        by_check.entry(finding.check).or_default().push(finding);
    }

    let failures: usize = by_check
        .iter()
        .filter(|(check, _)| !KNOWN_GAPS.contains(check))
        .map(|(_, found)| found.len())
        .sum();

    println!();
    for (check, found) in &by_check {
        let known = KNOWN_GAPS.contains(check);
        println!(
            "{check}: {}{}",
            found.len(),
            if known { "   (known gap, inherited from the pipeline)" } else { "" }
        );
        for finding in found.iter().take(if known { 4 } else { 12 }) {
            println!("    {:<40} {}", finding.subject, finding.detail);
        }
        let shown = if known { 4 } else { 12 };
        if found.len() > shown {
            println!("    ... {} more", found.len() - shown);
        }
    }

    if failures == 0 {
        println!("\nevery invariant holds; the only findings are the known gap above");
        return;
    }
    println!("\n{failures} finding(s) that are not a known gap");
    std::process::exit(1);
}
