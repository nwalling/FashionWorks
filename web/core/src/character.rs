//! A player's own character, from the `.chf` the game's customizer saves.
//! CHARACTER.md.
//!
//! The face is not stored as a mesh. The `.chf` names, for each of 13 face
//! parts, four library heads and how much of each; the protos head's `.dna`
//! says which head each id is and how much of each part every vertex belongs
//! to; and the library heads ship as ordinary meshes of the protos head's
//! topology, vertex for vertex. So a face is a convex blend of meshes already
//! in the archive:
//!
//! ```text
//! position(v) = Σ_parts mask_p(v) · Σ_blends weight · position_head(v)
//! ```
//!
//! Because the masks sum to one at every vertex and the weights to one in every
//! part, blending absolute positions and blending offsets from the protos head
//! are the same thing: there is no second reading to choose between.

use std::collections::BTreeSet;

use starbreaker_chf::ChfFile;
use starbreaker_common::NameHash;

/// A `.chf`'s face, reduced to what the blend needs, and what it wears.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Character {
    /// The protos head its DNA is written against:
    /// `protos_human_male_face_t1_pu` or `protos_human_female_face_t1_pu`.
    pub head: String,
    /// Per face part, in the DNA's order: four `(head id, weight)` pairs with
    /// the weights normalised to sum to one. Version 7 files stop at 12 parts;
    /// the thirteenth, the neck, is then the protos head's own.
    pub parts: Vec<[(u16, f32); 4]>,
    /// Skin, eye and hair colour, and the head material. Phase 2.
    pub looks: crate::appearance::Looks,
    /// Every item in the port tree, as (port, record GUID). Phase 3.
    pub items: Vec<(String, String)>,
}

pub const MALE_HEAD: &str = "protos_human_male_face_t1_pu";
pub const FEMALE_HEAD: &str = "protos_human_female_face_t1_pu";

impl Character {
    pub fn is_female(&self) -> bool {
        self.head == FEMALE_HEAD
    }

    /// Every library head the face draws on.
    pub fn heads(&self) -> BTreeSet<u16> {
        self.parts
            .iter()
            .flat_map(|blends| blends.iter())
            .filter(|(_, w)| *w > 0.0)
            .map(|(id, _)| *id)
            .collect()
    }
}

/// Read a `.chf` container: the 4,096-byte file as it sits on disk.
pub fn read_chf(bytes: &[u8]) -> Result<Character, String> {
    let file = ChfFile::from_chf(bytes).map_err(|e| format!("not a character file: {e}"))?;
    let data = file.parse().map_err(|e| format!("reading the character: {e}"))?;
    let gender = data.dna.gender_hash;
    let head = if gender == NameHash::from_string(MALE_HEAD) {
        MALE_HEAD
    } else if gender == NameHash::from_string(FEMALE_HEAD) {
        FEMALE_HEAD
    } else {
        return Err("the character's head is neither the male nor the female protos head".into());
    };
    let parts = data
        .dna
        .face_parts
        .values()
        .map(|blends| {
            let total: f32 = blends.iter().map(|b| f32::from(b.value)).sum();
            let mut out = [(0u16, 0.0f32); 4];
            for (slot, b) in out.iter_mut().zip(blends.iter()) {
                let weight = if total > 0.0 { f32::from(b.value) / total } else { 0.0 };
                *slot = (b.head_id, weight);
            }
            out
        })
        .collect();
    Ok(Character {
        head: head.to_string(),
        parts,
        looks: crate::appearance::read_looks(&data),
        items: crate::appearance::read_items(&data),
    })
}

/// What the protos head's `.dna` says about its library: the heads' names in
/// id order, and each vertex's weight in each face part.
///
/// CIG's own format (`DNA V1.6`), read as far as the blend needs and no
/// further; see CHARACTER.md for the layout. The rest of the file -- about
/// 70 MB of what is most likely the facial expression rig -- is never read.
#[derive(Debug, Clone)]
pub struct DnaLibrary {
    pub heads: Vec<String>,
    pub parts: usize,
    pub vertices: usize,
    /// `parts × vertices`, part-major.
    pub masks: Vec<f32>,
}

