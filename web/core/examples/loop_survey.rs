//! Which clips in an animation database loop. RENDERING.md Phase 5.
//!
//! The still idle, `nw_stand_idle_turn360_planted`, turns the body a full
//! circle, so it cannot play as a loop. This scores every clip in a `.dba` by
//! the widest gap between a bone's first and last rotation (the seam a loop
//! would show), how far any bone moves (a loop that does not move is a still),
//! and how far the hips turn (a turn-in-place is not an idle). The root is
//! left out, as the players leave it out: it carries the clip's own placement.
//!
//!   cargo run --example loop_survey --release -- <male.skeleton.json> <a.dba|a.caf> [...]

use std::collections::HashMap;

use fashionworks_core::clips::loop_score;
use serde_json::Value;

fn crc(name: &str) -> u32 {
    let mut h = crc32fast::Hasher::new();
    h.update(name.as_bytes());
    h.finalize()
}

fn main() {
    let mut args = std::env::args().skip(1);
    let golden_path = args.next().expect("usage: loop_survey <male.skeleton.json> <dba>...");
    let golden: Value =
        serde_json::from_slice(&std::fs::read(&golden_path).expect("golden")).expect("json");
    let names: Vec<String> = golden["bones"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect();
    let by_hash: HashMap<u32, &str> = names.iter().map(|n| (crc(n), n.as_str())).collect();
    let root = crc(&names[0]);
    let hips = crc("Hips");

    for path in args {
        let bytes = std::fs::read(&path).expect("reading .dba");
        let db = if path.to_ascii_lowercase().ends_with(".caf") {
            starbreaker_3d::animation::parse_caf(&bytes).expect("parsing .caf")
        } else {
            starbreaker_3d::animation::parse_dba(&bytes).expect("parsing .dba")
        };
        println!("{path}");
        println!("  {:>6} {:>5} {:>6} {:>7} {:>6}  clip  (gap bone)", "gap", "move", "hips", "seconds", "fps");
        let mut rows = Vec::new();
        for clip in &db.clips {
            let stem = clip.name.rsplit('/').next().unwrap_or(&clip.name).trim_end_matches(".caf");
            if stem.ends_with("_add") {
                continue;
            }
            let keep = |c: &starbreaker_3d::animation::BoneChannel| {
                c.bone_hash != root && by_hash.contains_key(&c.bone_hash)
            };
            let Some(score) = loop_score(clip, keep, hips) else { continue };
            rows.push((stem.to_string(), score));
        }
        rows.sort_by(|a, b| a.1.gap_deg.partial_cmp(&b.1.gap_deg).unwrap());
        for (stem, s) in &rows {
            println!(
                "  {:>6.2} {:>5.1} {:>6.1} {:>7.2} {:>6.1}  {stem}  ({})",
                s.gap_deg,
                s.motion_deg,
                s.watch_deg,
                (s.frames.saturating_sub(1)) as f32 / s.fps,
                s.fps,
                by_hash.get(&s.gap_bone).copied().unwrap_or("?"),
            );
        }
    }
}
