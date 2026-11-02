//! Which way a hair mesh's frame points: each colour channel's spread,
//! how green and blue follow height and depth into the mass, and whether the
//! tangent stream runs along the card (root to tip) or across it.
//!
//!   cargo run --example hair_frame --release -- <file.skinm>...

use starbreaker_3d::ivo::skin::SkinMesh;
use starbreaker_chunks::ChunkFile;
use std::collections::BTreeMap;

fn pct(v: &mut [f32], p: f32) -> f32 { if v.is_empty() { return f32::NAN } v.sort_by(|a, b| a.partial_cmp(b).unwrap()); v[((v.len() - 1) as f32 * p) as usize] }
fn corr(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len() as f32; let ma = a.iter().sum::<f32>() / n; let mb = b.iter().sum::<f32>() / n;
    let (mut sab, mut saa, mut sbb) = (0.0, 0.0, 0.0);
    for i in 0..a.len() { let da = a[i] - ma; let db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
    sab / (saa * sbb).sqrt()
}

fn main() {
    for path in std::env::args().skip(1) {
        let bytes = std::fs::read(&path).expect("read");
        let ChunkFile::Ivo(ivo) = ChunkFile::from_bytes(&bytes).expect("chunk file") else { panic!("not ivo") };
        let entry = ivo.chunks().iter().find(|c| c.chunk_type == starbreaker_chunks::known_types::ivo::IVO_SKIN2).expect("skin chunk");
        let mesh = SkinMesh::read(ivo.chunk_data(entry)).expect("parse");
        let built = starbreaker_3d::types::build_mesh(&mesh, &[]);
        let name = path.rsplit('/').next().unwrap_or(&path);
        let n = built.positions.len();
        println!("== {name}: {n} vertices, uvs {} uv2 {} normals {} tangents {} colors {}",
            built.uvs.is_some(), built.secondary_uvs.is_some(), built.normals.is_some(), built.tangents.is_some(), built.colors.is_some());
        let Some(colors) = built.colors.as_ref() else { continue };
        let z: Vec<f32> = built.positions.iter().map(|p| p[2]).collect();
        let cx = built.positions.iter().map(|p| p[0]).sum::<f32>() / n as f32;
        let cy = built.positions.iter().map(|p| p[1]).sum::<f32>() / n as f32;
        let cz = built.positions.iter().map(|p| p[2]).sum::<f32>() / n as f32;
        let radius: Vec<f32> = built.positions.iter().map(|p| ((p[0]-cx).powi(2)+(p[1]-cy).powi(2)+(p[2]-cz).powi(2)).sqrt()).collect();
        for (ch, label) in ["R","G","B","A"].iter().enumerate() {
            let mut v: Vec<f32> = colors.iter().map(|c| c[ch] as f32).collect();
            let distinct = v.iter().map(|x| *x as u8).collect::<std::collections::BTreeSet<_>>().len();
            let c_z = corr(&v, &z); let c_r = corr(&v, &radius);
            let red: Vec<f32> = colors.iter().map(|c| c[0] as f32).collect();
            let c_red = corr(&v, &red);
            println!("  {label}: distinct {distinct} p1/10/50/90/99 {:.0} {:.0} {:.0} {:.0} {:.0}  corr(height) {c_z:+.2} corr(radius) {c_r:+.2} corr(red) {c_red:+.2}",
                pct(&mut v, 0.01), pct(&mut v, 0.1), pct(&mut v, 0.5), pct(&mut v, 0.9), pct(&mut v, 0.99));
        }
        // Per card: root-to-tip direction from the vertex red, against the tangent and the normal.
        if let (Some(tangents), Some(uvs)) = (built.tangents.as_ref(), built.uvs.as_ref()) {
            let mut parent: Vec<u32> = (0..n as u32).collect();
            fn find(p: &mut Vec<u32>, x: u32) -> u32 { let mut r = x; while p[r as usize] != r { r = p[r as usize]; } let mut c = x; while p[c as usize] != r { let nx = p[c as usize]; p[c as usize] = r; c = nx; } r }
            for t in built.indices.chunks(3) { let a = find(&mut parent, t[0]); for &v in &t[1..] { let b = find(&mut parent, v); if a != b { parent[b as usize] = a; } } }
            let mut cards: BTreeMap<u32, Vec<usize>> = BTreeMap::new();
            for v in 0..n { let r = find(&mut parent, v as u32); cards.entry(r).or_default().push(v); }
            let mut along_t = Vec::new(); let mut along_n = Vec::new(); let mut along_v = Vec::new(); let mut w_vals = Vec::new();
            for (_, vs) in &cards {
                let (mut root, mut tip, mut nr, mut nt) = ([0f32;3],[0f32;3],0,0);
                let peak = vs.iter().map(|&v| colors[v][0]).max().unwrap_or(0);
                if peak == 0 { continue }
                for &v in vs { let p = built.positions[v]; if colors[v][0] == 0 { for k in 0..3 { root[k] += p[k]; } nr += 1; } if colors[v][0] == peak { for k in 0..3 { tip[k] += p[k]; } nt += 1; } }
                if nr == 0 || nt == 0 { continue }
                let d = [tip[0]/nt as f32 - root[0]/nr as f32, tip[1]/nt as f32 - root[1]/nr as f32, tip[2]/nt as f32 - root[2]/nr as f32];
                let len = (d[0]*d[0]+d[1]*d[1]+d[2]*d[2]).sqrt(); if len < 1e-4 { continue }
                let d = [d[0]/len, d[1]/len, d[2]/len];
                // UV v direction too: tip uv minus root uv.
                let (mut ur, mut ut) = ([0f32;2],[0f32;2]);
                for &v in vs { if colors[v][0] == 0 { ur[0]+=uvs[v][0]; ur[1]+=uvs[v][1]; } if colors[v][0]==peak { ut[0]+=uvs[v][0]; ut[1]+=uvs[v][1]; } }
                along_v.push((ut[1]/nt as f32 - ur[1]/nr as f32).signum() * ((ut[1]/nt as f32 - ur[1]/nr as f32).abs() > (ut[0]/nt as f32 - ur[0]/nr as f32).abs()) as i32 as f32);
                for &v in vs.iter().take(8) {
                    let t = tangents[v]; let tl = (t[0]*t[0]+t[1]*t[1]+t[2]*t[2]).sqrt(); if tl < 1e-4 { continue }
                    along_t.push((t[0]*d[0]+t[1]*d[1]+t[2]*d[2]).abs()/tl); w_vals.push(t[3]);
                    if let Some(nm) = built.normals.as_ref() { let nn = nm[v]; along_n.push((nn[0]*d[0]+nn[1]*d[1]+nn[2]*d[2]).abs()); }
                }
            }
            println!("  |tangent . root->tip| p10/50/90: {:.2} {:.2} {:.2}  (n {})", pct(&mut along_t, 0.1), pct(&mut along_t, 0.5), pct(&mut along_t, 0.9), along_t.len());
            if !along_n.is_empty() { println!("  |normal . root->tip| p10/50/90: {:.2} {:.2} {:.2}", pct(&mut along_n, 0.1), pct(&mut along_n, 0.5), pct(&mut along_n, 0.9)); }
            let vdown = along_v.iter().filter(|&&s| s > 0.0).count(); let vup = along_v.iter().filter(|&&s| s < 0.0).count(); let vside = along_v.iter().filter(|&&s| s == 0.0).count();
            println!("  root->tip along UV: +v {vdown} -v {vup} along u {vside}; tangent.w p10/50/90 {:.2} {:.2} {:.2}", pct(&mut w_vals, 0.1), pct(&mut w_vals, 0.5), pct(&mut w_vals, 0.9));
            let t0 = tangents[0]; let t1 = tangents[n/2]; println!("  tangent samples {:?} {:?}", t0, t1);
            // Is the normal a normal? Against the tangent, and against the radial direction from the mesh centre.
            if let Some(nm) = built.normals.as_ref() {
                let mut nt = Vec::new(); let mut nr = Vec::new(); let mut tr = Vec::new(); let mut cr = Vec::new();
                for v in 0..n {
                    let t = tangents[v]; let nn = nm[v]; let p = built.positions[v];
                    let r = [p[0]-cx, p[1]-cy, p[2]-cz]; let rl = (r[0]*r[0]+r[1]*r[1]+r[2]*r[2]).sqrt(); if rl < 1e-4 { continue }
                    let r = [r[0]/rl, r[1]/rl, r[2]/rl];
                    nt.push((nn[0]*t[0]+nn[1]*t[1]+nn[2]*t[2]).abs());
                    nr.push((nn[0]*r[0]+nn[1]*r[1]+nn[2]*r[2]).abs());
                    tr.push((t[0]*r[0]+t[1]*r[1]+t[2]*r[2]).abs());
                    let c = [t[1]*nn[2]-t[2]*nn[1], t[2]*nn[0]-t[0]*nn[2], t[0]*nn[1]-t[1]*nn[0]];
                    cr.push((c[0]*r[0]+c[1]*r[1]+c[2]*r[2]).abs());
                }
                println!("  |n.t| p10/50/90 {:.2} {:.2} {:.2}; |n.radial| {:.2} {:.2} {:.2}; |t.radial| {:.2} {:.2} {:.2}; |(t x n).radial| {:.2} {:.2} {:.2}",
                    pct(&mut nt,0.1),pct(&mut nt,0.5),pct(&mut nt,0.9), pct(&mut nr,0.1),pct(&mut nr,0.5),pct(&mut nr,0.9), pct(&mut tr,0.1),pct(&mut tr,0.5),pct(&mut tr,0.9), pct(&mut cr,0.1),pct(&mut cr,0.5),pct(&mut cr,0.9));
            }
            // The definitive test: each triangle's geometric normal against the vertex "normal", the tangent and their cross.
            if let Some(nm) = built.normals.as_ref() {
                let mut gn = Vec::new(); let mut gt = Vec::new(); let mut gc = Vec::new();
                for tri in built.indices.chunks(3) {
                    let (a, b, c) = (built.positions[tri[0] as usize], built.positions[tri[1] as usize], built.positions[tri[2] as usize]);
                    let e1 = [b[0]-a[0], b[1]-a[1], b[2]-a[2]]; let e2 = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
                    let g = [e1[1]*e2[2]-e1[2]*e2[1], e1[2]*e2[0]-e1[0]*e2[2], e1[0]*e2[1]-e1[1]*e2[0]];
                    let gl = (g[0]*g[0]+g[1]*g[1]+g[2]*g[2]).sqrt(); if gl < 1e-9 { continue }
                    let g = [g[0]/gl, g[1]/gl, g[2]/gl];
                    let v = tri[0] as usize; let nn = nm[v]; let t = tangents[v];
                    let cr = [t[1]*nn[2]-t[2]*nn[1], t[2]*nn[0]-t[0]*nn[2], t[0]*nn[1]-t[1]*nn[0]];
                    gn.push((g[0]*nn[0]+g[1]*nn[1]+g[2]*nn[2]).abs()); gt.push((g[0]*t[0]+g[1]*t[1]+g[2]*t[2]).abs()); gc.push((g[0]*cr[0]+g[1]*cr[1]+g[2]*cr[2]).abs());
                }
                println!("  face normal . vertex normal p10/50/90 {:.2} {:.2} {:.2}; . tangent {:.2} {:.2} {:.2}; . (t x n) {:.2} {:.2} {:.2}",
                    pct(&mut gn,0.1),pct(&mut gn,0.5),pct(&mut gn,0.9), pct(&mut gt,0.1),pct(&mut gt,0.5),pct(&mut gt,0.9), pct(&mut gc,0.1),pct(&mut gc,0.5),pct(&mut gc,0.9));
            }
            if let Some(uv2) = built.secondary_uvs.as_ref() {
                let differ = (0..n).filter(|&v| (uv2[v][0]-uvs[v][0]).abs() > 1e-5 || (uv2[v][1]-uvs[v][1]).abs() > 1e-5).count();
                let (mut u2, mut v2): (Vec<f32>, Vec<f32>) = (uv2.iter().map(|u| u[0]).collect(), uv2.iter().map(|u| u[1]).collect());
                println!("  uv2 differs from uv on {differ} of {n}; uv2 u p1/50/99 {:.3} {:.3} {:.3} v {:.3} {:.3} {:.3}", pct(&mut u2,0.01),pct(&mut u2,0.5),pct(&mut u2,0.99),pct(&mut v2,0.01),pct(&mut v2,0.5),pct(&mut v2,0.99));
            }
        }
    }
}
