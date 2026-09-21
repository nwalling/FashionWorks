//! Parse a `.skinm` and report what came out, for comparison with the GLB the
//! Python pipeline produced from the same mesh.
//!
//! WEB.md phase 2's exit criterion is that the reference sets render and pose
//! correctly, with bone lists and bounds matching the golden outputs. That
//! starts here: before any of it can be trusted, the parser has to agree with
//! the existing pipeline about how many vertices, triangles and material groups
//! a mesh has, and where it sits in space.
//!
//!   cargo run --example skin_probe --release -- <file.skinm> [more...]
//!
//! `.skinm` is the one to pass: CIG ships meshes split, with the `.skin`
//! carrying headers and the `.skinm` the vertex data -- the same split that
//! caught us on textures, where a `.dds` is only the smallest mip.

use starbreaker_3d::ivo::skin::SkinMesh;
use starbreaker_chunks::ChunkFile;

fn main() {
    let files: Vec<String> = std::env::args().skip(1).collect();
    if files.is_empty() {
        eprintln!("usage: skin_probe <file.skinm> [more...]");
        std::process::exit(2);
    }

    for path in &files {
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) => {
                println!("{path}: unreadable ({e})");
                continue;
            }
        };
        // The file is a chunk container, not a bare mesh: `SkinMesh::read`
        // wants one chunk's data. Handing it the whole file reads the container
        // header as mesh counts and asks for 148 GB.
        let chunk_file = match ChunkFile::from_bytes(&bytes) {
            Ok(c) => c,
            Err(e) => {
                println!("{}: not a chunk file: {e}", short(path));
                continue;
            }
        };
        let ChunkFile::Ivo(ivo) = &chunk_file else {
            println!("{}: not an Ivo container", short(path));
            continue;
        };
        // What chunks the file actually holds. The pair is split by role, not
        // by size, so knowing which half carries what decides where skinning
        // has to be read from.
        let kinds: Vec<String> = ivo
            .chunks()
            .iter()
            .map(|c| format!("{:#010x}({})", c.chunk_type, ivo.chunk_data(c).len()))
            .collect();
        println!("\n{}  ({} bytes)\n  chunks        {}", short(path), bytes.len(), kinds.join(" "));

        // The bones are in the *other* half. `.skin` carries EXPORT_FLAGS,
        // COMPILED_BONES, MTL_NAME and a mesh descriptor; `.skinm` carries the
        // vertex streams and nothing else. A port that reads only the file
        // StarBreaker's CLI takes -- the `.skinm` -- gets geometry with no
        // skeleton, which is the same shape of trap as a `.dds` holding only
        // its smallest mip.
        if let Some(bones_chunk) = ivo
            .chunks()
            .iter()
            .find(|c| c.chunk_type == starbreaker_chunks::known_types::ivo::COMPILED_BONES_IVO320)
        {
            // Whole file, not the chunk: `parse_skeleton` opens the container
            // itself and finds COMPILED_BONES. `SkinMesh::read` is the other
            // way round and wants the chunk. Easy to get backwards.
            let _ = bones_chunk;
            match starbreaker_3d::skeleton::parse_skeleton(&bytes) {
                Some(bones) => {
                    println!("  bones         {}", bones.len());
                    let names: Vec<&str> = bones.iter().take(6).map(|b| b.name.as_str()).collect();
                    println!("  first bones   {names:?}");
                    let overrides = bones.iter().filter(|b| b.name.ends_with("_override")).count();
                    println!("  attachment    {overrides} *_override bones");
                }
                None => println!("  bones         chunk present but did not parse"),
            }
        }

        let Some(entry) = ivo
            .chunks()
            .iter()
            .find(|c| c.chunk_type == starbreaker_chunks::known_types::ivo::IVO_SKIN2)
        else {
            println!("  (no IvoSkin2 chunk)");
            continue;
        };
        match SkinMesh::read(ivo.chunk_data(entry)) {
            Ok(mesh) => {
                report_body(&mesh);
                // Material names live in their own chunks, and their order is
                // the .mtl submaterial order the slot matching depends on.
                let names: Vec<String> = ivo
                    .chunks()
                    .iter()
                    .filter(|c| c.chunk_type == starbreaker_chunks::known_types::ivo::MTL_NAME_IVO320)
                    .filter_map(|c| starbreaker_3d::ivo::material::MaterialName::read(ivo.chunk_data(c)).ok())
                    .map(|m| m.name)
                    .collect();
                if !names.is_empty() {
                    println!("  mtl chunks    {names:?}");
                }
            }
            Err(e) => println!("{}: parse failed: {e}", short(path)),
        }
    }
}

fn short(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn report_body(mesh: &SkinMesh) {
    let info = &mesh.info;
    println!(
        "  vertices {:>7}   indices {:>7}   triangles {:>7}   submeshes {}",
        info.num_vertices,
        info.num_indices,
        info.num_indices / 3,
        info.num_submeshes
    );
    println!(
        "  model bounds  min [{:.3} {:.3} {:.3}]  max [{:.3} {:.3} {:.3}]",
        info.model_min[0], info.model_min[1], info.model_min[2],
        info.model_max[0], info.model_max[1], info.model_max[2],
    );
    let size = [
        info.model_max[0] - info.model_min[0],
        info.model_max[1] - info.model_min[1],
        info.model_max[2] - info.model_min[2],
    ];
    println!("  extent        {:.3} x {:.3} x {:.3} m", size[0], size[1], size[2]);

    let streams = &mesh.streams;
    println!(
        "  streams       uvs {}  indices {}  boneMaps {}  colors {}  normals {}  tangents {}  uv2 {}",
        streams.uvs.len(),
        streams.indices.len(),
        streams.bone_maps.as_ref().map_or(0, Vec::len),
        streams.colors.as_ref().map_or(0, Vec::len),
        streams.normals.is_some(),
        streams.tangents.is_some(),
        streams.secondary_uvs.is_some(),
    );

    // Material groups, which must line up with the .mtl's submaterial order --
    // getting this wrong is what painted a whole mesh with one submaterial.
    let mut mats: Vec<u16> = mesh.submeshes.iter().map(|s| s.mat_id).collect();
    mats.sort_unstable();
    mats.dedup();
    println!("  material ids  {mats:?}");

    // Skin weights are what make this worth parsing at all: StarBreaker's own
    // GLB writer drops them, which is why the Python pipeline has to route
    // through cgf-converter.
    if let Some(bone_maps) = &streams.bone_maps {
        let mut joints: Vec<u16> = bone_maps
            .iter()
            .flat_map(|b| b.joint_indices.iter().copied())
            .collect();
        joints.sort_unstable();
        joints.dedup();
        let unweighted = bone_maps
            .iter()
            .filter(|b| b.weights.iter().all(|&w| w == 0))
            .count();
        println!(
            "  skinning      {} distinct joints, {} of {} vertices unweighted",
            joints.len(),
            unweighted,
            bone_maps.len()
        );
    } else {
        println!("  skinning      none (rigid mesh)");
    }
}
