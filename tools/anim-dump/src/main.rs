//! Dump a CryEngine skeleton's bind pose and a clip's final-frame pose.
//!
//!   anim-dump bind <file.chr>
//!   anim-dump list <file.dba>
//!   anim-dump pose <file.dba> <clip substring> [bone-names.json]
//!
//! Both commands emit rotations as Blender Z-up `wxyz`, the space
//! `clip_final_pose` already uses, so bind and clip can be compared directly.
//! Retargeting needs both: a clip stores absolute local rotations in the
//! animation rig's own bone frames, which are useless without the bind pose
//! they are relative to.

use std::collections::HashMap;
use std::env;
use std::fs;
use std::process::ExitCode;

use starbreaker_3d::animation::{
    bone_name_hash, clip_final_pose, cry_xyzw_to_blender_wxyz, parse_dba,
};
use starbreaker_3d::skeleton::parse_skeleton;

/// The crate stores skeleton quaternions as `[w, x, y, z]` in CryEngine axes;
/// the animation side is already Blender `wxyz`. Put them in the same space.
fn skeleton_quat_to_blender(q: [f32; 4]) -> [f32; 4] {
    let [w, x, y, z] = q;
    cry_xyzw_to_blender_wxyz([x, y, z, w])
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("bind") if args.len() >= 3 => bind(&args[2]),
        Some("list") if args.len() >= 3 => list(&args[2]),
        Some("pose") if args.len() >= 4 => pose(&args[2], &args[3], args.get(4).map(String::as_str)),
        _ => {
            eprintln!("usage: anim-dump bind <file.chr>");
            eprintln!("       anim-dump list <file.dba>");
            eprintln!("       anim-dump pose <file.dba> <clip> [bone-names.json]");
            ExitCode::from(2)
        }
    }
}

fn read(path: &str) -> Result<Vec<u8>, ExitCode> {
    fs::read(path).map_err(|e| {
        eprintln!("cannot read {path}: {e}");
        ExitCode::FAILURE
    })
}

fn bind(path: &str) -> ExitCode {
    let bytes = match read(path) {
        Ok(b) => b,
        Err(code) => return code,
    };
    let Some(bones) = parse_skeleton(&bytes) else {
        eprintln!("no skeleton block in {path}");
        return ExitCode::FAILURE;
    };
    eprintln!("{} bone(s)", bones.len());

    let out: Vec<_> = bones
        .iter()
        .map(|b| {
            serde_json::json!({
                "name": b.name,
                "parent": b.parent_index,
                "local_rotation": skeleton_quat_to_blender(b.local_rotation),
                "world_rotation": skeleton_quat_to_blender(b.world_rotation),
                "local_position": b.local_position,
                "world_position": b.world_position,
            })
        })
        .collect();
    println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
    ExitCode::SUCCESS
}

fn list(path: &str) -> ExitCode {
    let bytes = match read(path) {
        Ok(b) => b,
        Err(code) => return code,
    };
    match parse_dba(&bytes) {
        Ok(db) => {
            eprintln!("{} clip(s)", db.clips.len());
            for clip in &db.clips {
                println!("{}\t{} channel(s)", clip.name, clip.channels.len());
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("parse failed: {e}");
            ExitCode::FAILURE
        }
    }
}

fn pose(path: &str, wanted: &str, names_path: Option<&str>) -> ExitCode {
    let bytes = match read(path) {
        Ok(b) => b,
        Err(code) => return code,
    };
    let db = match parse_dba(&bytes) {
        Ok(db) => db,
        Err(e) => {
            eprintln!("parse failed: {e}");
            return ExitCode::FAILURE;
        }
    };

    let needle = wanted.to_ascii_lowercase();
    let Some(clip) = db
        .clips
        .iter()
        .find(|c| c.name.to_ascii_lowercase().contains(&needle))
    else {
        eprintln!("no clip matching {wanted:?}; try `list`");
        return ExitCode::FAILURE;
    };
    eprintln!("clip: {}", clip.name);

    // Bones are keyed by CRC32 of their name; recover names by hashing a known
    // bone list and matching.
    let mut by_hash: HashMap<u32, String> = HashMap::new();
    if let Some(p) = names_path {
        if let Ok(text) = fs::read_to_string(p) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                let names = value.get("bones").unwrap_or(&value);
                if let Some(list) = names.as_array() {
                    for entry in list {
                        if let Some(name) = entry.as_str() {
                            by_hash.insert(bone_name_hash(name), name.to_string());
                        }
                    }
                }
            }
        }
    }

    let mut out = serde_json::Map::new();
    let mut unresolved = 0usize;
    for (hash, bone) in clip_final_pose(clip) {
        let key = match by_hash.get(&hash) {
            Some(name) => name.clone(),
            None => {
                unresolved += 1;
                format!("#{hash:08x}")
            }
        };
        let mut entry = serde_json::Map::new();
        entry.insert("rotation".into(), serde_json::json!(bone.rotation));
        if let Some(position) = bone.position {
            entry.insert("position".into(), serde_json::json!(position));
        }
        out.insert(key, serde_json::Value::Object(entry));
    }
    eprintln!("{} bone(s), {unresolved} unresolved name(s)", out.len());
    println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
    ExitCode::SUCCESS
}
