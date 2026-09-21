//! How many attachment bones a set of donors contributes to the canonical
//! armature, and which ones the golden has that they do not.
//!
//! The pipeline grafts from **one** undersuit and reaches 255 bones with 35
//! `*_override` names. A port picking its own donors has to reach the same
//! armature or every socket sits somewhere slightly different, so this reports
//! the gap by name rather than by count.
//!
//!   cargo run --example rig_union --release -- <skeleton.chr> <golden.json> <donor.skin>...
use std::collections::BTreeSet;

use fashionworks_core::armature::Armature;
use serde_json::Value;

fn main() {
    let mut args = std::env::args().skip(1);
    let chr = args.next().expect("usage: rig_union <skeleton.chr> <golden.json> <donor.skin>...");
    let golden_path = args.next().expect("golden.json");
    let donors: Vec<String> = args.collect();

    let bytes = std::fs::read(&chr).expect("reading .chr");
    let mut armature = Armature::from_chr(&bytes).expect("parsing skeleton");
    println!("base            {} bones", armature.len());

    for donor in &donors {
        let Ok(data) = std::fs::read(donor) else {
            println!("  (unreadable: {donor})");
            continue;
        };
        let before = armature.len();
        if let Some(bones) = starbreaker_3d::skeleton::parse_skeleton(&data) {
            armature.graft(&bones);
        }
        println!(
            "  +{:<3} {}",
            armature.len() - before,
            donor.rsplit('/').next().unwrap_or(donor)
        );
    }
    println!("armature        {} bones, {} attachments", armature.len(), armature.attachments());

    let golden: Value =
        serde_json::from_slice(&std::fs::read(&golden_path).expect("golden")).expect("json");
    let want: BTreeSet<String> = golden["bones"]
        .as_array()
        .expect("bones")
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    let have: BTreeSet<String> = armature.bones.iter().map(|b| b.name.clone()).collect();

    println!("golden          {} bones", want.len());
    let missing: Vec<&String> = want.difference(&have).collect();
    let extra: Vec<&String> = have.difference(&want).collect();
    println!("missing here    {}", missing.len());
    for name in missing.iter().take(12) {
        println!("    {name}");
    }
    println!("not in golden   {}", extra.len());
    for name in extra.iter().take(8) {
        println!("    {name}");
    }

    // Names agreeing says nothing about where the bones are. The golden's
    // `rest` is Blender head/tail in Z-up, which is the archive's own space, so
    // a head position compares directly against `world_position`.
    let names: Vec<&str> = golden["bones"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    let rest = golden["rest"].as_array().expect("rest");
    let mut compared = 0usize;
    let mut agree = 0usize;
    let mut worst = (0.0f32, String::new());
    println!("\nbones whose position disagrees with the golden:");
    for (i, name) in names.iter().enumerate() {
        let Some(index) = armature.index_of(name) else { continue };
        let Some(head) = rest.get(i).and_then(Value::as_array) else { continue };
        let want = [0usize, 1, 2].map(|k| head.get(k).and_then(Value::as_f64).unwrap_or(0.0) as f32);
        let got = armature.bones[index].world_position;
        let off = (0..3).map(|k| (got[k] - want[k]).abs()).fold(0.0f32, f32::max);
        compared += 1;
        if off <= TOLERANCE_M {
            agree += 1;
        } else {
            println!(
                "    {name:<34} off {off:.4} m   archive [{:.4} {:.4} {:.4}]  golden [{:.4} {:.4} {:.4}]",
                got[0], got[1], got[2], want[0], want[1], want[2]
            );
            if off > worst.0 {
                worst = (off, (*name).to_string());
            }
        }
    }
    println!(
        "positions       {agree} of {compared} within {TOLERANCE_M} m ({:.1}%)",
        agree as f64 / compared.max(1) as f64 * 100.0
    );
    if !worst.1.is_empty() {
        println!("    worst: {} off by {:.4} m", worst.1, worst.0);
    }
}

/// The armature stores head positions to four decimals, so a millimetre is two
/// orders of magnitude looser than the data.
const TOLERANCE_M: f32 = 0.001;
