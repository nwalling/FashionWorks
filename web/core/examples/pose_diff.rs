//! Retarget a real clip and diff the result against `data/out/poses.json`.
//!
//! This is the end of WEB.md phase 2: geometry, skeleton and poses all
//! reproduced from the archive and checked against what the existing pipeline
//! produced. The pose is the fiddliest of the three because two plausible
//! retargets fail silently -- one puts the character on its back, the other
//! points the arms at the ceiling -- so agreement per bone is the only way to
//! know which one is running.
//!
//!   cargo run --example pose_diff --release -- \
//!       <bind.json> <clip.dba> <clip-name> <poses.json> <pose-key>

use std::collections::HashMap;

use fashionworks_core::poses::{forward_kinematics, BindBone, Quat, Sample, Vec3};
use serde_json::Value;

/// How far a quaternion component may differ before it counts as a
/// disagreement. The golden file carries full f64 precision from Python while
/// the clip is sampled in f32, so exact equality is not available.
const TOLERANCE: f64 = 1e-4;

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    if a.len() < 5 {
        eprintln!("usage: pose_diff <bind.json> <clip.dba> <clip-name> <poses.json> <pose-key>");
        std::process::exit(2);
    }
    let (bind_path, dba_path, clip_name, golden_path, key) = (&a[0], &a[1], &a[2], &a[3], &a[4]);

    // The bind pose, as tools/anim-dump writes it.
    let bind_json: Value =
        serde_json::from_slice(&std::fs::read(bind_path).expect("bind.json")).expect("json");
    let entries = bind_json.as_array().expect("bind.json is a list");
    let bind: Vec<BindBone> = entries
        .iter()
        .map(|b| BindBone {
            name: b["name"].as_str().unwrap_or_default().to_string(),
            parent: b["parent"].as_u64().map(|p| p as usize),
            local_rotation: quat(&b["local_rotation"]),
            local_position: vec3(&b["local_position"]),
            world_rotation: quat(&b["world_rotation"]),
        })
        .collect();

    // The clip's final frame, per bone, keyed by CRC32 of the bone name.
    let dba = std::fs::read(dba_path).expect("reading .dba");
    let db = starbreaker_3d::animation::parse_dba(&dba).expect("parsing .dba");
    let stem = |n: &str| n.rsplit('/').next().unwrap_or(n).trim_end_matches(".caf").to_string();
    let clip = db
        .clips
        .iter()
        .find(|c| stem(&c.name) == *clip_name)
        .expect("clip not in this database");

    // Use the crate's own sampler rather than reading the channels directly.
    // It takes the final frame and applies the CryEngine-to-Blender conversion
    // on both rotation and position -- `cry_xyzw_to_blender_wxyz` for the
    // quaternion and `[x, -z, y]` for the translation. Reading `kf.value` raw
    // and reshuffling it by hand got 16.8% agreement, with x and w matching
    // and y and z swapped: the signature of missing exactly this step.
    let by_hash: HashMap<u32, Sample> = starbreaker_3d::animation::pose::clip_final_pose(clip)
        .into_iter()
        .map(|(hash, bone)| {
            (
                hash,
                Sample { rotation: Some(bone.rotation), position: bone.position },
            )
        })
        .collect();
    let hash_of = |name: &str| {
        let mut h = crc32fast::Hasher::new();
        h.update(name.as_bytes());
        h.finalize()
    };

    let posed = forward_kinematics(&bind, |name| by_hash.get(&hash_of(name)).cloned());

    let golden: Value =
        serde_json::from_slice(&std::fs::read(golden_path).expect("poses.json")).expect("json");
    let want = &golden[key]["bones"];

    let (mut agree, mut total, mut worst) = (0usize, 0usize, (0.0f64, String::new()));
    let mut examples = Vec::new();
    for (name, got) in &posed {
        let Some(w) = want.get(name) else { continue };
        total += 1;
        let wd: Vec<f64> = w["delta"].as_array().unwrap().iter().filter_map(Value::as_f64).collect();
        // q and -q are the same rotation, so compare both signs.
        let diff = |flip: f64| -> f64 {
            (0..4)
                .map(|i| (got.delta[i] as f64 * flip - wd[i]).abs())
                .fold(0.0f64, f64::max)
        };
        let d = diff(1.0).min(diff(-1.0));
        if d <= TOLERANCE {
            agree += 1;
        } else {
            if d > worst.0 {
                worst = (d, name.clone());
            }
            if examples.len() < 6 {
                examples.push(format!(
                    "{name}: {:?} vs {:?}  (off by {d:.5})",
                    got.delta.map(|v| (v * 10000.0).round() / 10000.0),
                    wd.iter().map(|v| (v * 10000.0).round() / 10000.0).collect::<Vec<_>>()
                ));
            }
        }
    }

    println!("clip            {clip_name}");
    println!("bind bones      {}", bind.len());
    println!("animated        {} channels", clip.channels.len());
    println!(
        "\ndelta agreement {agree} of {total}  ({:.2}%)",
        agree as f64 / total.max(1) as f64 * 100.0
    );
    for e in &examples {
        println!("    {e}");
    }
    if !worst.1.is_empty() {
        println!("    worst: {} off by {:.5}", worst.1, worst.0);
    }
    println!(
        "\n{}",
        if agree == total {
            "PASS  the retarget reproduces the pipeline's pose exactly"
        } else {
            "see above"
        }
    );
}

fn quat(v: &Value) -> Quat {
    let a: Vec<f32> = v.as_array().map(|a| a.iter().filter_map(|x| x.as_f64()).map(|x| x as f32).collect()).unwrap_or_default();
    [a.first().copied().unwrap_or(1.0), a.get(1).copied().unwrap_or(0.0), a.get(2).copied().unwrap_or(0.0), a.get(3).copied().unwrap_or(0.0)]
}

fn vec3(v: &Value) -> Vec3 {
    let a: Vec<f32> = v.as_array().map(|a| a.iter().filter_map(|x| x.as_f64()).map(|x| x as f32).collect()).unwrap_or_default();
    [a.first().copied().unwrap_or(0.0), a.get(1).copied().unwrap_or(0.0), a.get(2).copied().unwrap_or(0.0)]
}
