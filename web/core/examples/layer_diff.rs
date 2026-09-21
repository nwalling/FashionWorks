//! Resolve each base layer's linear colour in Rust and diff it against the
//! Python compositor's answer.
//!
//! WEB.md phase 3 has to re-derive, in a shader, everything `tint.py` knows.
//! Before any of that can be written the *colour of a single layer* has to come
//! out right, because every later rule multiplies into it. Two rules decide it
//! and both were expensive to learn:
//!
//! * **A metal takes the palette entry's specular, a dielectric its colour.** A
//!   metal has no diffuse albedo; its appearance is its F0. Reading the tint
//!   colour instead rendered ten Lynx colourways as the same grey arm.
//! * **The palette modulates the layer's own `TintColor`, it does not replace
//!   it.** 966 of 1984 palette-tinted base layers carry a non-white one, and
//!   substituting rendered half of them up to twice as bright as the game.
//!
//! The layer's own `.mtl` supplies the final multiply -- `Specular` for a metal,
//! `Diffuse` for a dielectric -- so it is resolved from disk here and from the
//! archive in the browser.
//!
//!   cargo run --example layer_diff --release -- <layers_python.json> <raw-root>

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;
use starbreaker_3d::mtl;

/// Metals sit near their F0; dielectrics near 0.04. Across the 495-entry layer
/// library the populations separate cleanly, the dielectric category topping
/// out at 0.156, so 0.2 splits them.
const METAL_F0_THRESHOLD: f32 = 0.2;

const TOLERANCE: f64 = 1e-4;

fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

/// A layer material is metal by its own reflectance, not by its directory.
///
/// Keying on `Materials/Layers/metal` misses the whole `metallic/` category --
/// that path does not contain `/metal/` -- and promotes the 24% of `/metal/`
/// entries that are dielectric by their own numbers.
fn is_metal(diffuse: [f32; 3], specular: [f32; 3]) -> bool {
    let spec_max = specular.iter().copied().fold(0.0f32, f32::max);
    let diff_max = diffuse.iter().copied().fold(0.0f32, f32::max);
    spec_max > METAL_F0_THRESHOLD || (diff_max < 0.02 && spec_max > 0.04)
}

/// Find a layer's `.mtl` under the raw tree, however the reference spells it.
fn resolve(raw_root: &Path, reference: &str) -> Option<PathBuf> {
    let rel = reference.replace('\\', "/");
    let direct = raw_root.join("Data").join(&rel);
    if direct.is_file() {
        return Some(direct);
    }
    let name = rel.rsplit('/').next()?.to_ascii_lowercase();
    fn walk(dir: &Path, want: &str, depth: usize) -> Option<PathBuf> {
        if depth == 0 {
            return None;
        }
        for entry in std::fs::read_dir(dir).ok()?.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(hit) = walk(&path, want, depth - 1) {
                    return Some(hit);
                }
            } else if path.file_name()?.to_string_lossy().to_ascii_lowercase() == want {
                return Some(path);
            }
        }
        None
    }
    walk(&raw_root.join("Data"), &name, 12)
}

fn main() {
    let mut args = std::env::args().skip(1);
    let golden_path = args.next().expect("usage: layer_diff <layers_python.json> <raw-root>");
    let raw_root = PathBuf::from(args.next().unwrap_or_else(|| "data/raw".into()));

    let golden: Vec<Value> =
        serde_json::from_slice(&std::fs::read(&golden_path).expect("golden")).expect("json");

    // Cache each layer material's response, since layers repeat heavily.
    let mut cache: HashMap<String, Option<([f32; 3], [f32; 3])>> = HashMap::new();
    let mut misses: HashMap<&'static str, usize> = HashMap::new();
    let mut load = |reference: &str| -> Option<([f32; 3], [f32; 3])> {
        if let Some(hit) = cache.get(reference) {
            return *hit;
        }
        // Three different failures, counted apart. Collapsing them into one
        // "unresolved" number said 1944 of 1944 and pointed at path handling
        // when the files were sitting right there.
        let found = match resolve(&raw_root, reference) {
            None => {
                *misses.entry("no such file").or_default() += 1;
                None
            }
            Some(path) => match std::fs::read(&path) {
                Err(_) => {
                    *misses.entry("unreadable").or_default() += 1;
                    None
                }
                Ok(bytes) => match mtl::parse_mtl(&bytes) {
                    Err(_) => {
                        *misses.entry("parse_mtl failed").or_default() += 1;
                        None
                    }
                    Ok(file) => match file.materials.first() {
                        None => {
                            *misses.entry("no submaterials").or_default() += 1;
                            None
                        }
                        Some(m) => Some((m.diffuse, m.specular)),
                    },
                },
            },
        };
        cache.insert(reference.to_string(), found);
        found
    };

    let (mut checked, mut agree, mut unresolved) = (0usize, 0usize, 0usize);
    let mut metal_disagree = 0usize;
    let mut examples: Vec<String> = Vec::new();

    for row in &golden {
        let reference = row["layer_path"].as_str().unwrap_or_default();
        let want: Vec<f64> = row["linear"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_f64).collect())
            .unwrap_or_default();
        if reference.is_empty() || want.len() != 3 {
            continue;
        }
        let Some((diffuse, specular)) = load(reference) else {
            unresolved += 1;
            continue;
        };
        checked += 1;

        // Metalness first: it decides which of the palette's two colours applies.
        let metal = is_metal(diffuse, specular);
        if metal != row["metal"].as_bool().unwrap_or(false) {
            metal_disagree += 1;
        }

        // The palette contribution, as the Python computed it, so this isolates
        // the layer rules rather than re-testing palette resolution.
        let mut lin = [0.0f32; 3];
        for i in 0..3 {
            lin[i] = row["palette_source"]
                .get(i)
                .and_then(Value::as_f64)
                .map(|v| srgb_to_linear(v as f32))
                .unwrap_or(1.0)
                * row["tint_color"].get(i).and_then(Value::as_f64).unwrap_or(1.0) as f32;
        }
        let response = if metal { specular } else { diffuse };
        for i in 0..3 {
            lin[i] *= response[i];
        }

        let off = (0..3).map(|i| (lin[i] as f64 - want[i]).abs()).fold(0.0f64, f64::max);
        if off <= TOLERANCE {
            agree += 1;
        } else if examples.len() < 6 {
            examples.push(format!(
                "{} {}: {:?} vs {:?} (off {off:.5}, metal {metal})",
                row["sub"].as_str().unwrap_or(""),
                row["layer"].as_str().unwrap_or(""),
                lin.map(|v| (v * 1e6).round() / 1e6),
                want
            ));
        }
    }

    println!("layers compared        {checked}");
    println!("could not load         {unresolved}");
    let mut rows: Vec<(&&str, &usize)> = misses.iter().collect();
    rows.sort_by_key(|(_, n)| std::cmp::Reverse(**n));
    for (why, n) in rows {
        println!("    {why:<22} {n} distinct layer file(s)");
    }
    println!("metalness disagrees    {metal_disagree}");
    println!(
        "colour agreement       {agree} of {checked}  ({:.2}%)",
        agree as f64 / checked.max(1) as f64 * 100.0
    );
    for e in &examples {
        println!("    {e}");
    }
}
