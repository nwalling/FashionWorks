//! Assembling one armour mesh into buffers a renderer can bind.
//!
//! Phase 2 proved every data path separately: geometry parses, skinning
//! decodes, the skeleton reconciles, stray weight redistributes. This is the
//! assembly that turns those into something with vertices in it, which is what
//! WEB.md meant by *"what remains for a renderable result is assembly rather
//! than format work."*
//!
//! Three things the format dictates, each of which has already caught someone:
//!
//! * **A mesh is two files.** `.skin` carries the bones, the material names and
//!   a mesh descriptor; `.skinm` carries the vertex streams. Reading only the
//!   one StarBreaker's CLI takes -- the `.skinm` -- gives geometry with no
//!   skeleton. It is the same trap as a `.dds` that holds only its smallest
//!   mip.
//! * **`SkinMesh::read` takes one chunk's data, `parse_skeleton` takes the
//!   whole file.** Backwards, the first reads the container header as vertex
//!   counts and asks for 148 GB.
//! * **Positions are quantised against the *scaling* bbox, not the model one.**
//!   The header carries both and they are not the same box.

use starbreaker_3d::ivo::material::MaterialName;
use starbreaker_3d::ivo::skin::SkinMesh;
use starbreaker_chunks::{known_types::ivo, ChunkFile};

/// How many bone influences a vertex keeps.
///
/// The archive stores **eight**. glTF's `JOINTS_0`/`WEIGHTS_0` hold four, and
/// the existing pipeline goes through Collada and Blender's exporter, which
/// limits to four as well -- so four is what the reference produces and four is
/// what the viewer's binding already expects. Taking the four heaviest and
/// renormalising is what Blender does; the discarded weight is small by
/// construction, since it is the tail of a sorted list.
pub const MAX_INFLUENCES: usize = 4;

/// The most a vertex can keep when the renderer takes a second set of four.
/// RENDERING.md Phase 7: eight is what the archive stores, and a mesh keeps
/// all of them only where some vertex actually uses more than four.
pub const WIDE_INFLUENCES: usize = 8;

#[derive(Debug, Clone, PartialEq)]
pub struct Submesh {
    /// Index into the material file's submaterial list.
    ///
    /// **The mesh does not name its materials.** It carries a numeric id per
    /// group and one `MTL_NAME` chunk naming the `.mtl` *file*; the names --
    /// `coated_metal_m`, `mouthplates_m` and the rest -- live in that file's
    /// submaterial list. The pipeline gets them via Collada, which derives them
    /// from the same file, so this is the same mapping arrived at directly.
    ///
    /// **It can point past the end of that list.** The Sunchaser helmet
    /// declares seven groups against a `.mtl` with six submaterials; the
    /// seventh holds 28 of its 27,938 triangles and names a submaterial that
    /// does not exist. The pipeline emits six primitives for this mesh, so it
    /// drops the orphan somewhere in Collada or Blender without saying so. The
    /// id is passed through as written and the caller decides, because silently
    /// dropping geometry here would hide the same thing one layer lower.
    pub material_id: u32,
    pub first_index: u32,
    pub index_count: u32,
    /// The NMC node this group belongs to, in a rigid `.cga`/`.cgf`. Its
    /// vertices are in that node's space; 0 is the root.
    pub node: u16,
}

