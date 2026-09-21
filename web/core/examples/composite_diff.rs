//! Composite submaterials in Rust and diff their mean albedo against the
//! Python's baked PNGs.
//!
//! This is WEB.md phase 3's exit criterion: *per-submaterial mean albedo within
//! tolerance of the Python bakes*. The mean is the right measure because it is
//! insensitive to sampling differences that do not matter -- a pixel either
//! side of a layer boundary -- while still catching every rule that does: the
//! blend table, which palette colour a metal takes, the metal texture
//! normalisation, and the wear blend.
//!
//!   cargo run --example composite_diff --release -- <composite_golden.json>

use fashionworks_core::composite::{Composite, Layer, Texture};
use serde_json::Value;

/// sRGB units out of 255. Two thresholds are reported rather than one, because
/// the residual between them is not a rule difference.
///
/// The pipeline tiles a layer texture by **downsampling it with Lanczos to a
/// quantised tile size** -- `tile_px = round(size / repeat)` -- and repeating
/// that. At an effective tiling of 144 on a 1024 bake, each tile is 7 pixels,
/// and a 7x7 Lanczos reduction of a detail texture shifts its mean. Sampling
/// the full-resolution texture continuously, as a shader does, gives a
/// different and better answer.
///
/// The evidence that this is the cause rather than a guess: the submaterials
/// outside a single unit have median effective tiling 144 against 60 for the
/// rest, and a maximum of 2560 against 1200.
const STRICT: f32 = 1.0;
const TOLERANCE: f32 = 3.0;

/// Match the pipeline's bake resolution so resampling differences do not show
/// up as rule differences.
const SIZE: usize = 1024;

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
    // The layer's own tiling times the material's, as the pipeline composes it.
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
    let path = std::env::args().nth(1).expect("usage: composite_diff <golden.json>");
    let golden: Vec<Value> =
        serde_json::from_slice(&std::fs::read(&path).expect("golden")).expect("json");

    let (mut checked, mut agree, mut skipped) = (0usize, 0usize, 0usize);
    let mut strict = 0usize;
    let mut worst = (0.0f32, String::new());
    let mut examples: Vec<String> = Vec::new();

    for case in &golden {
        let Some(blend) = case["blend"].as_str().and_then(load) else {
            skipped += 1;
            continue;
        };
        let wear = case["wear"].as_str().and_then(load);
        let layers: Vec<Layer> = case["layers"]
            .as_array()
            .map(|a| a.iter().map(layer_from).collect())
            .unwrap_or_default();
        if layers.is_empty() {
            skipped += 1;
            continue;
        }

        let composite = Composite {
            layers: &layers,
            blend: &blend,
            wear: wear.as_ref(),
            wear_threshold: case["wear_threshold"].as_f64().unwrap_or(0.5) as f32,
            wear_falloff: case["wear_falloff"].as_f64().unwrap_or(0.25) as f32,
        };
        let got = composite.albedo_mean(SIZE);
        let want: Vec<f32> = case["baked_mean"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_f64).map(|v| v as f32).collect())
            .unwrap_or_default();
        if want.len() != 3 {
            skipped += 1;
            continue;
        }
        checked += 1;
        let off = (0..3).map(|i| (got[i] - want[i]).abs()).fold(0.0f32, f32::max);
        if off <= STRICT {
            strict += 1;
        }
        if off <= TOLERANCE {
            agree += 1;
        } else {
            if off > worst.0 {
                worst = (off, case["sub"].as_str().unwrap_or("").to_string());
            }
            if examples.len() < 8 {
                examples.push(format!(
                    "{}: [{:.1} {:.1} {:.1}] vs [{:.1} {:.1} {:.1}]  off {off:.1}",
                    case["sub"].as_str().unwrap_or(""),
                    got[0], got[1], got[2], want[0], want[1], want[2]
                ));
            }
        }
    }

    println!("submaterials composited  {checked}  ({skipped} skipped)");
    println!(
        "within {STRICT} sRGB unit         {strict} of {checked}  ({:.1}%)",
        strict as f64 / checked.max(1) as f64 * 100.0
    );
    println!(
        "within {TOLERANCE} sRGB units        {agree} of {checked}  ({:.1}%)",
        agree as f64 / checked.max(1) as f64 * 100.0
    );
    for e in &examples {
        println!("    {e}");
    }
    if !worst.1.is_empty() {
        println!("    worst: {} off by {:.1}", worst.1, worst.0);
    }
}
