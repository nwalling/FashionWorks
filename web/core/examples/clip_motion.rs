//! Which bones a clip moves, and when. RENDERING.md Phase 5.
//!
//!   cargo run --example clip_motion --release -- <male.skeleton.json> <a.dba> <clip>

use std::collections::HashMap;

use fashionworks_core::clips::{angle_deg, sample};
use serde_json::Value;

fn crc(name: &str) -> u32 {
    let mut h = crc32fast::Hasher::new();
    h.update(name.as_bytes());
    h.finalize()
}

fn main() {
    let mut args = std::env::args().skip(1);
    let golden: Value = serde_json::from_slice(&std::fs::read(args.next().unwrap()).unwrap()).unwrap();
    let names: Vec<String> = golden["bones"].as_array().unwrap().iter().filter_map(|v| v.as_str().map(str::to_string)).collect();
    let by_hash: HashMap<u32, &str> = names.iter().map(|n| (crc(n), n.as_str())).collect();
    let path = args.next().unwrap();
    let bytes = std::fs::read(&path).unwrap();
    let db = if path.ends_with(".caf") {
        starbreaker_3d::animation::parse_caf(&bytes).unwrap()
    } else {
        starbreaker_3d::animation::parse_dba(&bytes).unwrap()
    };
    let wanted = args.next().unwrap();
    let clip = db.clips.iter().find(|c| c.name.contains(&wanted)).expect("clip");
    let s = sample(clip, |_| true).unwrap();
    let n = s.bones.len();
    let q = |f: usize, b: usize| {
        let o = (f * n + b) * 4;
        [s.rotations[o], s.rotations[o + 1], s.rotations[o + 2], s.rotations[o + 3]]
    };
    let mut rows: Vec<(f32, f32, String)> = (0..n)
        .map(|b| {
            let peak = (0..s.frames).map(|f| angle_deg(q(0, b), q(f, b))).fold(0.0, f32::max);
            let gap = angle_deg(q(0, b), q(s.frames - 1, b));
            (peak, gap, by_hash.get(&s.bones[b]).map_or(format!("#{:08x}", s.bones[b]), |n| n.to_string()))
        })
        .collect();
    rows.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    println!("{} frames at {} fps, {} channels", s.frames, s.fps, n);
    for (peak, gap, name) in rows.iter().take(25) {
        println!("  {peak:>6.1} peak {gap:>6.2} gap  {name}");
    }
    // The root and hips through time.
    for bone in [names[0].as_str(), "Hips", "Spine", "Spine1", "Spine2", "Spine3", "Neck", "Neck1", "Head", "LeftShoulder", "RightShoulder", "RightArm", "RightHand", "LeftFoot"] {
        if let Some(b) = s.bones.iter().position(|&h| h == crc(bone)) {
            let line: Vec<String> = (0..s.frames).step_by((s.frames / 24).max(1)).map(|f| format!("{:.0}", angle_deg(q(0, b), q(f, b)))).collect();
            println!("  {bone:>10}: {}", line.join(" "));
        } else {
            println!("  {bone:>10}: not animated");
        }
    }
}
