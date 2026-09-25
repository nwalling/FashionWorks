//! What a `.chf` wears and how it is coloured, resolved against a DataCore.
//! CHARACTER.md Phases 2 and 3.
//!
//!   cargo run --release --example character_looks -- <Game2.dcb> <file.chf>...
//!
//! For each file: the head material its GUID resolves to, its skin, iris and
//! hair colours, and every item in its port tree with the mesh and material it
//! puts on the file's own body. An item the library does not know, or one with
//! no mesh for the body, is reported rather than skipped: that is the case the
//! viewer has to handle.

use fashionworks_core::{appearance, catalog::db, character};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let bytes = std::fs::read(&args[0]).expect("reading Game2.dcb");
    let database = db::open(&bytes).expect("parsing DataCore");
    let started = std::time::Instant::now();
    let library = appearance::Library::build(&database);
    println!(
        "library: {} materials, {} textures, {} head items, built in {:?}",
        library.materials.len(),
        library.textures.len(),
        library.items.len(),
        started.elapsed()
    );
    let hex = |c: &[f32]| {
        let s = |v: f32| {
            let v = v.clamp(0.0, 1.0);
            let e = if v <= 0.003_130_8 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 };
            (e * 255.0).round() as u8
        };
        format!("#{:02x}{:02x}{:02x}", s(c[0]), s(c[1]), s(c[2]))
    };

    for path in &args[1..] {
        let chf = std::fs::read(path).expect("reading .chf");
        let short = std::path::Path::new(path).file_stem().and_then(|s| s.to_str()).unwrap_or(path);
        let face = match character::read_chf(&chf) {
            Ok(face) => face,
            Err(e) => {
                println!("{short}: {e}");
                continue;
            }
        };
        let body = if face.is_female() { "Female" } else { "Male" };
        let looks = &face.looks;
        let material = looks.head_material.as_deref().map(|g| library.material(g).unwrap_or("(not in the table)"));
        println!("{short}: {body}, head material {}", material.unwrap_or("(none)"));
        println!(
            "  skin {}  iris {}",
            looks.skin.map(|c| hex(&c)).unwrap_or_default(),
            looks.iris.map(|c| hex(&c)).unwrap_or_default()
        );
        for (name, params) in [("hair", &looks.hair), ("beard", &looks.beard), ("brows", &looks.eyebrows)] {
            let text: Vec<String> = params
                .iter()
                .map(|(k, v)| if v.len() == 3 { format!("{k} {}", hex(v)) } else { format!("{k} {:.3}", v[0]) })
                .collect();
            println!("  {name}: {}", text.join(", "));
        }
        let asserted: Vec<String> = face
            .items
            .iter()
            .filter_map(|(_, guid)| library.item(guid))
            .flat_map(|item| item.asserts.iter().cloned())
            .collect();
        for (port, guid) in &face.items {
            match library.item(guid) {
                None => println!("  {port}: {guid} is not a head item"),
                Some(item) => match item.worn(body, &asserted) {
                    Some(worn) => {
                        let variants: Vec<String> = worn
                            .variants
                            .iter()
                            .map(|(tag, mesh, _)| format!("{tag}{}", if mesh.is_some() { "" } else { " (none)" }))
                            .collect();
                        println!(
                            "  {port}: {} [{}] {} | {}{}",
                            item.class_name,
                            item.kind,
                            worn.mesh.rsplit('/').next().unwrap_or(&worn.mesh),
                            worn.material.as_deref().map(|m| m.rsplit('/').next().unwrap_or(m)).unwrap_or("(beside the mesh)"),
                            if variants.is_empty() { String::new() } else { format!(" | variants {}", variants.join(", ")) }
                        );
                    }
                    None => println!("  {port}: {} [{}] has no mesh for {body}", item.class_name, item.kind),
                },
            }
        }
    }
}
