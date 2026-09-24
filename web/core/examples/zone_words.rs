//! Each mesh's zone table: the sorted 32-bit words after the submesh list,
//! and which word each submesh uses. CLOTHING.md Phase 0.
//!
//! A character mesh is split into zone submeshes (`torso01_zone`,
//! `l_arm03_zone`, ...), the units `SCItemClothingParams.Chunks` hides and
//! shows. The mesh does not name them: it carries one 32-bit word per zone,
//! sorted, and each submesh's `node_parent_index` indexes that table. This
//! dumps both for every `.skinm` given, for the mapping to names to be solved
//! against the DataCore outside.
//!
//!   cargo run --example zone_words --release -- <out.json> <a.skinm> [...]

use starbreaker_3d::ivo::skin::SkinMesh;
use starbreaker_chunks::ChunkFile;

fn main() {
    let mut args = std::env::args().skip(1);
    let out = args.next().expect("usage: zone_words <out.json> <file.skinm>...");
    let mut rows = Vec::new();
    for path in args {
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let Ok(ChunkFile::Ivo(ivo)) = ChunkFile::from_bytes(&bytes) else { continue };
        let Some(entry) = ivo
            .chunks()
            .iter()
            .find(|c| c.chunk_type == starbreaker_chunks::known_types::ivo::IVO_SKIN2)
        else {
            continue;
        };
        let Ok(mesh) = SkinMesh::read(ivo.chunk_data(entry)) else { continue };
        let submeshes: Vec<serde_json::Value> = mesh
            .submeshes
            .iter()
            .map(|s| {
                serde_json::json!({
                    "word": s.node_parent_index,
                    "first_vertex": s.first_vertex,
                    "vertices": s.num_vertices,
                    "center": s.center,
                    "radius": s.radius,
                })
            })
            .collect();
        rows.push(serde_json::json!({ "path": path, "words": mesh.extra_words, "submeshes": submeshes }));
    }
    std::fs::write(&out, serde_json::to_vec(&rows).unwrap()).expect("writing");
    println!("{} meshes -> {out}", rows.len());
}