const SIGNATURE: &[u8; 8] = b"DNA V1.6";
const NAME_BYTES: usize = 40;
/// One byte, and the next byte repeats it: read as a `u16` the two make 3,341.
const PARTS_AT: usize = 0x28;
const HEADS_AT: usize = 0x2a;
const VERTICES_AT: usize = 0x30;
const NAMES_OFFSET_AT: usize = 0x50;
const MASKS_OFFSET_AT: usize = 0xf0;
/// The masks section opens with an eight-byte field (zero in both files).
const MASKS_SKIP: usize = 8;

fn u8_at(bytes: &[u8], at: usize) -> Result<usize, String> {
    bytes.get(at).map(|&b| usize::from(b)).ok_or_else(|| "the DNA header is truncated".into())
}

fn u16_at(bytes: &[u8], at: usize) -> Result<usize, String> {
    let b = bytes.get(at..at + 2).ok_or("the DNA header is truncated")?;
    Ok(usize::from(u16::from_le_bytes([b[0], b[1]])))
}

fn u64_at(bytes: &[u8], at: usize) -> Result<usize, String> {
    let b = bytes.get(at..at + 8).ok_or("the DNA header is truncated")?;
    Ok(u64::from_le_bytes(b.try_into().expect("eight bytes")) as usize)
}

impl DnaLibrary {
    /// How many bytes from the start of the file [`read`](Self::read) needs,
    /// given at least the header. The masks end about 22 MB in.
    pub fn needed(header: &[u8]) -> Result<usize, String> {
        if header.get(..8) != Some(&SIGNATURE[..]) {
            return Err("not a DNA V1.6 file".into());
        }
        let parts = u8_at(header, PARTS_AT)?;
        let heads = u16_at(header, HEADS_AT)?;
        let vertices = u16_at(header, VERTICES_AT)?;
        let names_end = u64_at(header, NAMES_OFFSET_AT)? + heads * NAME_BYTES;
        let masks_end = u64_at(header, MASKS_OFFSET_AT)? + MASKS_SKIP + parts * vertices * 4;
        Ok(names_end.max(masks_end))
    }

