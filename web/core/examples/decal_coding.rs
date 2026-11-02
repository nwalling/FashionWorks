//! Which character meshes carry decal coordinates in their vertex colour, and
//! which carry something else there.
//!
//! A decal mesh's colour is a second UV set (`mesh::decal_uv`): red 160 and up,
//! green's low nibble 2-5. The Clash Arms' colour is not -- red sits at 17-30 --
//! and decoded anyway it lands 2.25 sheets to the left of the decal sheet,
//! where the sheet's repeat wrapping brings it back onto painted stickers.
//!
//!   cargo run --release --example decal_coding -- <Data.p4k> [path prefix]
//!
//! Prints, per LOD0 mesh with decal UVs whose colour is partly another
//! scheme, how much is in the encoding and the commonest colours outside it
//! -- those vertices now sample the neutral corner -- then a summary. 2,783
//! of 5,253 such meshes in 4.10.2 are partly another scheme, 402 of them LOD0.
use fashionworks_core::mesh;
use starbreaker_p4k::MappedP4k;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: decal_coding <Data.p4k> [prefix]");
    let prefix = args.next().unwrap_or_else(|| "Data\\Objects\\Characters\\Human\\".to_string()).to_ascii_lowercase();
    let p4k = MappedP4k::open(&path).expect("archive");
    let mut skins: Vec<&str> = p4k
        .entries()
        .iter()
        .map(|e| e.name.as_str())
        .filter(|n| n.to_ascii_lowercase().starts_with(&prefix) && n.to_ascii_lowercase().ends_with(".skin"))
        .collect();
    skins.sort();
    let (mut meshes, mut decoded, mut foreign, mut mixed) = (0, 0, 0, 0);
    for skin in skins {
        let Some(skinm) = p4k.entry(&format!("{skin}m")) else { continue };
        let (Ok(a), Ok(b)) = (p4k.read_file(skin), p4k.read(skinm)) else { continue };
        let Ok(loaded) = mesh::load(&a, &b) else { continue };
        meshes += 1;
        let colours: Vec<[u8; 4]> = loaded.colors.chunks_exact(4).map(|c| [c[0], c[1], c[2], c[3]]).collect();
        let coded = colours.iter().filter(|c| mesh::is_decal_coordinate(**c)).count();
        let share = coded as f64 / colours.len().max(1) as f64;
        // Vertices that place a decal: in the encoding and off the neutral red.
        let placed = colours.iter().filter(|c| mesh::is_decal_coordinate(**c) && c[0] >= mesh::DECAL_R_MIN).count();
        if loaded.decal_uvs.is_empty() {
            assert_eq!(placed, 0, "{skin} places decals and got no UVs");
            continue;
        }
        decoded += 1;
        if share < 0.5 {
            foreign += 1;
        } else if share < 0.999 {
            mixed += 1;
        }
        if share < 0.999 && !skin.to_ascii_lowercase().contains("_lod") {
            // The commonest colours outside the encoding, red and green's low
            // nibble being what puts them there.
            let mut strays: std::collections::HashMap<(u8, u8), usize> = Default::default();
            for c in colours.iter().filter(|c| !mesh::is_decal_coordinate(**c)) {
                *strays.entry((c[0], c[1] & 15)).or_default() += 1;
            }
            let mut strays: Vec<_> = strays.into_iter().collect();
            strays.sort_by(|a, b| b.1.cmp(&a.1));
            strays.truncate(4);
            println!("{:6.1}% coded  {:>6} verts  {}  strays (r, g&15): {:?}", share * 100.0, colours.len(), skin, strays);
        }
    }
    println!("{meshes} meshes, {decoded} decoded as decal UVs: {foreign} mostly not in the encoding, {mixed} partly");
}
