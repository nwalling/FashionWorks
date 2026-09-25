//! Blend a `.chf`'s face from extracted library heads, and check it.
//! CHARACTER.md Phase 0.
//!
//!   cargo run --release --example character_probe -- <heads dir> <head .dna> <file.chf>... [--obj <dir>]
//!
//! `<heads dir>` is an extraction of `Objects/Characters/Human/heads/`, and the
//! `.dna` the protos head's (an extracted copy, read whole). For each `.chf`
//! it says which library heads the face draws on and which it could not find,
//! how far the blend moves the protos head, and -- for a character that is one
//! library head throughout, as `Macken.chf` is `macken_t2` -- how far the blend
//! lands from that head's own mesh, which must be nothing. With `--obj` it
//! writes the blended head as an `.obj` for looking at.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use fashionworks_core::{character, mesh};

fn find_files(dir: &Path, out: &mut HashMap<String, PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("reading the heads directory").flatten() {
        let path = entry.path();
        if path.is_dir() {
            find_files(&path, out);
        } else if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            out.entry(name.to_ascii_lowercase()).or_insert(path);
        }
    }
}

fn shape(files: &HashMap<String, PathBuf>, file: &str) -> Option<(Vec<f32>, Vec<f32>, Vec<u32>)> {
    let skin = std::fs::read(files.get(&file.to_ascii_lowercase())?).ok()?;
    let skinm = std::fs::read(files.get(&format!("{}m", file.to_ascii_lowercase()))?).ok()?;
    let loaded = mesh::load(&skin, &skinm).ok()?;
    Some((loaded.positions, loaded.normals, loaded.indices))
}

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let obj_dir = args.iter().position(|a| a == "--obj").map(|at| {
        let dir = args.get(at + 1).cloned().expect("--obj <dir>");
        args.drain(at..=at + 1);
        dir
    });
    let heads_dir = PathBuf::from(&args[0]);
    let dna = std::fs::read(&args[1]).expect("reading the .dna");
    let mut library = character::DnaLibrary::read(&dna).expect("reading the DNA library");
    let mut files = HashMap::new();
    find_files(&heads_dir, &mut files);
    let protos_name = library.heads[0].clone();
    let protos_shape = shape(&files, &format!("{protos_name}_head.skin")).expect("the protos head mesh");
    library.weld(&protos_shape.0);
    let passes = std::env::var("SMOOTH").ok().and_then(|v| v.parse().ok()).unwrap_or(2);
    library.smooth(&protos_shape.2, &protos_shape.0, passes);
    println!(
        "library: {} heads, {} parts, {} vertices; {} files under {}",
        library.heads.len(),
        library.parts,
        library.vertices,
        files.len(),
        heads_dir.display()
    );

    for chf_path in &args[2..] {
        let bytes = std::fs::read(chf_path).expect("reading the .chf");
        let face = match character::read_chf(&bytes) {
            Ok(face) => face,
            Err(e) => {
                println!("{chf_path}: {e}");
                continue;
            }
        };
        let mut shapes: HashMap<u16, (Vec<f32>, Vec<f32>, Vec<u32>)> = HashMap::new();
        let mut missing = Vec::new();
        let mut ids = face.heads();
        ids.insert(0);
        for id in ids {
            let name = &library.heads[usize::from(id)];
            match shape(&files, &format!("{name}_head.skin")) {
                Some(s) if s.0.len() == library.vertices * 3 => {
                    shapes.insert(id, s);
                }
                _ => missing.push(name.clone()),
            }
        }
        let positions = character::blend_head(&face, &library, 3, &|id| shapes.get(&id).map(|s| &s.0[..]));
        let protos = &shapes[&0].0;
        let moved: Vec<f32> = (0..library.vertices)
            .map(|v| {
                let d: f32 = (0..3).map(|c| (positions[v * 3 + c] - protos[v * 3 + c]).powi(2)).sum();
                d.sqrt()
            })
            .collect();
        // Seam copies: points the protos head holds twice must stay one point.
        let mut seams: HashMap<[u32; 3], Vec<usize>> = HashMap::new();
        for v in 0..library.vertices {
            seams.entry([protos[v * 3].to_bits(), protos[v * 3 + 1].to_bits(), protos[v * 3 + 2].to_bits()]).or_default().push(v);
        }
        let crack = seams
            .values()
            .filter(|g| g.len() > 1)
            .flat_map(|g| g.iter().flat_map(move |&a| g.iter().map(move |&b| (a, b))))
            .map(|(a, b)| (0..3).map(|c| (positions[a * 3 + c] - positions[b * 3 + c]).abs()).fold(0.0f32, f32::max))
            .fold(0.0f32, f32::max);
        let mean = moved.iter().sum::<f32>() / moved.len() as f32;
        let max = moved.iter().cloned().fold(0.0f32, f32::max);
        let short = Path::new(chf_path).file_stem().and_then(|s| s.to_str()).unwrap_or(chf_path);
        println!(
            "{short}: {} heads, {} parts, moved from protos mean {:.2} mm, max {:.1} mm, widest seam {:.4} mm{}",
            face.heads().len(),
            face.parts.len(),
            mean * 1000.0,
            max * 1000.0,
            crack * 1000.0,
            if missing.is_empty() { String::new() } else { format!("; no mesh for {}", missing.join(", ")) }
        );

        // One head throughout: the blend must be that head's mesh.
        let only = face.heads();
        if only.len() == 1 {
            let id = *only.iter().next().expect("one head");
            if let Some(own) = shapes.get(&id) {
                let off = (0..library.vertices)
                    .map(|v| (0..3).map(|c| (positions[v * 3 + c] - own.0[v * 3 + c]).abs()).fold(0.0f32, f32::max))
                    .fold(0.0f32, f32::max);
                println!("  one head, {}: blend differs from its own mesh by at most {:.6} mm", library.heads[usize::from(id)], off * 1000.0);
            }
        }

        if let Some(dir) = &obj_dir {
            let indices = &shapes[&0].2;
            let mut text = String::new();
            for v in positions.chunks_exact(3) {
                text.push_str(&format!("v {} {} {}\n", v[0], v[1], v[2]));
            }
            for t in indices.chunks_exact(3) {
                text.push_str(&format!("f {} {} {}\n", t[0] + 1, t[1] + 1, t[2] + 1));
            }
            std::fs::write(format!("{dir}/{short}.obj"), text).expect("writing .obj");
        }
    }
}