    pub fn read(bytes: &[u8]) -> Result<DnaLibrary, String> {
        let end = Self::needed(bytes)?;
        if bytes.len() < end {
            return Err(format!("the DNA file is truncated: {} of {end} bytes", bytes.len()));
        }
        let parts = u8_at(bytes, PARTS_AT)?;
        let count = u16_at(bytes, HEADS_AT)?;
        let vertices = u16_at(bytes, VERTICES_AT)?;
        let names_at = u64_at(bytes, NAMES_OFFSET_AT)?;
        let heads = (0..count)
            .map(|k| {
                let field = &bytes[names_at + k * NAME_BYTES..names_at + (k + 1) * NAME_BYTES];
                let len = field.iter().position(|&b| b == 0).unwrap_or(NAME_BYTES);
                String::from_utf8_lossy(&field[..len]).into_owned()
            })
            .collect();
        let masks_at = u64_at(bytes, MASKS_OFFSET_AT)? + MASKS_SKIP;
        let masks = bytes[masks_at..masks_at + parts * vertices * 4]
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes(c.try_into().expect("four bytes")))
            .collect();
        Ok(DnaLibrary { heads, parts, vertices, masks })
    }

    pub fn mask(&self, part: usize, vertex: usize) -> f32 {
        self.masks[part * self.vertices + vertex]
    }

    /// Soften the masks over the head's surface: `passes` rounds of each
    /// vertex taking the mean of itself and its neighbours' mean, seam copies
    /// held together. Sums stay one, since every step is an average.
    ///
    /// **This is an interpretation, not the data.** The masks ship rough: 117
    /// vertices carry a part none of their neighbours has -- one beside the ear
    /// is 73% mouth -- and eyelid folds step from one part to another across a
    /// single edge. Blended as shipped, a mixed face buckles at those places:
    /// edges stretch up to 2.4 times on Ilucide and 5.9 on Meg, which reads as
    /// lumps at the mouth and a stepped jaw. Two passes take that to 1.1 and
    /// 1.7 while the face as a whole moves 0.06 mm on average -- the character
    /// keeps their shape and loses the lumps. How the game treats the masks is
    /// not known; a capture of the same character is what settles it.
    pub fn smooth(&mut self, indices: &[u32], positions: &[f32], passes: usize) {
        let vertices = self.vertices.min(positions.len() / 3);
        let mut first: std::collections::HashMap<[u32; 3], usize> = Default::default();
        let canon: Vec<usize> = (0..vertices)
            .map(|v| {
                let key = [positions[v * 3].to_bits(), positions[v * 3 + 1].to_bits(), positions[v * 3 + 2].to_bits()];
                *first.entry(key).or_insert(v)
            })
            .collect();
        let mut neighbours: Vec<Vec<usize>> = vec![Vec::new(); vertices];
        for tri in indices.chunks_exact(3) {
            let t = [canon[tri[0] as usize], canon[tri[1] as usize], canon[tri[2] as usize]];
            for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                if a != b {
                    if !neighbours[a].contains(&b) {
                        neighbours[a].push(b);
                    }
                    if !neighbours[b].contains(&a) {
                        neighbours[b].push(a);
                    }
                }
            }
        }
        for _ in 0..passes {
            let before = self.masks.clone();
            for v in (0..vertices).filter(|&v| canon[v] == v && !neighbours[v].is_empty()) {
                let n = neighbours[v].len() as f32;
                for p in 0..self.parts {
                    let row = p * self.vertices;
                    let around: f32 = neighbours[v].iter().map(|&u| before[row + u]).sum::<f32>() / n;
                    self.masks[row + v] = 0.5 * before[row + v] + 0.5 * around;
                }
            }
            // Copies follow the vertex that stands for them.
            for v in (0..vertices).filter(|&v| canon[v] != v) {
                for p in 0..self.parts {
                    let row = p * self.vertices;
                    self.masks[row + v] = self.masks[row + canon[v]];
                }
            }
        }
    }

    /// Give every copy of a seam vertex the same masks, their mean.
    ///
    /// The head's mesh splits a vertex wherever its UVs or normals do, and the
    /// DNA masks the copies independently: along the jaw, one copy of a seam
    /// vertex is wholly jaw and its twin wholly neck. The library heads keep
    /// the copies exactly together, so blending them under different masks is
    /// the only thing that can pull them apart -- by 8.4 mm at worst on
    /// Ilucide, 24 cracks along the jaw and neck. Averaged, the copies blend
    /// alike and the seam stays shut. `positions` is the protos head's.
    pub fn weld(&mut self, positions: &[f32]) {
        let mut groups: std::collections::HashMap<[u32; 3], Vec<usize>> = Default::default();
        for v in 0..self.vertices.min(positions.len() / 3) {
            let key = [positions[v * 3].to_bits(), positions[v * 3 + 1].to_bits(), positions[v * 3 + 2].to_bits()];
            groups.entry(key).or_default().push(v);
        }
        for copies in groups.values().filter(|g| g.len() > 1) {
            for p in 0..self.parts {
                let mean = copies.iter().map(|&v| self.mask(p, v)).sum::<f32>() / copies.len() as f32;
                for &v in copies {
                    self.masks[p * self.vertices + v] = mean;
                }
            }
        }
    }
}

/// The face parts, in the DNA's order. Left and right come in pairs; the
/// eyes' pair is what places each eyeball.
pub const EYE_LEFT: usize = 2;
pub const EYE_RIGHT: usize = 3;

