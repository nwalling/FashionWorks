//! Dump a mesh's UV0, vertex colour and material groups, for the decal spike.
//! RENDERING.md Phase 6.
//!
//! `IVOVERTSUVS` interleaves an RGBA colour with the UV, and the colour is
//! plainly structured. This writes what is needed to test whether it holds
//! decal-atlas coordinates -- which the analysis does outside, against the
//! atlas itself.
//!
//!   cargo run --example decal_probe --release -- <file.skinm> <out.json>

use starbreaker_3d::ivo::skin::SkinMesh;
use starbreaker_chunks::ChunkFile;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: decal_probe <file.skinm> <out.json>");
    let out = args.next().expect("out.json");
    let bytes = std::fs::read(&path).expect("reading mesh");
    let chunk_file = ChunkFile::from_bytes(&bytes).expect("chunk file");
    let ChunkFile::Ivo(ivo) = &chunk_file else { panic!("not an Ivo container") };
    let entry = ivo
        .chunks()
        .iter()
        .find(|c| c.chunk_type == starbreaker_chunks::known_types::ivo::IVO_SKIN2)
        .expect("IvoSkin2 chunk");
    let mesh = SkinMesh::read(ivo.chunk_data(entry)).expect("skin");
    let built = starbreaker_3d::types::build_mesh(&mesh, &[]);
    let uvs = built.uvs.clone().unwrap_or_default();
    let colors = built.colors.clone().unwrap_or_default();
    let submeshes: Vec<serde_json::Value> = built
        .submeshes
        .iter()
        .map(|s| serde_json::json!({ "material": s.material_id, "first": s.first_index, "count": s.num_indices }))
        .collect();
    let json = serde_json::json!({
        "positions": built.positions,
        "uvs": uvs,
        "colors": colors,
        "indices": built.indices,
        "submeshes": submeshes,
        "secondary_uvs": built.secondary_uvs.is_some(),
    });
    std::fs::write(&out, serde_json::to_vec(&json).unwrap()).expect("writing");
    println!("{} verts, {} colours, {} triangles, {} groups -> {out}", built.positions.len(), colors.len(), built.indices.len() / 3, built.submeshes.len());
}