/// One mesh, flattened into the arrays a `BufferGeometry` binds directly.
#[derive(Debug, Clone, Default)]
pub struct LoadedMesh {
    /// Interleaved as x,y,z per vertex.
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    /// u,v per vertex.
    pub uvs: Vec<f32>,
    pub indices: Vec<u32>,
    /// Four joint indices per vertex, into [`LoadedMesh::bones`].
    pub joints: Vec<u16>,
    /// Four weights per vertex, summing to 1 where the vertex is skinned.
    ///
    /// Four or eight, per [`LoadedMesh::influences`]: `joints` and `weights`
    /// hold that many per vertex, heaviest first.
    pub weights: Vec<f32>,
    /// Influences per vertex in `joints` and `weights`: 4, or 8 for a mesh
    /// loaded wide whose vertices use more than four.
    pub influences: usize,
    /// The mesh's own bone names, in the order its joint indices address.
    ///
    /// **Not the canonical armature's order.** One armour piece exports 41
    /// joints of which only 16 exist in the base skeleton; the other 25 are
    /// attachment points the armour itself introduces. The remap onto the
    /// shared skeleton happens by name, above this.
    pub bones: Vec<String>,
    /// Each of [`LoadedMesh::bones`]'s parent, as an index into the same
    /// list. A bone the rig does not have can be traced up this chain to one
    /// it does: a wrist piston's end belongs to the hand it hangs from.
    pub bone_parents: Vec<Option<usize>>,
    pub submeshes: Vec<Submesh>,
    /// The `.mtl` this mesh references, as the archive spells it.
    pub material_file: Option<String>,
    pub min: [f32; 3],
    pub max: [f32; 3],
}

impl LoadedMesh {
    pub fn vertex_count(&self) -> usize {
        self.positions.len() / 3
    }

    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }

    /// Drop back to four influences if no vertex uses a fifth.
    ///
    /// A mesh is loaded eight wide by what the archive stores; after rebinding
    /// it may not need to be. Hair is the case: 63,083 vertices with strand
    /// bones the rig does not have, whose weight folds onto the head, and not
    /// one vertex left with more than four -- a second set of zeros, 1.5 MB.
    pub fn narrow_if_unused(&mut self) {
        if self.influences != WIDE_INFLUENCES {
            return;
        }
        let vertices = self.vertex_count();
        if (0..vertices).any(|v| self.weights[v * 8 + 4..v * 8 + 8].iter().any(|w| *w > 0.0)) {
            return;
        }
        let mut joints = Vec::with_capacity(vertices * 4);
        let mut weights = Vec::with_capacity(vertices * 4);
        for v in 0..vertices {
            joints.extend_from_slice(&self.joints[v * 8..v * 8 + 4]);
            weights.extend_from_slice(&self.weights[v * 8..v * 8 + 4]);
        }
        self.joints = joints;
        self.weights = weights;
        self.influences = MAX_INFLUENCES;
    }

    /// How many vertices carry no weight at all.
    ///
    /// Worth reporting rather than assuming zero: dropping unknown vertex
    /// groups without redistributing left 1080 of 30901 torso vertices
    /// unweighted in the pipeline, and Blender's exporter then invented a
    /// `neutral_bone` and pinned that cloth to the origin.
    pub fn unweighted(&self) -> usize {
        let width = self.influences.max(1);
        (0..self.vertex_count())
            .filter(|v| self.weights[v * width..v * width + width].iter().all(|w| *w <= 0.0))
            .count()
    }
}

/// Keep the four heaviest influences and renormalise.
///
/// Returns the joints and weights for one vertex. A vertex with no influence at
/// all comes back all-zero rather than weighted to joint 0, because pinning it
/// to whatever bone happens to be first is exactly the failure mode that flung
/// a wrist cuff across the body.
pub fn reduce_influences(joints: [u16; 8], raw: [u8; 8]) -> ([u16; 4], [f32; 4]) {
    let (wide_joints, wide_weights) = keep_influences(joints, raw, MAX_INFLUENCES);
    let mut out_joints = [0u16; 4];
    let mut out_weights = [0.0f32; 4];
    out_joints.copy_from_slice(&wide_joints[..4]);
    out_weights.copy_from_slice(&wide_weights[..4]);
    (out_joints, out_weights)
}