/// One part's four blends, with any head that has no shape dropped and the
/// rest renormalised; the protos head (id 0) where nothing is left. That is
/// the neck of a version-7 file, and any part naming only `imperator_t1`,
/// the one library head this build ships no mesh for.
pub fn usable(blends: Option<&[(u16, f32); 4]>, has_shape: &dyn Fn(u16) -> bool) -> Vec<(u16, f32)> {
    let kept: Vec<(u16, f32)> = blends
        .map(|b| b.iter().copied().filter(|&(id, w)| w > 0.0 && has_shape(id)).collect())
        .unwrap_or_default();
    let total: f32 = kept.iter().map(|(_, w)| w).sum();
    if total <= 0.0 {
        return vec![(0, 1.0)];
    }
    kept.into_iter().map(|(id, w)| (id, w / total)).collect()
}

/// Blend a per-vertex attribute (`stride` floats a vertex) of the head across
/// the library, part by part under the masks.
///
/// `shape(id)` is the library head's attribute buffer, in the protos head's
/// vertex order; it is asked only for heads the character uses.
pub fn blend_head<'a>(
    character: &Character,
    library: &DnaLibrary,
    stride: usize,
    shape: &dyn Fn(u16) -> Option<&'a [f32]>,
) -> Vec<f32> {
    let has_shape = |id: u16| shape(id).is_some();
    let per_part: Vec<Vec<(u16, f32)>> =
        (0..library.parts).map(|p| usable(character.parts.get(p), &has_shape)).collect();
    let mut out = vec![0.0f32; library.vertices * stride];
    for (p, blends) in per_part.iter().enumerate() {
        for &(id, weight) in blends {
            let source = shape(id).expect("usable heads have shapes");
            for v in 0..library.vertices {
                let w = library.mask(p, v) * weight;
                if w == 0.0 {
                    continue;
                }
                for c in 0..stride {
                    out[v * stride + c] += w * source[v * stride + c];
                }
            }
        }
    }
    out
}

/// Blend a per-vertex attribute of a rigid part that belongs wholly to one
/// face part -- an eyeball to its eye -- with that part's weights.
pub fn blend_part<'a>(
    character: &Character,
    part: usize,
    vertices: &[usize],
    stride: usize,
    out: &mut [f32],
    shape: &dyn Fn(u16) -> Option<&'a [f32]>,
) {
    let has_shape = |id: u16| shape(id).is_some();
    let blends = usable(character.parts.get(part), &has_shape);
    for &v in vertices {
        for c in 0..stride {
            out[v * stride + c] = 0.0;
        }
    }
    for (id, weight) in blends {
        let source = shape(id).expect("usable heads have shapes");
        for &v in vertices {
            for c in 0..stride {
                out[v * stride + c] += weight * source[v * stride + c];
            }
        }
    }
}

/// Which side of the face the left-eye part sits on, as the sign of x: the
/// mask-weighted mean of the protos head's positions.
pub fn left_eye_side(library: &DnaLibrary, positions: &[f32]) -> f32 {
    let (mut sum, mut weight) = (0.0f32, 0.0f32);
    for v in 0..library.vertices {
        let w = library.mask(EYE_LEFT, v);
        sum += w * positions[v * 3];
        weight += w;
    }
    if weight > 0.0 && sum < 0.0 { -1.0 } else { 1.0 }
}

