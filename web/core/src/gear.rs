//! Gear: weapons, knives, pens, grenades, magazines and gadgets.
//!
//! Armour is a skinned `.skin` bound to the body, or a rigid `.cga` on a
//! socket. Gear is a third shape. **397 of the 436 personal weapons are rooted
//! in a `.cdf`**, a character definition that names a `.chr` skeleton and the
//! parts that hang off it:
//!
//! ```text
//! <CharacterDefinition>
//!   <Model File="...brfl_fps_behr_p4ar.chr" Material="...brfl_fps_behr_p4ar_mat" />
//!   <AttachmentList>
//!     <Attachment Type="CA_SKIN" AName="parts" Binding="...p4ar_parts.skin" Material="..." />
//!     <Attachment Type="CA_BONE" AName="bullet" Binding="...556mm.cgf" BoneName="bullet"
//!                 RelPosition="0,0,0" RelRotation="1,0,0,0" />
//!   </AttachmentList>
//! </CharacterDefinition>
//! ```
//!
//! The `.chr` is not a body skeleton; it is the weapon's **helpers**:
//! `magAttach` where the magazine goes, `weapon_term` at the muzzle,
//! `R_IkGripTarget` for the hand, and -- the ones that matter for holstering --
//! `attach_offset_left_01` and `attach_offset_right_01`, the points an armour
//! port names as the item's side of the mount. Knives and magazines are plain
//! `.cgf` and carry the same names as NMC helper nodes instead. Either way the
//! placement is the backpack's `bone_world . locator^-1`, unchanged.
//!
//! Everything here is drawn at bind pose. The skin's vertices already sit in
//! the weapon's own space there -- bolt closed, magazine seated -- which is how
//! a holstered or held weapon looks.

use std::collections::HashMap;

use starbreaker_3d::nmc;

use crate::mesh::LoadedMesh;
use crate::socket::{self, Transform, IDENTITY};

/// One entry of a character definition's attachment list.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Attachment {
    pub kind: String,
    pub name: String,
    pub binding: String,
    pub material: Option<String>,
    pub bone: Option<String>,
    pub rel_position: [f32; 3],
    /// `[w, x, y, z]`, as the file writes it.
    pub rel_rotation: [f32; 4],
}

