//! What a hair mesh carries beyond position and UV: its vertex colour and
//! second UV set, per channel, and how each relates to where the vertex sits
//! -- along its card (UV v) and out from the skin (distance from the mesh's
//! innermost layer, approximated by the nearest vertex of the lowest decile
//! of radial distance from the bounding-box centre).
//!
//!   cargo run --example hair_streams --release -- <file.skinm>

use starbreaker_3d::ivo::skin::SkinMesh;
use starbreaker_chunks::ChunkFile;

fn main() {
    let path = std::env::args().nth(1).expect("usage: hair_streams <file.skinm>");
    let bytes = std::fs::read(&path).expect("read");
    let ChunkFile::Ivo(ivo) = ChunkFile::from_bytes(&bytes).expect("chunk file") else { panic!("not ivo") };
    let entry = ivo
        .chunks()
        .iter()
        .find(|c| c.chunk_type == starbreaker_chunks::known_types::ivo::IVO_SKIN2)
        .expect("skin chunk");
    let mesh = SkinMesh::read(ivo.chunk_data(entry)).expect("parse");
    let built = starbreaker_3d::types::build_mesh(&mesh, &[]);
    let n = built.positions.len();
    let colors = built.colors.clone().unwrap_or_default();
    let uv = built.uvs.clone().unwrap_or_default();
    let uv2 = built.secondary_uvs.clone().unwrap_or_default();

    for (name, get) in [
        ("R", 0usize), ("G", 1), ("B", 2), ("A", 3),
    ] {
        if colors.is_empty() { break; }
        let v: Vec<f64> = colors.iter().map(|c| f64::from(c[get])).collect();
        println!("colour {name}: {}", stats(&v));
    }
    for axis in 0..2 {
        if uv2.is_empty() { break; }
        let v: Vec<f64> = uv2.iter().map(|c| f64::from(c[axis])).collect();
        println!("uv2 {}: {}", ["u", "v"][axis], stats(&v));
    }

    // Distance out from the skin: the beard's inner surface is where its
    // cards root. Radial distance from a point behind the face is a crude
    // proxy; the lowest decile of it per angular bin stands in for the skin.
    let mut lo = [f32::MAX; 3];
    let mut hi = [f32::MIN; 3];
    for p in &built.positions {
        for i in 0..3 {
            lo[i] = lo[i].min(p[i]);
            hi[i] = hi[i].max(p[i]);
        }
    }
    // Archive frame is Z-up, face toward -Y... take the centre well behind the face.
    let centre = [(lo[0] + hi[0]) / 2.0, hi[1] + 0.05, (lo[2] + hi[2]) / 2.0 + 0.03];
    let radial: Vec<f64> = built
        .positions
        .iter()
        .map(|p| f64::from(((p[0] - centre[0]).powi(2) + (p[1] - centre[1]).powi(2) + (p[2] - centre[2]).powi(2)).sqrt()))
        .collect();
    let bins = 24;
    let bin_of = |p: &[f32; 3]| {
        let a = (p[0] - centre[0]).atan2(p[1] - centre[1]);
        let e = (p[2] - centre[2]).atan2(((p[0] - centre[0]).powi(2) + (p[1] - centre[1]).powi(2)).sqrt());
        let ai = (((a + std::f32::consts::PI) / (2.0 * std::f32::consts::PI)) * bins as f32) as usize;
        let ei = (((e + std::f32::consts::FRAC_PI_2) / std::f32::consts::PI) * bins as f32) as usize;
        ai.min(bins - 1) * bins + ei.min(bins - 1)
    };
    let mut per: Vec<Vec<f64>> = vec![Vec::new(); bins * bins];
    for (i, p) in built.positions.iter().enumerate() {
        per[bin_of(p)].push(radial[i]);
    }
    let floor: Vec<f64> = per
        .iter_mut()
        .map(|v| {
            if v.is_empty() { return 0.0; }
            v.sort_by(|a, b| a.partial_cmp(b).unwrap());
            v[v.len() / 10]
        })
        .collect();
    let depth: Vec<f64> = built.positions.iter().enumerate().map(|(i, p)| radial[i] - floor[bin_of(p)]).collect();
    println!("height above inner layer (m): {}", stats(&depth));

    let v: Vec<f64> = uv.iter().map(|c| f64::from(c[1])).collect();
    let u: Vec<f64> = uv.iter().map(|c| f64::from(c[0])).collect();
    for (label, signal) in [("uv.u", &u), ("uv.v", &v), ("height", &depth)] {
        let mut line = format!("spearman vs {label:7}:");
        for c in 0..4 {
            if colors.is_empty() { break; }
            let ch: Vec<f64> = colors.iter().map(|x| f64::from(x[c])).collect();
            line += &format!("  {}={:+.3}", ["R", "G", "B", "A"][c], spearman(&ch, signal));
        }
        for a in 0..2 {
            if uv2.is_empty() { break; }
            let ch: Vec<f64> = uv2.iter().map(|x| f64::from(x[a])).collect();
            line += &format!("  uv2.{}={:+.3}", ["u", "v"][a], spearman(&ch, signal));
        }
        println!("{line}");
    }
    for c in [1usize, 2] {
        let ch: Vec<f64> = colors.iter().map(|x| f64::from(x[c])).collect();
        let mut line = format!("{} fraction below:", ["R", "G", "B", "A"][c]);
        for t in [64.0, 128.0, 192.0, 224.0, 240.0] {
            line += &format!("  {t}:{:.3}", ch.iter().filter(|&&x| x < t).count() as f64 / ch.len().max(1) as f64);
        }
        println!("{line}");
        // Mean by height band.
        let mut line = format!("{} mean by height band:", ["R", "G", "B", "A"][c]);
        for band in 0..6 {
            let (a, b) = (band as f64 * 0.02, band as f64 * 0.02 + 0.02);
            let sel: Vec<f64> = (0..n).filter(|&i| depth[i] >= a && depth[i] < b).map(|i| ch[i]).collect();
            if !sel.is_empty() { line += &format!("  {:.0}-{:.0}mm:{:.0}", a * 1000.0, b * 1000.0, sel.iter().sum::<f64>() / sel.len() as f64); }
        }
        println!("{line}");
    }
    if !colors.is_empty() {
        let g: Vec<f64> = colors.iter().map(|x| f64::from(x[1])).collect();
        let b: Vec<f64> = colors.iter().map(|x| f64::from(x[2])).collect();
        println!("spearman G vs B: {:+.3}", spearman(&g, &b));
    }
    println!("{n} vertices, {} submeshes", built.submeshes.len());
    for s in &built.submeshes {
        let range = s.first_index as usize..(s.first_index + s.num_indices) as usize;
        let verts: std::collections::BTreeSet<u32> = built.indices[range].iter().copied().collect();
        let rs: Vec<f64> = verts.iter().filter_map(|&i| colors.get(i as usize)).map(|c| f64::from(c[0])).collect();
        println!("  material {} : {} verts, R {}", s.material_id, verts.len(), stats(&rs));
    }
}