/// Normals for a blended head: the protos head's own, turned by however much
/// the blend turned the surface.
///
/// Blending the library's normals under the masks, as positions are, shades
/// wrong wherever a mask is hard-edged: 333 of the head's 16,298 edges step a
/// part from nearly all to nearly nothing, and across one of them the normals
/// jump between two heads' while the surface barely moves -- a jagged dark band
/// along Ilucide's right cheek, where cheek, ear and jaw meet. The geometric
/// normal of the blended surface is continuous there, so the change in *it* is
/// what turns the authored normal. The head is smooth -- every seam copy shares
/// its normal -- so the surface is welded across seams before it is measured.
pub fn reshade(indices: &[u32], protos: &[f32], authored: &[f32], blended: &[f32]) -> Vec<f32> {
    let vertices = protos.len() / 3;
    // One index per point, so seam copies accumulate together.
    let mut first: std::collections::HashMap<[u32; 3], usize> = Default::default();
    let canon: Vec<usize> = (0..vertices)
        .map(|v| {
            let key = [protos[v * 3].to_bits(), protos[v * 3 + 1].to_bits(), protos[v * 3 + 2].to_bits()];
            *first.entry(key).or_insert(v)
        })
        .collect();
    let geometric = |positions: &[f32]| {
        let mut sum = vec![0.0f32; vertices * 3];
        for tri in indices.chunks_exact(3) {
            let [a, b, c] = [tri[0] as usize, tri[1] as usize, tri[2] as usize];
            let p = |v: usize, k: usize| positions[v * 3 + k];
            let e1 = [p(b, 0) - p(a, 0), p(b, 1) - p(a, 1), p(b, 2) - p(a, 2)];
            let e2 = [p(c, 0) - p(a, 0), p(c, 1) - p(a, 1), p(c, 2) - p(a, 2)];
            // Area-weighted: the cross product's length is twice the area.
            let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            for v in [a, b, c] {
                for k in 0..3 {
                    sum[canon[v] * 3 + k] += n[k];
                }
            }
        }
        let mut out = vec![0.0f32; vertices * 3];
        for v in 0..vertices {
            out[v * 3..v * 3 + 3].copy_from_slice(&sum[canon[v] * 3..canon[v] * 3 + 3]);
        }
        renormalise(&mut out);
        out
    };
    let before = geometric(protos);
    let after = geometric(blended);
    let mut out: Vec<f32> = (0..vertices * 3).map(|i| authored[i] + after[i] - before[i]).collect();
    renormalise(&mut out);
    out
}

/// Unit-length every normal after a blend, which shortens them.
pub fn renormalise(normals: &mut [f32]) {
    for n in normals.chunks_exact_mut(3) {
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        if len > 1e-8 {
            n.iter_mut().for_each(|c| *c /= len);
        }
    }
}

/// Carry the face's change of shape onto something worn on it: brows, lashes,
/// beard, hair, piercings.
///
/// These meshes are authored against the protos head and the game fits them
/// to the blended one at runtime -- their records name `WD_Elastic`,
/// `WD_ElasticDQSkinning` and `WD_ElasticNUScaling` deformers, where the head
/// and body name `Standard`. What those do exactly is compiled into the
/// engine, so this is the plain version of a wrap, and **inferred**: each
/// point moves by the displacement of the protos-head vertices nearest it,
/// weighted by inverse distance. A point on the brow ridge moves with the brow
/// ridge; a hair tip moves with the scalp it hangs from.
pub fn wrap(protos: &[f32], blended: &[f32], points: &mut [f32]) {
    let count = protos.len() / 3;
    if count == 0 || blended.len() != protos.len() {
        return;
    }
    let tree = KdTree::new(protos);
    for p in points.chunks_exact_mut(3) {
        let near = tree.nearest(protos, [p[0], p[1], p[2]], WRAP_NEIGHBOURS);
        let mut total = 0.0f32;
        let mut shift = [0.0f32; 3];
        for (v, d2) in near {
            let w = 1.0 / (d2.sqrt() + WRAP_SOFTEN);
            total += w;
            for c in 0..3 {
                shift[c] += w * (blended[v * 3 + c] - protos[v * 3 + c]);
            }
        }
        if total > 0.0 {
            for c in 0..3 {
                p[c] += shift[c] / total;
            }
        }
    }
}