impl Attachment {
    /// A skinned part or a rigid part on a bone. `CA_PROX` (collision) and
    /// `CA_PROW` (simulated strands) are not drawn.
    pub fn renderable(&self) -> bool {
        (self.kind == "CA_SKIN" || self.kind == "CA_BONE") && !self.binding.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct CharacterDefinition {
    pub model: Option<String>,
    pub material: Option<String>,
    pub attachments: Vec<Attachment>,
}

fn floats<const N: usize>(value: &str, fallback: [f32; N]) -> [f32; N] {
    let parts: Vec<f32> = value.split(',').filter_map(|p| p.trim().parse().ok()).collect();
    if parts.len() != N {
        return fallback;
    }
    let mut out = fallback;
    out.copy_from_slice(&parts);
    out
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Parse a `.cdf`, binary CryXML as the archive ships it.
pub fn parse_cdf(bytes: &[u8]) -> Result<CharacterDefinition, String> {
    let xml = starbreaker_cryxml::from_bytes(bytes).map_err(|e| format!("reading .cdf: {e}"))?;
    let mut out = CharacterDefinition::default();
    let mut stack = vec![xml.root()];
    while let Some(node) = stack.pop() {
        let tag = xml.node_tag(node);
        let attrs: HashMap<&str, &str> = xml.node_attributes(node).collect();
        match tag {
            "Model" => {
                out.model = attrs.get("File").and_then(|v| non_empty(v));
                out.material = attrs.get("Material").and_then(|v| non_empty(v));
            }
            "Attachment" => out.attachments.push(Attachment {
                kind: attrs.get("Type").map(|v| v.trim().to_string()).unwrap_or_default(),
                name: attrs.get("AName").map(|v| v.to_string()).unwrap_or_default(),
                binding: attrs.get("Binding").map(|v| v.trim().to_string()).unwrap_or_default(),
                material: attrs.get("Material").and_then(|v| non_empty(v)),
                bone: attrs.get("BoneName").and_then(|v| non_empty(v)),
                rel_position: attrs.get("RelPosition").map_or([0.0; 3], |v| floats(v, [0.0; 3])),
                rel_rotation: attrs
                    .get("RelRotation")
                    .map_or([1.0, 0.0, 0.0, 0.0], |v| floats(v, [1.0, 0.0, 0.0, 0.0])),
            }),
            _ => {}
        }
        // Children in document order.
        let children: Vec<_> = xml.node_children(node).collect();
        for child in children.into_iter().rev() {
            stack.push(child);
        }
    }
    // Document order for attachments, which the stack reversed twice.
    Ok(out)
}

/// A drawable part of a gear item, in the item's own space.
#[derive(Debug, Clone)]
pub struct Part {
    pub name: String,
    pub mesh: LoadedMesh,
    /// The `.mtl` the definition names for this part, if it names one.
    pub material: Option<String>,
}

/// Move a mesh by a rigid transform, positions and normals both.
pub fn transform_mesh(mesh: &mut LoadedMesh, m: &Transform) {
    if *m == IDENTITY {
        return;
    }
    for chunk in mesh.positions.chunks_exact_mut(3) {
        let p = socket::apply(m, [chunk[0], chunk[1], chunk[2]]);
        chunk.copy_from_slice(&p);
    }
    for chunk in mesh.normals.chunks_exact_mut(3) {
        let n = [chunk[0], chunk[1], chunk[2]];
        let mut out = [0.0f32; 3];
        for (i, row) in m.iter().enumerate() {
            out[i] = row[0] * n[0] + row[1] * n[1] + row[2] * n[2];
        }
        chunk.copy_from_slice(&out);
    }
    let mut min = [f32::MAX; 3];
    let mut max = [f32::MIN; 3];
    for chunk in mesh.positions.chunks_exact(3) {
        for i in 0..3 {
            min[i] = min[i].min(chunk[i]);
            max[i] = max[i].max(chunk[i]);
        }
    }
    if !mesh.positions.is_empty() {
        mesh.min = min;
        mesh.max = max;
    }
}

/// Put each group of a rigid mesh where its node says.
///
/// A multi-part `.cga` -- a rifle whose barrel, bolt, covers and selectors are
/// separate nodes so they can animate -- stores each group's vertices in its
/// **node's** space, and the node's `bone_to_world` places it. Loaded without
/// it, the Arlington came out as a stack of slabs at the origin, every part
/// the right shape and none of them where it belongs.
pub fn place_nodes(mesh: &mut LoadedMesh, nodes: &[nmc::NmcNode]) {
    let vertices = mesh.positions.len() / 3;
    let mut moved = vec![false; vertices];
    let groups = mesh.submeshes.clone();
    for group in &groups {
        let Some(node) = nodes.get(usize::from(group.node)) else { continue };
        let m = node.bone_to_world;
        if m == IDENTITY || m.iter().all(|row| row.iter().all(|v| *v == 0.0)) {
            continue;
        }
        let start = group.first_index as usize;
        let end = (start + group.index_count as usize).min(mesh.indices.len());
        for &index in &mesh.indices[start..end] {
            let v = index as usize;
            if v >= vertices || moved[v] {
                continue;
            }
            moved[v] = true;
            let p = socket::apply(&m, [mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]]);
            mesh.positions[v * 3..v * 3 + 3].copy_from_slice(&p);
            if mesh.normals.len() >= v * 3 + 3 {
                let n = [mesh.normals[v * 3], mesh.normals[v * 3 + 1], mesh.normals[v * 3 + 2]];
                for (i, row) in m.iter().enumerate() {
                    mesh.normals[v * 3 + i] = row[0] * n[0] + row[1] * n[1] + row[2] * n[2];
                }
            }
        }
    }
    if moved.iter().any(|m| *m) {
        let mut min = [f32::MAX; 3];
        let mut max = [f32::MIN; 3];
        for chunk in mesh.positions.chunks_exact(3) {
            for i in 0..3 {
                min[i] = min[i].min(chunk[i]);
                max[i] = max[i].max(chunk[i]);
            }
        }
        mesh.min = min;
        mesh.max = max;
    }
}

/// Helpers by name, as world transforms in the item's own space.
pub type Helpers = HashMap<String, Transform>;

/// A `.chr`'s bones as helpers, at bind pose.
pub fn chr_helpers(chr: &[u8]) -> Helpers {
    starbreaker_3d::skeleton::parse_skeleton(chr)
        .unwrap_or_default()
        .into_iter()
        .map(|bone| (bone.name, socket::from_quat(bone.world_rotation, bone.world_position)))
        .collect()
}

/// A `.cgf`/`.cga`'s NMC helper nodes.
pub fn nmc_helpers(bytes: &[u8]) -> Helpers {
    socket::Prop::parse(bytes)
        .map(|prop| {
            prop.nodes
                .iter()
                .filter(|n| socket::is_helper(n))
                .map(|n: &nmc::NmcNode| (n.name.clone(), n.bone_to_world))
                .collect()
        })
        .unwrap_or_default()
}

/// Find a helper by name, ignoring case.
pub fn helper<'a>(helpers: &'a Helpers, name: &str) -> Option<&'a Transform> {
    helpers
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case(name))
        .map(|(_, m)| m)
}

