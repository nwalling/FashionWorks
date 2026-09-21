//! Check the attachment bones a donor mesh contributes against the canonical
//! armature the Python pipeline built.
//!
//! **The base skeleton has no attachment bones.** Names like
//! `backpack_attach_1_override` are introduced by the worn pieces themselves,
//! which is why a backpack first rendered at the body origin. A CDS undersuit
//! contributes 35 of them, and every one parents to a bone the base skeleton
//! already has, so grafting is a copy rather than a merge.
//!
//! This checks two things the graft depends on and neither of which is safe to
//! assume: that each donor bone's parent exists in the base skeleton, and that
//! its world position matches where the canonical armature put it.
//!
//!   cargo run --example graft_diff --release -- <donor.skin> <male.skeleton.json>

use std::collections::HashMap;

use serde_json::Value;

/// How far a grafted bone may sit from the golden position before it counts as
/// a disagreement. The armature stores head positions to four decimals, so this
/// is two orders of magnitude looser than the data and still sub-millimetre.
const TOLERANCE_M: f32 = 0.001;

/// One bone where the canonical armature disagrees with the game data, and the
/// game data is right.
///
/// `wep_sidearm_attach_override` parents to `RightUpLeg` in the raw `.skin`, in
/// the converted `.dae` and in the converted `.gltf` -- all three agree. The
/// armature Blender built says `RightUpLeg_Start_sIk1`, one level further down,
/// and puts the bone 27 mm away. Blender's import introduced it, so the port
/// follows the archive rather than the golden file, and this is listed as an
/// expected divergence instead of a failure.
const KNOWN_ARMATURE_DRIFT: [&str; 1] = ["wep_sidearm_attach_override"];

fn main() {
    let mut args = std::env::args().skip(1);
    let donor_path = args.next().expect("usage: graft_diff <donor.skin> <male.skeleton.json>");
    let golden_path = args.next().expect("male.skeleton.json");

    let bytes = std::fs::read(&donor_path).expect("reading donor");
    let bones = starbreaker_3d::skeleton::parse_skeleton(&bytes).expect("parsing donor skeleton");

    let golden: Value =
        serde_json::from_slice(&std::fs::read(&golden_path).expect("golden")).expect("json");
    let names: Vec<&str> = golden["bones"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    let parents: Vec<i64> = golden["parents"].as_array().unwrap().iter().filter_map(Value::as_i64).collect();
    let rest: Vec<Vec<f64>> = golden["rest"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r.as_array().unwrap().iter().filter_map(Value::as_f64).collect())
        .collect();
    let index: HashMap<&str, usize> = names.iter().enumerate().map(|(i, n)| (*n, i)).collect();

    let donor_names: Vec<&str> = bones.iter().map(|b| b.name.as_str()).collect();
    let attachments: Vec<&starbreaker_3d::skeleton::Bone> = bones
        .iter()
        .filter(|b| b.name.ends_with("_override"))
        .collect();

    println!("donor            {} bones, {} *_override", bones.len(), attachments.len());
    println!("golden armature  {} bones", names.len());

    let mut parent_ok = 0;
    let mut parent_bad = Vec::new();
    let mut pos_ok = 0;
    let mut pos_bad = Vec::new();
    let mut absent = Vec::new();
    let mut drift: Vec<(&str, Option<&str>, Option<&str>)> = Vec::new();

    for bone in &attachments {
        let Some(&gi) = index.get(bone.name.as_str()) else {
            absent.push(bone.name.as_str());
            continue;
        };

        // Parent: the graft only works because every attachment bone hangs off
        // a bone the base skeleton already has.
        let donor_parent = bone.parent_index.and_then(|p| donor_names.get(p as usize)).copied();
        let golden_parent = parents.get(gi).and_then(|&p| (p >= 0).then(|| names[p as usize]));
        if donor_parent.is_some() && donor_parent == golden_parent {
            parent_ok += 1;
        } else if KNOWN_ARMATURE_DRIFT.contains(&bone.name.as_str()) {
            drift.push((bone.name.as_str(), donor_parent, golden_parent));
        } else {
            parent_bad.push((bone.name.as_str(), donor_parent, golden_parent));
        }

        // Position: the armature stores head xyz then tail xyz.
        if let Some(r) = rest.get(gi).filter(|r| r.len() >= 3) {
            let d = (0..3)
                .map(|i| (bone.world_position[i] - r[i] as f32).abs())
                .fold(0.0f32, f32::max);
            if d <= TOLERANCE_M {
                pos_ok += 1;
            } else if KNOWN_ARMATURE_DRIFT.contains(&bone.name.as_str()) {
                // Counted with its parent, above.
            } else {
                pos_bad.push((bone.name.as_str(), bone.world_position, [r[0], r[1], r[2]], d));
            }
        }
    }

    let scored = attachments.len() - absent.len() - drift.len();
    println!("\nparents match    {} of {}", parent_ok, scored);
    for (name, got, want) in parent_bad.iter().take(6) {
        println!("    {name}: {got:?} vs {want:?}");
    }
    println!("positions match  {} of {}  (within {TOLERANCE_M} m)", pos_ok, scored);
    for (name, got, want, d) in pos_bad.iter().take(6) {
        println!(
            "    {name}: [{:.4} {:.4} {:.4}] vs [{:.4} {:.4} {:.4}]  off by {d:.4} m",
            got[0], got[1], got[2], want[0], want[1], want[2]
        );
    }
    if !drift.is_empty() {
        println!("\nknown drift      {} (archive wins; see KNOWN_ARMATURE_DRIFT)", drift.len());
        for (name, got, want) in &drift {
            println!("    {name}: archive says {got:?}, armature says {want:?}");
        }
    }
    if !absent.is_empty() {
        println!("not in the armature  {} ({:?})", absent.len(), &absent[..absent.len().min(4)]);
    }

    let ok = parent_bad.is_empty() && pos_bad.is_empty();
    println!(
        "\n{}",
        if ok {
            "PASS  every attachment bone grafts to the same parent and position"
        } else {
            "FAIL  see above"
        }
    );
}
