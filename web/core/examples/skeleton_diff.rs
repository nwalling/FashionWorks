//! Diff a parsed `.chr` skeleton against the canonical armature the Python
//! pipeline built.
//!
//! WEB.md phase 2 needs the canonical armature reproduced in the browser, and
//! `data/out/base/male.skeleton.json` is the golden output to hit: 255 bones,
//! 36 sockets. The base `.chr` carries 220 of those; the rest are `*_override`
//! attachment bones that armour introduces and `build_base_rig.graft_attachments`
//! copies on. **The base skeleton has no attachment bones of its own**, which is
//! why a backpack initially rendered at the body origin.
//!
//!   cargo run --example skeleton_diff --release -- <bhm_skeleton_v7.chr> <male.skeleton.json>

use std::collections::HashSet;

use serde_json::Value;

fn main() {
    let mut args = std::env::args().skip(1);
    let chr_path = args.next().expect("usage: skeleton_diff <skeleton.chr> <male.skeleton.json>");
    let golden_path = args.next().expect("male.skeleton.json");

    let bytes = std::fs::read(&chr_path).expect("reading .chr");
    let bones = starbreaker_3d::skeleton::parse_skeleton(&bytes)
        .expect("parsing CompiledBones from the .chr");

    let golden: Value =
        serde_json::from_slice(&std::fs::read(&golden_path).expect("reading golden")).expect("json");
    let want: Vec<&str> = golden["bones"]
        .as_array()
        .expect("bones")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let sockets: Vec<&str> = golden["sockets"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();

    println!("parsed .chr     {} bones", bones.len());
    println!("golden armature {} bones, {} sockets", want.len(), sockets.len());

    let parsed: HashSet<&str> = bones.iter().map(|b| b.name.as_str()).collect();
    let golden_set: HashSet<&str> = want.iter().copied().collect();

    // The grafted bones are the ones the armour brings, so they are expected to
    // be missing from the base .chr -- their absence is the thing being
    // verified, not a failure.
    let grafted: HashSet<&str> = sockets.iter().copied().collect();
    let missing: Vec<&str> = golden_set
        .difference(&parsed)
        .copied()
        .filter(|n| !grafted.contains(n))
        .collect();
    let extra: Vec<&str> = parsed.difference(&golden_set).copied().collect();
    let grafted_absent = grafted.difference(&parsed).count();

    println!(
        "\nin both         {}",
        parsed.intersection(&golden_set).count()
    );
    println!(
        "grafted, absent from the .chr as expected   {} of {}",
        grafted_absent,
        grafted.len()
    );
    // The 36th attachment point is not grafted: `mobiglas_attach` ships in the
    // base skeleton and, unlike the other 35, carries no `_override` suffix.
    // 220 base + 35 grafted = 255.
    for name in grafted.intersection(&parsed) {
        println!("    already in the base .chr: {name}");
    }
    println!("in golden, not in .chr, not a socket        {}", missing.len());
    for name in missing.iter().take(8) {
        println!("    {name}");
    }
    println!("in .chr, not in the golden armature         {}", extra.len());
    for name in extra.iter().take(8) {
        println!("    {name}");
    }

    let ok = missing.is_empty() && extra.is_empty();
    println!(
        "\n{}",
        if ok {
            "PASS  the .chr accounts for every canonical bone that is not grafted"
        } else {
            "FAIL  see above"
        }
    );
}
