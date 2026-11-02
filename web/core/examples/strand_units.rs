//! What unit a hair card's vertex red counts in, and how long the strands
//! are. CHARACTER.md reads red as the step along the card, "about 2 mm"; a
//! `DyeShift` or `DyeFadeout` measured along the strand would need the exact
//! unit to be read at all.
//!
//! Cards are the mesh's connected pieces. On each, the vertices sharing a red
//! value form a row across the card; the distance walked from the root row
//! (red 0) through the rows' centres, in metres, is set against red.
//!
//!   cargo run --example strand_units --release -- <file.skinm>...

use starbreaker_3d::ivo::skin::SkinMesh;
use starbreaker_chunks::ChunkFile;
use std::collections::BTreeMap;

fn main() {
    for path in std::env::args().skip(1) {
        let bytes = std::fs::read(&path).expect("read");
        let ChunkFile::Ivo(ivo) = ChunkFile::from_bytes(&bytes).expect("chunk file") else { panic!("not ivo") };
        let entry = ivo
            .chunks()
            .iter()
            .find(|c| c.chunk_type == starbreaker_chunks::known_types::ivo::IVO_SKIN2)
            .expect("skin chunk");
        let mesh = SkinMesh::read(ivo.chunk_data(entry)).expect("parse");
        let built = starbreaker_3d::types::build_mesh(&mesh, &[]);
        let Some(colors) = built.colors.as_ref() else { println!("{path}: no colour"); continue };
        let name = path.rsplit('/').next().unwrap_or(&path);
        println!("{name}: {} vertices, {} submeshes", built.positions.len(), built.submeshes.len());

        for (s, sub) in built.submeshes.iter().enumerate() {
            let range = sub.first_index as usize..(sub.first_index + sub.num_indices) as usize;
            let tris = &built.indices[range];
            let mut parent: BTreeMap<u32, u32> = BTreeMap::new();
            fn find(p: &mut BTreeMap<u32, u32>, x: u32) -> u32 {
                let mut r = x;
                while p[&r] != r { r = p[&r]; }
                let mut c = x;
                while p[&c] != r { let n = p[&c]; p.insert(c, r); c = n; }
                r
            }
            for &v in tris { parent.entry(v).or_insert(v); }
            for t in tris.chunks(3) {
                let a = find(&mut parent, t[0]);
                for &v in &t[1..] {
                    let b = find(&mut parent, v);
                    if a != b { parent.insert(b, a); }
                }
            }
            let verts: Vec<u32> = parent.keys().copied().collect();
            let mut cards: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
            for v in verts { let r = find(&mut parent, v); cards.entry(r).or_default().push(v); }

            // Per card: rows by red, their centres, the walk from red 0.
            let mut slopes = Vec::new();
            let mut lengths = Vec::new();
            let mut peaks = Vec::new();
            let mut counting = 0usize;
            // Card length by where the card's root sits: out from the midline,
            // and height, in centimetre bands.
            let mut by_place: BTreeMap<(i32, i32), Vec<f64>> = BTreeMap::new();
            for vs in cards.values() {
                let mut rows: BTreeMap<u8, ([f64; 3], f64)> = BTreeMap::new();
                for &v in vs {
                    let p = built.positions[v as usize];
                    let e = rows.entry(colors[v as usize][0]).or_insert(([0.0; 3], 0.0));
                    for k in 0..3 { e.0[k] += f64::from(p[k]); }
                    e.1 += 1.0;
                }
                if rows.len() < 2 || *rows.keys().next().unwrap() != 0 { continue }
                counting += 1;
                let centres: Vec<(f64, [f64; 3])> =
                    rows.iter().map(|(r, (c, n))| (f64::from(*r), [c[0] / n, c[1] / n, c[2] / n])).collect();
                let mut walked = 0.0;
                let (mut sxy, mut sxx) = (0.0, 0.0);
                for w in centres.windows(2) {
                    let d = ((w[1].1[0] - w[0].1[0]).powi(2) + (w[1].1[1] - w[0].1[1]).powi(2) + (w[1].1[2] - w[0].1[2]).powi(2)).sqrt();
                    walked += d;
                    // Red against metres walked, through the origin.
                    sxy += w[1].0 * walked;
                    sxx += walked * walked;
                }
                if sxx > 0.0 { slopes.push(sxy / sxx); }
                let root = centres[0].1;
                by_place
                    .entry(((root[0].abs() * 100.0 / 2.0) as i32 * 2, (root[2] * 100.0 / 2.0).floor() as i32 * 2))
                    .or_default()
                    .push(walked);
                lengths.push(walked);
                peaks.push(centres.last().unwrap().0);
            }
            let q = |v: &mut Vec<f64>, p: f64| {
                v.sort_by(|a, b| a.partial_cmp(b).unwrap());
                if v.is_empty() { f64::NAN } else { v[((v.len() - 1) as f64 * p).round() as usize] }
            };
            println!(
                "  submesh {s} (material {}): {} cards, {} counting from 0",
                sub.material_id,
                cards.len(),
                counting
            );
            if counting == 0 { continue }
            println!(
                "    red per metre p10/50/90: {:.1} {:.1} {:.1}",
                q(&mut slopes, 0.1), q(&mut slopes, 0.5), q(&mut slopes, 0.9)
            );
            println!(
                "    card length (m) p10/50/90/max: {:.4} {:.4} {:.4} {:.4}",
                q(&mut lengths, 0.1), q(&mut lengths, 0.5), q(&mut lengths, 0.9), q(&mut lengths, 1.0)
            );
            println!(
                "    red at the tip p10/50/90/max: {:.0} {:.0} {:.0} {:.0}",
                q(&mut peaks, 0.1), q(&mut peaks, 0.5), q(&mut peaks, 0.9), q(&mut peaks, 1.0)
            );
            if std::env::var_os("BY_PLACE").is_some() {
                println!("    median length (mm) by |x| band (cols, cm) and height band (rows, cm):");
                let xs: std::collections::BTreeSet<i32> = by_place.keys().map(|k| k.0).collect();
                let zs: std::collections::BTreeSet<i32> = by_place.keys().map(|k| k.1).collect();
                println!("      z\\x {}", xs.iter().map(|x| format!("{x:>6}")).collect::<String>());
                for z in zs.iter().rev() {
                    let row: String = xs
                        .iter()
                        .map(|x| match by_place.get_mut(&(*x, *z)) {
                            Some(v) if v.len() >= 5 => format!("{:>6.1}", q(v, 0.5) * 1000.0),
                            _ => format!("{:>6}", "."),
                        })
                        .collect();
                    println!("      {z:>3} {row}");
                }
            }
        }
    }
}
