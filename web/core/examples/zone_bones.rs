//! Each zone of a mesh, and the attachment point nearest it.
//!
//! A zone that answers to a port -- the Morozov-SH-I Stronghold's six magazine
//! pouches, each off while a magazine is in `magazine_attach_N` -- is named by
//! the port it sits on. The mesh carries its own `*_override` bones, and a
//! pouch's submesh lies against the one it holds.
//!
//!   cargo run --example zone_bones --release -- <file.skin> <file.skinm>

use starbreaker_3d::ivo::skin::SkinMesh;
use starbreaker_chunks::ChunkFile;

fn main() {
    let mut args = std::env::args().skip(1);
    let skin = args.next().expect("usage: zone_bones <file.skin> <file.skinm>");
    let skinm = args.next().expect("the .skinm beside it");
    let bones = starbreaker_3d::skeleton::parse_skeleton(&std::fs::read(&skin).expect("reading .skin"))
        .expect("parsing its skeleton");
    let points: Vec<&starbreaker_3d::skeleton::Bone> = bones.iter().filter(|b| b.name.ends_with("_override")).collect();

    let bytes = std::fs::read(&skinm).expect("reading .skinm");
    let Ok(ChunkFile::Ivo(ivo)) = ChunkFile::from_bytes(&bytes) else { panic!("not an IVO mesh") };
    let entry = ivo
        .chunks()
        .iter()
        .find(|c| c.chunk_type == starbreaker_chunks::known_types::ivo::IVO_SKIN2)
        .expect("no skin chunk");
    let mesh = SkinMesh::read(ivo.chunk_data(entry)).expect("reading the mesh");
    for s in &mesh.submeshes {
        let word = mesh.extra_words.get(usize::from(s.node_parent_index)).copied();
        let c = s.center;
        let nearest = points
            .iter()
            .map(|b| {
                let p = b.world_position;
                let d = ((p[0] - c[0]).powi(2) + (p[1] - c[1]).powi(2) + (p[2] - c[2]).powi(2)).sqrt();
                (d, b.name.as_str())
            })
            .min_by(|a, b| a.0.total_cmp(&b.0));
        println!(
            "{:>10} {:>6} verts at ({:+.3}, {:+.3}, {:+.3})  nearest {:?}",
            word.map(|w| w.to_string()).unwrap_or_else(|| "-".into()),
            s.num_vertices,
            c[0],
            c[1],
            c[2],
            nearest.map(|(d, n)| format!("{n} {:.3} m", d)),
        );
    }
}