/// Keep the `width` heaviest influences, renormalised; the slots past `width`
/// come back zero. The same rules as [`reduce_influences`] at any width.
pub fn keep_influences(joints: [u16; 8], raw: [u8; 8], width: usize) -> ([u16; 8], [f32; 8]) {
    let mut pairs: Vec<(u16, u8)> = joints
        .iter()
        .copied()
        .zip(raw.iter().copied())
        .filter(|(_, w)| *w > 0)
        .collect();
    // Heaviest first, and ties broken by joint index so the result does not
    // depend on the order the archive happened to store them in.
    pairs.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    pairs.truncate(width.min(WIDE_INFLUENCES));

    let total: f32 = pairs.iter().map(|(_, w)| f32::from(*w)).sum();
    let mut out_joints = [0u16; 8];
    let mut out_weights = [0.0f32; 8];
    if total <= 0.0 {
        return (out_joints, out_weights);
    }
    for (i, (joint, weight)) in pairs.iter().enumerate() {
        out_joints[i] = *joint;
        out_weights[i] = f32::from(*weight) / total;
    }
    (out_joints, out_weights)
}

/// Read a `.skin`/`.skinm` pair into one mesh.
///
/// `skin` is the header half and `skinm` the vertex half; either may be empty
/// when the asset ships only one, and the parts that need the missing half come
/// back empty rather than failing.
pub fn load(skin: &[u8], skinm: &[u8]) -> Result<LoadedMesh, String> {
    load_wide(skin, skinm, MAX_INFLUENCES)
}

