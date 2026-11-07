//! Which submaterial each group of a mesh was painted for, by its vertex
//! colour's alpha (255 minus the submaterial index), against the material id
//! the group carries -- and whether its colours are decal coordinates.
//!
//!   cargo run --release --example material_alpha -- <file.skinm> [more...]
use fashionworks_core::mesh;
use starbreaker_3d::ivo::skin::SkinMesh;
use starbreaker_chunks::ChunkFile;
use std::collections::BTreeMap;

fn main() {
    for path in std::env::args().skip(1) {
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let Ok(ChunkFile::Ivo(ivo)) = ChunkFile::from_bytes(&bytes) else { continue };
        let Some(entry) = ivo
            .chunks()
            .iter()
            .find(|c| c.chunk_type == starbreaker_chunks::known_types::ivo::IVO_SKIN2)
        else {
            continue;
        };
        let Ok(skin) = SkinMesh::read(ivo.chunk_data(entry)) else { continue };
        println!("{}", path.rsplit('/').next().unwrap_or(&path));
        let Some(colors) = skin.streams.colors.as_ref() else {
            println!("  no colours");
            continue;
        };
        for s in &skin.submeshes {
            let range = s.first_vertex as usize..(s.first_vertex + s.num_vertices) as usize;
            let mut alphas: BTreeMap<u8, usize> = BTreeMap::new();
            let mut decal = 0usize;
            let (mut umin, mut umax, mut vmin, mut vmax) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
            for c in &colors[range.clone()] {
                *alphas.entry(c[3]).or_default() += 1;
                if mesh::is_decal_coordinate(*c) {
                    let [u, v] = mesh::decal_uv(*c);
                    if u > 0.02 || v > 0.02 {
                        decal += 1;
                        umin = umin.min(u);
                        umax = umax.max(u);
                        vmin = vmin.min(v);
                        vmax = vmax.max(v);
                    }
                }
            }
            let painted: Vec<String> = alphas.iter().map(|(a, n)| format!("{}:{n}", 255 - *a as i32)).collect();
            let sheet = if decal > 0 { format!(" decal uv u {umin:.3}-{umax:.3} v {vmin:.3}-{vmax:.3}") } else { String::new() };
            println!(
                "  id {:>2}  verts {:>6}  painted for {}  decal coords {decal}{sheet}",
                s.mat_id,
                s.num_vertices,
                painted.join(" ")
            );
        }
    }
}
