//! Parse an animation database and resolve its bone channels against the
//! canonical armature.
//!
//! `scx poses` retargets standing and crouching poses out of the game's own
//! animation data; nothing is hand-authored. The clips live in `.dba` files
//! under `Animations/Characters/Human/male_v7/weapons/no_weapon/locomotion/`,
//! and channels are keyed by **CRC32 of the bone name**, so resolving them
//! needs the armature's name list.
//!
//! Clips suffixed `_add` are additive deltas layered at runtime and are no use
//! alone, so they are counted separately here rather than silently included.
//!
//!   cargo run --example pose_probe --release -- <stand.dba> <male.skeleton.json> [clip]

use std::collections::HashMap;

use serde_json::Value;

fn main() {
    let mut args = std::env::args().skip(1);
    let dba_path = args.next().expect("usage: pose_probe <dba> <male.skeleton.json> [clip]");
    let golden_path = args.next().expect("male.skeleton.json");
    let wanted = args.next();

    let bytes = std::fs::read(&dba_path).expect("reading .dba");
    let db = starbreaker_3d::animation::parse_dba(&bytes).expect("parsing .dba");

    let golden: Value =
        serde_json::from_slice(&std::fs::read(&golden_path).expect("golden")).expect("json");
    let names: Vec<&str> = golden["bones"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();

    // CRC32 of each armature bone name, so a channel's hash can be named.
    let by_hash: HashMap<u32, &str> = names
        .iter()
        .map(|n| {
            let mut h = crc32fast::Hasher::new();
            h.update(n.as_bytes());
            (h.finalize(), *n)
        })
        .collect();

    let additive = db
        .clips
        .iter()
        .filter(|c| c.name.trim_end_matches(".caf").ends_with("_add"))
        .count();
    println!("{}", dba_path.rsplit('/').next().unwrap_or(&dba_path));
    println!("  clips            {} ({additive} additive `_add`, unusable alone)", db.clips.len());
    println!("  armature bones   {}", names.len());

    // Clip names are full paths ending `.caf`, not the bare names the pipeline
    // refers to, so match on the stem.
    let stem = |name: &str| {
        name.rsplit('/')
            .next()
            .unwrap_or(name)
            .trim_end_matches(".caf")
            .to_string()
    };
    let clip = match &wanted {
        Some(w) => db.clips.iter().find(|c| stem(&c.name) == *w),
        None => db.clips.first(),
    };
    let Some(clip) = clip else {
        println!("  clip not found");
        let sample: Vec<String> = db.clips.iter().take(6).map(|c| stem(&c.name)).collect();
        println!("  available: {sample:?}");
        return;
    };

    let resolved = clip.channels.iter().filter(|c| by_hash.contains_key(&c.bone_hash)).count();
    let frames = clip
        .channels
        .iter()
        .flat_map(|c| c.rotations.iter().map(|k| k.time))
        .fold(0.0f32, f32::max);

    println!("\n  clip             {}", stem(&clip.name));
    println!("  fps              {}", clip.fps);
    println!("  channels         {} ({resolved} resolve against the armature)", clip.channels.len());
    println!("  last frame       {frames}");
    println!(
        "  start rotation   {}",
        clip.start_rotation.map_or("none".to_string(), |r| format!("{r:?}"))
    );

    // Unresolved hashes are bones the clip animates that our armature does not
    // have -- worth naming as a count, since a port that silently drops them
    // would pose fewer bones than the pipeline does.
    let unresolved = clip.channels.len() - resolved;
    if unresolved > 0 {
        println!("  unresolved       {unresolved} channels hash to no armature bone");
    }

    // A couple of named channels, to show the resolution really works.
    println!("\n  sample channels:");
    for channel in clip.channels.iter().take(64) {
        if let Some(name) = by_hash.get(&channel.bone_hash) {
            println!(
                "    {name:<28} {} rotation keys, {} position keys",
                channel.rotations.len(),
                channel.positions.len()
            );
        }
    }
}