/// How many head vertices a worn point follows.
const WRAP_NEIGHBOURS: usize = 4;
/// Metres added to each distance, so a point sitting exactly on a vertex does
/// not take that vertex alone and the weights stay finite.
const WRAP_SOFTEN: f32 = 0.001;

/// A k-d tree over a point cloud, for nearest-neighbour queries. The head has
/// 5,584 vertices and a hair mesh tens of thousands of points, which is too
/// many pairs to compare directly.
struct KdTree {
    /// Point indices, arranged so each subtree is a contiguous range whose
    /// middle element splits it.
    order: Vec<usize>,
}

impl KdTree {
    fn new(points: &[f32]) -> KdTree {
        let mut order: Vec<usize> = (0..points.len() / 3).collect();
        fn build(points: &[f32], order: &mut [usize], depth: usize) {
            if order.len() <= 1 {
                return;
            }
            let axis = depth % 3;
            let mid = order.len() / 2;
            order.select_nth_unstable_by(mid, |a, b| points[a * 3 + axis].total_cmp(&points[b * 3 + axis]));
            let (left, right) = order.split_at_mut(mid);
            build(points, left, depth + 1);
            build(points, &mut right[1..], depth + 1);
        }
        build(points, &mut order, 0);
        KdTree { order }
    }