/// The mount for a gear item: the inverse of the locator the port names, or
/// `None` when the item does not carry it.
///
/// **Exactly the name asked for.** `socket::mount_for` falls back to any helper
/// sharing a leading word, which for `attach_offset_left_01` would find
/// `attach_offset_right_01` -- a mount mirrored through the item, facing the
/// wrong way on the wrong side, which is worse than the origin.
pub fn mount(helpers: &Helpers, locator: &str) -> Option<Transform> {
    helper(helpers, locator).map(socket::mount)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floats_read_or_fall_back() {
        assert_eq!(floats("0.1, 0.2,0.3", [0.0; 3]), [0.1, 0.2, 0.3]);
        assert_eq!(floats("1,0,0,0", [0.0; 4]), [1.0, 0.0, 0.0, 0.0]);
        assert_eq!(floats("nonsense", [9.0; 3]), [9.0; 3]);
        assert_eq!(floats("1,2", [9.0; 3]), [9.0; 3], "wrong arity is not a partial read");
    }

    #[test]
    fn only_skins_and_bone_parts_draw() {
        let part = |kind: &str| Attachment { kind: kind.into(), binding: "x.skin".into(), ..Default::default() };
        assert!(part("CA_SKIN").renderable());
        assert!(part("CA_BONE").renderable());
        assert!(!part("CA_PROX").renderable());
        assert!(!part("CA_PROW").renderable());
    }

    #[test]
    fn a_bone_part_moves_with_its_bone() {
        let mut mesh = LoadedMesh {
            positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            normals: vec![1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            ..Default::default()
        };
        // A quarter turn about Z, then up 2.
        let s = std::f32::consts::FRAC_1_SQRT_2;
        let m = socket::from_quat([s, 0.0, 0.0, s], [0.0, 0.0, 2.0]);
        transform_mesh(&mut mesh, &m);
        assert!((mesh.positions[3] - 0.0).abs() < 1e-5 && (mesh.positions[4] - 1.0).abs() < 1e-5);
        assert!((mesh.positions[5] - 2.0).abs() < 1e-5);
        assert!((mesh.normals[1] - 1.0).abs() < 1e-5, "normals rotate, and do not translate");
        assert!((mesh.max[2] - 2.0).abs() < 1e-5);
    }

    #[test]
    fn a_mount_is_the_named_locator_and_never_its_mirror() {
        let mut helpers = Helpers::new();
        helpers.insert("attach_offset_right_01".into(), socket::from_quat([1.0, 0.0, 0.0, 0.0], [0.03, 0.0, 0.1]));
        assert!(mount(&helpers, "attach_offset_left_01").is_none());
        let m = mount(&helpers, "ATTACH_OFFSET_RIGHT_01").expect("case-insensitive");
        assert!((m[0][3] + 0.03).abs() < 1e-6, "the inverse moves the locator to the origin");
    }
}