/// [`load`], keeping up to `width` influences a vertex -- 4 or 8. A mesh is
/// loaded eight wide only where some vertex uses more than four, so a piece
/// that never needs the second set does not carry one.
pub fn load_wide(skin: &[u8], skinm: &[u8], width: usize) -> Result<LoadedMesh, String> {
    // Bones and material names live in the header half.
    let skeleton = starbreaker_3d::skeleton::parse_skeleton(skin).unwrap_or_default();
    let bone_parents: Vec<Option<usize>> = skeleton
        .iter()
        .map(|bone| bone.parent_index.map(usize::from).filter(|&p| p < skeleton.len()))
        .collect();
    let bones: Vec<String> = skeleton.into_iter().map(|bone| bone.name).collect();

    let names = material_names(skin);

    // Vertex streams live in the other half -- except where an asset ships
    // undivided, in which case the header half carries them too.
    let body = if skinm.is_empty() { skin } else { skinm };
    let ChunkFile::Ivo(ivo) = ChunkFile::from_bytes(body).map_err(|e| format!("not a chunk file: {e}"))?
    else {
        return Err("not an Ivo container".into());
    };
    let entry = ivo
        .chunks()
        .iter()
        .find(|c| c.chunk_type == ivo::IVO_SKIN2)
        .ok_or_else(|| "no IvoSkin2 chunk".to_string())?;
    // One chunk's data, not the whole file.
    let skin_mesh = SkinMesh::read(ivo.chunk_data(entry)).map_err(|e| format!("parsing mesh: {e}"))?;

    // Material names may sit in either half; prefer the header's, which is the
    // order the `.mtl`'s submaterials are in and the order slot matching needs.
    let names = if names.is_empty() { material_names(body) } else { names };
    let built = starbreaker_3d::types::build_mesh(&skin_mesh, &names);

    let vertices = built.positions.len();
    let width = match &skin_mesh.streams.bone_maps32 {
        Some(maps)
            if width > MAX_INFLUENCES
                && maps.iter().any(|m| m.weights.iter().filter(|w| **w > 0).count() > MAX_INFLUENCES) =>
        {
            WIDE_INFLUENCES
        }
        _ => MAX_INFLUENCES,
    };
    let mut out = LoadedMesh {
        positions: Vec::with_capacity(vertices * 3),
        normals: Vec::with_capacity(vertices * 3),
        uvs: Vec::with_capacity(vertices * 2),
        indices: built.indices.clone(),
        joints: vec![0u16; vertices * width],
        weights: vec![0.0f32; vertices * width],
        influences: width,
        bones,
        bone_parents,
        submeshes: built
            .submeshes
            .iter()
            .map(|s| Submesh {
                material_id: s.source_material_id.unwrap_or(s.material_id),
                first_index: s.first_index,
                index_count: s.num_indices,
                node: s.node_parent_index,
            })
            .collect(),
        material_file: names.first().map(|n| n.name.clone()),
        min: [f32::MAX; 3],
        max: [f32::MIN; 3],
    };

    for position in &built.positions {
        out.positions.extend_from_slice(position);
        for i in 0..3 {
            out.min[i] = out.min[i].min(position[i]);
            out.max[i] = out.max[i].max(position[i]);
        }
    }
    if let Some(normals) = &built.normals {
        for normal in normals {
            out.normals.extend_from_slice(normal);
        }
    }
    if let Some(uvs) = &built.uvs {
        for uv in uvs {
            out.uvs.extend_from_slice(uv);
        }
    }

    // Skinning comes in two forms and **both are in use**, which is the trap
    // here: reading only the eight-influence one leaves real armour completely
    // unweighted, silently, because an absent stream is `None` rather than an
    // error. The Sunchaser helmet carries the twelve-byte form and came out
    // with 16,930 of 16,930 vertices unweighted.
    //
    // `BoneMap12` already holds four influences, so it needs no reduction --
    // only the renormalisation, since the archive stores weights as bytes.
    if let Some(maps) = &skin_mesh.streams.bone_maps32 {
        for (vertex, map) in maps.iter().enumerate().take(vertices) {
            let (joints, weights) = keep_influences(map.joint_indices, map.weights, width);
            out.joints[vertex * width..vertex * width + width].copy_from_slice(&joints[..width]);
            out.weights[vertex * width..vertex * width + width].copy_from_slice(&weights[..width]);
        }
    } else if let Some(maps) = &skin_mesh.streams.bone_maps {
        for (vertex, map) in maps.iter().enumerate().take(vertices) {
            let mut wide_joints = [0u16; 8];
            let mut wide_weights = [0u8; 8];
            wide_joints[..4].copy_from_slice(&map.joint_indices);
            wide_weights[..4].copy_from_slice(&map.weights);
            let (joints, weights) = reduce_influences(wide_joints, wide_weights);
            out.joints[vertex * 4..vertex * 4 + 4].copy_from_slice(&joints);
            out.weights[vertex * 4..vertex * 4 + 4].copy_from_slice(&weights);
        }
    }

    if vertices == 0 {
        out.min = [0.0; 3];
        out.max = [0.0; 3];
    }
    Ok(out)
}