    /// The `k` nearest points to `q`, as (index, squared distance).
    fn nearest(&self, points: &[f32], q: [f32; 3], k: usize) -> Vec<(usize, f32)> {
        let mut best: Vec<(usize, f32)> = Vec::with_capacity(k + 1);
        fn search(points: &[f32], order: &[usize], depth: usize, q: [f32; 3], k: usize, best: &mut Vec<(usize, f32)>) {
            if order.is_empty() {
                return;
            }
            let mid = order.len() / 2;
            let i = order[mid];
            let d2: f32 = (0..3).map(|c| (points[i * 3 + c] - q[c]).powi(2)).sum();
            if best.len() < k || d2 < best[best.len() - 1].1 {
                let at = best.partition_point(|&(_, d)| d <= d2);
                best.insert(at, (i, d2));
                best.truncate(k);
            }
            let axis = depth % 3;
            let delta = q[axis] - points[i * 3 + axis];
            let (near, far) = if delta < 0.0 { (&order[..mid], &order[mid + 1..]) } else { (&order[mid + 1..], &order[..mid]) };
            search(points, near, depth + 1, q, k, best);
            if best.len() < k || delta * delta < best[best.len() - 1].1 {
                search(points, far, depth + 1, q, k, best);
            }
        }
        search(points, &self.order, 0, q, k, &mut best);
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library(parts: usize, vertices: usize, masks: Vec<f32>) -> DnaLibrary {
        DnaLibrary { heads: vec!["protos".into(), "a".into(), "b".into()], parts, vertices, masks }
    }

    #[test]
    fn a_face_is_a_convex_blend_under_the_masks() {
        // Two vertices, two parts: vertex 0 wholly part 0, vertex 1 split.
        let lib = library(2, 2, vec![1.0, 0.5, 0.0, 0.5]);
        let character = Character {
            head: MALE_HEAD.into(),
            parts: vec![
                [(1, 1.0), (0, 0.0), (0, 0.0), (0, 0.0)],
                [(2, 0.5), (0, 0.5), (0, 0.0), (0, 0.0)],
            ],
            ..Default::default()
        };
        let shapes = [vec![0.0f32, 0.0], vec![10.0, 10.0], vec![20.0, 20.0]];
        let out = blend_head(&character, &lib, 1, &|id| shapes.get(usize::from(id)).map(|s| &s[..]));
        // v0: part 0 only, head 1 -> 10.  v1: half part 0 (10), half part 1 (0.5*20 + 0.5*0 = 10).
        assert_eq!(out, vec![10.0, 10.0]);
    }

    #[test]
    fn a_head_without_a_mesh_is_dropped_and_the_rest_renormalised() {
        let has = |id: u16| id != 19;
        let blends = [(19, 0.5), (4, 0.25), (7, 0.25), (0, 0.0)];
        assert_eq!(usable(Some(&blends), &has), vec![(4, 0.5), (7, 0.5)]);
        // Nothing left, or no part at all (a version-7 file's neck): the protos head.
        assert_eq!(usable(Some(&[(19, 1.0), (0, 0.0), (0, 0.0), (0, 0.0)]), &has), vec![(0, 1.0)]);
        assert_eq!(usable(None, &has), vec![(0, 1.0)]);
    }

    #[test]
    fn the_library_is_read_from_its_header_offsets() {
        let (parts, heads, vertices) = (2usize, 3usize, 4usize);
        let mut b = vec![0u8; 0x400];
        b[..8].copy_from_slice(SIGNATURE);
        // As the real files have it: the count, then the count again.
        b[PARTS_AT] = parts as u8;
        b[PARTS_AT + 1] = parts as u8;
        b[HEADS_AT..HEADS_AT + 2].copy_from_slice(&(heads as u16).to_le_bytes());
        b[VERTICES_AT..VERTICES_AT + 2].copy_from_slice(&(vertices as u16).to_le_bytes());
        let names_at = 0x150usize;
        let masks_at = 0x200usize;
        b[NAMES_OFFSET_AT..NAMES_OFFSET_AT + 8].copy_from_slice(&(names_at as u64).to_le_bytes());
        b[MASKS_OFFSET_AT..MASKS_OFFSET_AT + 8].copy_from_slice(&(masks_at as u64).to_le_bytes());
        for (k, name) in ["protos", "male17_t1", "silas_t1"].iter().enumerate() {
            b[names_at + k * NAME_BYTES..names_at + k * NAME_BYTES + name.len()].copy_from_slice(name.as_bytes());
        }
        for i in 0..parts * vertices {
            let at = masks_at + MASKS_SKIP + i * 4;
            b[at..at + 4].copy_from_slice(&(i as f32).to_le_bytes());
        }
        assert_eq!(DnaLibrary::needed(&b).unwrap(), masks_at + MASKS_SKIP + parts * vertices * 4);
        let lib = DnaLibrary::read(&b).unwrap();
        assert_eq!(lib.heads, vec!["protos", "male17_t1", "silas_t1"]);
        assert_eq!(lib.mask(1, 2), 6.0);
        assert!(DnaLibrary::read(&b[..0x210]).is_err(), "a short prefix is refused, not misread");
    }

    #[test]
    fn seam_copies_blend_alike_once_welded() {
        // Vertices 0 and 1 are one point split by a seam: 0 wholly part 0,
        // 1 wholly part 1. Vertex 2 is elsewhere and keeps its own mask.
        let mut lib = library(2, 3, vec![1.0, 0.0, 1.0, 0.0, 1.0, 0.0]);
        lib.weld(&[0.1, 0.2, 0.3, 0.1, 0.2, 0.3, 9.0, 9.0, 9.0]);
        assert_eq!(lib.masks, vec![0.5, 0.5, 1.0, 0.5, 0.5, 0.0]);
        let character = Character {
            head: MALE_HEAD.into(),
            parts: vec![[(1, 1.0), (0, 0.0), (0, 0.0), (0, 0.0)], [(2, 1.0), (0, 0.0), (0, 0.0), (0, 0.0)]],
            ..Default::default()
        };
        let shapes = [vec![0.0f32; 3], vec![10.0, 10.0, 10.0], vec![20.0, 20.0, 20.0]];
        let out = blend_head(&character, &lib, 1, &|id| shapes.get(usize::from(id)).map(|s| &s[..]));
        assert_eq!(out[0], out[1], "the seam stays shut");
    }

    #[test]
    fn smoothing_keeps_the_masks_a_partition_and_softens_a_step() {
        // A strip of four vertices (two triangles in a row): part 0 on the
        // left two, part 1 on the right two -- a hard step in the middle.
        let positions = [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 2.0, 0.0, 0.0, 3.0, 0.0, 0.0];
        let indices = [0u32, 1, 2, 1, 2, 3];
        let mut lib = library(2, 4, vec![1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0]);
        lib.smooth(&indices, &positions, 1);
        for v in 0..4 {
            assert!((lib.mask(0, v) + lib.mask(1, v) - 1.0).abs() < 1e-6, "still sums to one");
        }
        assert!(lib.mask(0, 1) < 1.0 && lib.mask(0, 2) > 0.0, "the step is softened");
    }

    #[test]
    fn an_unmoved_surface_keeps_its_authored_normals() {
        // One triangle in the z = 0 plane, authored normals leaning off +z.
        let indices = [0u32, 1, 2];
        let positions = [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let lean = 0.1f32;
        let len = (1.0 + lean * lean).sqrt();
        let authored: Vec<f32> = (0..3).flat_map(|_| [lean / len, 0.0, 1.0 / len]).collect();
        let same = reshade(&indices, &positions, &authored, &positions);
        for (a, b) in same.iter().zip(&authored) {
            assert!((a - b).abs() < 1e-6, "no change in shape, no change in shading");
        }
        // Tilt the triangle: the normals turn with it.
        let tilted = [0.0f32, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0];
        let turned = reshade(&indices, &positions, &authored, &tilted);
        assert!(turned[0] < 0.0, "a surface tipped towards +x turns its normal towards -x");
    }

    #[test]
    fn an_eyeball_follows_its_eye_part() {
        let character = Character {
            head: MALE_HEAD.into(),
            parts: vec![[(0, 1.0); 4], [(0, 1.0); 4], [(1, 0.25), (2, 0.75), (0, 0.0), (0, 0.0)]],
            ..Default::default()
        };
        let shapes = [vec![0.0f32; 2], vec![4.0, 4.0], vec![8.0, 8.0]];
        let mut out = vec![-1.0f32; 2];
        blend_part(&character, EYE_LEFT, &[1], 1, &mut out, &|id| shapes.get(usize::from(id)).map(|s| &s[..]));
        assert_eq!(out, vec![-1.0, 7.0], "only the listed vertices move");
    }

    #[test]
    fn the_k_d_tree_finds_what_a_scan_finds() {
        let mut points = Vec::new();
        let mut seed = 7u32;
        let mut next = || {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (seed >> 8) as f32 / (1u32 << 24) as f32
        };
        for _ in 0..500 {
            points.extend([next(), next(), next()]);
        }
        let tree = KdTree::new(&points);
        for _ in 0..50 {
            let q = [next(), next(), next()];
            let mut scan: Vec<(usize, f32)> = (0..500)
                .map(|i| (i, (0..3).map(|c| (points[i * 3 + c] - q[c]).powi(2)).sum()))
                .collect();
            scan.sort_by(|a, b| a.1.total_cmp(&b.1));
            let found = tree.nearest(&points, q, 4);
            assert_eq!(found.iter().map(|f| f.0).collect::<Vec<_>>(), scan[..4].iter().map(|s| s.0).collect::<Vec<_>>());
        }
    }

    #[test]
    fn a_worn_point_moves_with_the_face_under_it() {
        // Two head vertices a metre apart; the left one moves up 1 cm.
        let protos = [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0];
        let blended = [0.0f32, 0.01, 0.0, 1.0, 0.0, 0.0];
        let mut points = [0.0f32, 0.0, 0.002, 1.0, 0.0, 0.002];
        wrap(&protos, &blended, &mut points);
        assert!((points[1] - 0.01).abs() < 0.0002, "the brow over the moved vertex moves with it: {}", points[1]);
        assert!(points[4].abs() < 0.0002, "the one over the still vertex stays: {}", points[4]);
    }
}
