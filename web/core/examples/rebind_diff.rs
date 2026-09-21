//! Measure how much of a mesh's skin weight lands on bones the canonical
//! armature does not have.
//!
//! **A piece's joint list is not the base skeleton's.** One armour piece
//! exports 41 joints of which only 16 exist in the base, and the strays are of
//! two kinds: `*_override` equipment attachment points, which carry no weight,
//! and simulation chains (`CC_fabric_*`, `*_Skel_Sim`), which do. Dropping that
//! weight outright left 1080 of 30901 torso vertices unweighted, and Blender's
//! exporter then invented a `neutral_bone` and pinned that cloth to the origin.
//!
//! So the weight has to go somewhere, and this says how much there is to move
//! before any redistribution is written. The joint indices in the `.skinm` index
//! into the bone list in the `.skin`, so both halves are needed to name them.
//!
//!   cargo run --example rebind_diff --release -- <mesh.skin> <male.skeleton.json>

use std::collections::{HashMap, HashSet};

use serde_json::Value;
use starbreaker_3d::ivo::skin::SkinMesh;
use starbreaker_chunks::ChunkFile;

fn main() {
    let mut args = std::env::args().skip(1);
    let skin_path = args.next().expect("usage: rebind_diff <mesh.skin> <male.skeleton.json>");
    let golden_path = args.next().expect("male.skeleton.json");

    // The bone list lives in the .skin; the bone maps live beside it in .skinm.
    let skin_bytes = std::fs::read(&skin_path).expect("reading .skin");
    let bones = starbreaker_3d::skeleton::parse_skeleton(&skin_bytes)
        .expect("no CompiledBones in the .skin");
    let mesh_path = format!("{skin_path}m");
    let mesh_bytes = std::fs::read(&mesh_path).expect("reading .skinm beside it");

    let chunk_file = ChunkFile::from_bytes(&mesh_bytes).expect("chunk file");
    let ChunkFile::Ivo(ivo) = &chunk_file else { panic!("not an Ivo container") };
    let entry = ivo
        .chunks()
        .iter()
        .find(|c| c.chunk_type == starbreaker_chunks::known_types::ivo::IVO_SKIN2)
        .expect("no IvoSkin2 chunk");
    let mesh = SkinMesh::read(ivo.chunk_data(entry)).expect("parsing mesh");

    let golden: Value =
        serde_json::from_slice(&std::fs::read(&golden_path).expect("golden")).expect("json");
    let canonical: HashSet<&str> = golden["bones"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();

    let Some(maps) = &mesh.streams.bone_maps32 else {
        println!("{}: no eight-influence bone map", short(&skin_path));
        return;
    };

    let name_of = |j: u16| bones.get(j as usize).map(|b| b.name.as_str());

    let mut total_weight = 0u64;
    let mut stray_weight = 0u64;
    let mut stray_bones: HashMap<&str, u64> = HashMap::new();
    let mut vertices_all_stray = 0usize;
    let mut used: HashSet<u16> = HashSet::new();

    for m in maps {
        let mut vertex_total = 0u32;
        let mut vertex_stray = 0u32;
        for (joint, weight) in m.influences() {
            used.insert(joint);
            vertex_total += weight as u32;
            match name_of(joint) {
                Some(name) if canonical.contains(name) => {}
                Some(name) => {
                    vertex_stray += weight as u32;
                    *stray_bones.entry(name).or_default() += weight as u64;
                }
                None => {
                    vertex_stray += weight as u32;
                    *stray_bones.entry("<index out of range>").or_default() += weight as u64;
                }
            }
        }
        total_weight += vertex_total as u64;
        stray_weight += vertex_stray as u64;
        // These are the vertices that end up unweighted if stray weight is
        // simply dropped -- the ones that got pinned to the origin.
        if vertex_total > 0 && vertex_stray == vertex_total {
            vertices_all_stray += 1;
        }
    }

    let in_base = used.iter().filter(|j| name_of(**j).is_some_and(|n| canonical.contains(n))).count();
    println!("{}", short(&skin_path));
    println!("  bones in the .skin      {}", bones.len());
    println!("  joints the mesh uses    {} ({in_base} of them in the canonical armature)", used.len());
    println!(
        "  weight on stray bones   {:.2}% of {} vertices' total",
        stray_weight as f64 / total_weight.max(1) as f64 * 100.0,
        maps.len()
    );
    println!(
        "  vertices with *no* surviving bone   {vertices_all_stray}  <- these need a guess, the rest can renormalise"
    );

    // Now actually redistribute, and check the two things that matter: no
    // vertex is left unweighted, and every vertex still sums to 255.
    let survives = |j: u16| name_of(j).is_some_and(|n| canonical.contains(n));
    let mut busiest: HashMap<u16, u64> = HashMap::new();
    for m in maps {
        for (joint, weight) in m.influences() {
            if survives(joint) {
                *busiest.entry(joint).or_default() += weight as u64;
            }
        }
    }
    let dominant = busiest.iter().max_by_key(|(_, w)| **w).map(|(j, _)| *j).unwrap_or(0);
    let candidates: Vec<(u16, &str)> = busiest
        .keys()
        .filter_map(|j| name_of(*j).map(|n| (*j, n)))
        .collect();

    let mut guessed = 0usize;
    let mut bad_sum = 0usize;
    let mut unweighted_after = 0usize;
    let mut side_landings: HashMap<&str, (usize, usize)> = HashMap::new();
    for m in maps {
        let influences: fashionworks_core::rebind::Influences = m.influences().collect();
        if influences.is_empty() {
            continue;
        }
        let out = match fashionworks_core::rebind::redistribute(&influences, survives) {
            Some(out) => out,
            None => {
                guessed += 1;
                let names: Vec<&str> = influences.iter().filter_map(|(j, _)| name_of(*j)).collect();
                let joint = fashionworks_core::rebind::guess_bone(&names, &candidates, &busiest, dominant);
                if let Some(from) = names.first() {
                    use fashionworks_core::rebind::side_of;
                    let want = side_of(from);
                    let got = name_of(joint).and_then(side_of);
                    if want.is_some() {
                        let entry = side_landings.entry(*from).or_insert((0, 0));
                        if want == got { entry.0 += 1 } else { entry.1 += 1 }
                    }
                }
                vec![(joint, 255u8)]
            }
        };
        let sum: u32 = out.iter().map(|(_, w)| *w as u32).sum();
        if sum != 255 {
            bad_sum += 1;
        }
        if out.is_empty() {
            unweighted_after += 1;
        }
    }
    println!(
        "  after redistribution    {guessed} vertices guessed, {unweighted_after} unweighted, {bad_sum} not summing to 255"
    );
    // The check that matters for the guess: a left shoulder pad must land on a
    // left bone. Sending it to one dominant bone per mesh is what flung the
    // Antium left shoulder across the body.
    if !side_landings.is_empty() {
        let mut rows: Vec<(&&str, &(usize, usize))> = side_landings.iter().collect();
        rows.sort_by_key(|(n, _)| **n);
        println!("  guessed vertices by the side they came from:");
        for (from, (same, crossed)) in rows {
            println!("    {from:<30} {same} stayed on that side, {crossed} crossed over");
        }
    }
    println!("  dominant bone           {:?}", name_of(dominant));

    let mut worst: Vec<(&&str, &u64)> = stray_bones.iter().collect();
    worst.sort_by_key(|(_, w)| std::cmp::Reverse(**w));
    if !worst.is_empty() {
        println!("  stray bones by weight:");
        for (name, w) in worst.iter().take(8) {
            println!("    {name:<38} {:.2}%", **w as f64 / total_weight.max(1) as f64 * 100.0);
        }
    }
}

fn short(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}