fn material_names(bytes: &[u8]) -> Vec<MaterialName> {
    let Ok(ChunkFile::Ivo(ivo)) = ChunkFile::from_bytes(bytes) else {
        return Vec::new();
    };
    ivo.chunks()
        .iter()
        .filter(|c| c.chunk_type == ivo::MTL_NAME_IVO320)
        .filter_map(|c| MaterialName::read(ivo.chunk_data(c)).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_four_heaviest_influences_survive_and_sum_to_one() {
        let joints = [10, 11, 12, 13, 14, 15, 16, 17];
        let weights = [10, 80, 5, 60, 40, 3, 2, 1];
        let (out_joints, out_weights) = reduce_influences(joints, weights);
        assert_eq!(out_joints, [11, 13, 14, 10], "heaviest first");
        let total: f32 = out_weights.iter().sum();
        assert!((total - 1.0).abs() < 1e-6, "renormalised, got {total}");
        assert!(out_weights[0] > out_weights[3]);
    }

    #[test]
    fn a_vertex_with_one_bone_is_fully_weighted_to_it() {
        let (joints, weights) = reduce_influences([7, 0, 0, 0, 0, 0, 0, 0], [255, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(joints[0], 7);
        assert!((weights[0] - 1.0).abs() < 1e-6);
        assert_eq!(&weights[1..], &[0.0, 0.0, 0.0]);
    }

    #[test]
    fn an_unweighted_vertex_is_not_pinned_to_joint_zero() {
        // Weighting it to whatever bone comes first is how a wrist cuff ends up
        // across the body. All-zero is honest, and the caller can see it.
        let (joints, weights) = reduce_influences([3, 4, 5, 6, 7, 8, 9, 10], [0; 8]);
        assert_eq!(weights, [0.0; 4]);
        assert_eq!(joints, [0; 4]);
    }

    #[test]
    fn ties_do_not_depend_on_storage_order() {
        let (a, _) = reduce_influences([5, 2, 9, 1, 0, 0, 0, 0], [50, 50, 50, 50, 0, 0, 0, 0]);
        let (b, _) = reduce_influences([1, 9, 2, 5, 0, 0, 0, 0], [50, 50, 50, 50, 0, 0, 0, 0]);
        assert_eq!(a, b, "equal weights sort by joint index");
        assert_eq!(a, [1, 2, 5, 9]);
    }

    #[test]
    fn eight_equal_influences_keep_only_four_and_still_sum_to_one() {
        let (_, weights) = reduce_influences([0, 1, 2, 3, 4, 5, 6, 7], [32; 8]);
        let total: f32 = weights.iter().sum();
        assert!((total - 1.0).abs() < 1e-6, "got {total}");
        // Each of the four keeps a quarter, not an eighth: the tail is dropped
        // and what remains is renormalised.
        assert!((weights[0] - 0.25).abs() < 1e-6, "got {}", weights[0]);
    }

    #[test]
    fn eight_wide_keeps_every_influence_and_sums_to_one() {
        let (joints, weights) = keep_influences([10, 11, 12, 13, 14, 15, 16, 17], [10, 80, 5, 60, 40, 3, 2, 1], 8);
        assert_eq!(joints, [11, 13, 14, 10, 12, 15, 16, 17], "heaviest first");
        let total: f32 = weights.iter().sum();
        assert!((total - 1.0).abs() < 1e-6, "got {total}");
        // Nothing dropped, so each is its own share of 201.
        assert!((weights[7] - 1.0 / 201.0).abs() < 1e-6);
    }

    #[test]
    fn a_wide_mesh_with_no_fifth_influence_narrows_to_four() {
        let mut mesh = LoadedMesh {
            positions: vec![0.0; 6],
            joints: vec![1, 2, 0, 0, 0, 0, 0, 0, 3, 4, 5, 6, 0, 0, 0, 0],
            weights: vec![0.5, 0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.25, 0.25, 0.25, 0.25, 0.0, 0.0, 0.0, 0.0],
            influences: WIDE_INFLUENCES,
            ..LoadedMesh::default()
        };
        mesh.narrow_if_unused();
        assert_eq!(mesh.influences, MAX_INFLUENCES);
        assert_eq!(mesh.joints, vec![1, 2, 0, 0, 3, 4, 5, 6]);

        let mut used = LoadedMesh {
            positions: vec![0.0; 3],
            joints: vec![1, 2, 3, 4, 5, 0, 0, 0],
            weights: vec![0.3, 0.2, 0.2, 0.2, 0.1, 0.0, 0.0, 0.0],
            influences: WIDE_INFLUENCES,
            ..LoadedMesh::default()
        };
        used.narrow_if_unused();
        assert_eq!(used.influences, WIDE_INFLUENCES, "a fifth influence keeps it wide");
    }

    #[test]
    fn an_empty_mesh_reports_no_vertices_rather_than_failing() {
        let mesh = LoadedMesh::default();
        assert_eq!(mesh.vertex_count(), 0);
        assert_eq!(mesh.triangle_count(), 0);
        assert_eq!(mesh.unweighted(), 0);
    }
}