fn stats(v: &[f64]) -> String {
    if v.is_empty() { return "empty".into(); }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let q = |f: f64| s[((s.len() - 1) as f64 * f) as usize];
    let distinct = {
        let mut d = s.clone();
        d.dedup();
        d.len()
    };
    format!(
        "min {:.3} p10 {:.3} p50 {:.3} p90 {:.3} max {:.3} ({} distinct)",
        q(0.0), q(0.1), q(0.5), q(0.9), q(1.0), distinct
    )
}

fn ranks(v: &[f64]) -> Vec<f64> {
    let mut idx: Vec<usize> = (0..v.len()).collect();
    idx.sort_by(|&a, &b| v[a].partial_cmp(&v[b]).unwrap());
    let mut r = vec![0.0; v.len()];
    let mut i = 0;
    while i < idx.len() {
        let mut j = i;
        while j + 1 < idx.len() && v[idx[j + 1]] == v[idx[i]] { j += 1; }
        let avg = (i + j) as f64 / 2.0;
        for k in i..=j { r[idx[k]] = avg; }
        i = j + 1;
    }
    r
}

fn spearman(a: &[f64], b: &[f64]) -> f64 {
    let (ra, rb) = (ranks(a), ranks(b));
    let n = ra.len() as f64;
    let (ma, mb) = (ra.iter().sum::<f64>() / n, rb.iter().sum::<f64>() / n);
    let (mut sab, mut saa, mut sbb) = (0.0, 0.0, 0.0);
    for i in 0..ra.len() {
        let (x, y) = (ra[i] - ma, rb[i] - mb);
        sab += x * y;
        saa += x * x;
        sbb += y * y;
    }
    if saa == 0.0 || sbb == 0.0 { return 0.0; }
    sab / (saa * sbb).sqrt()
}
