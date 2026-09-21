//! The canonical armature: one skeleton every piece binds to.
//!
//! A piece's joint list is **its own**, and not the skeleton's. One armour
//! piece exports 41 joints of which only 16 exist in the base skeleton; the
//! other 25 are attachment points the armour itself introduces. So there is no
//! pointer swap available at load time -- the joints have to be remapped by
//! name, and the weight on bones that do not survive has to go somewhere.
//!
//! The armature is the base `.chr` **plus the union of the `*_override` bones
//! across armour**, which takes it from 220 bones to 255 with 36 attachment
//! points. That grafting is what makes most meshes have no stray weight at all:
//! the commonest strays are attachment bones, and once the armature has them
//! they are no longer strays.
//!
//! What is left after that is simulation geometry -- `au_shoulder_pad_Left`,
//! `ac_flap_x03_y02` -- which drives cloth and pads and exists only on the
//! piece. [`crate::rebind`] decides where its weight goes.

use std::collections::HashMap;

use starbreaker_3d::skeleton::Bone;

use crate::rebind::{self, Influences};

#[derive(Debug, Clone, PartialEq)]
pub struct ArmatureBone {
    pub name: String,
    pub parent: Option<usize>,
    /// Parent-relative, as the `.chr` stores it.
    pub local_position: [f32; 3],
    pub local_rotation: [f32; 4],
    pub world_position: [f32; 3],
    pub world_rotation: [f32; 4],
    /// True for a grafted attachment point.
    ///
    /// These are marked so nothing ever weights to them: the pipeline sets
    /// `use_deform = False` for the same reason. An attachment bone is a place
    /// to hang a backpack, not a place for skin.
    pub attachment: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Armature {
    pub bones: Vec<ArmatureBone>,
    by_name: HashMap<String, usize>,
}

/// A bone whose name ends this way is an equipment attachment point.
pub const ATTACHMENT_SUFFIX: &str = "_override";

impl Armature {
    /// Build from a base skeleton `.chr`.
    pub fn from_chr(bytes: &[u8]) -> Option<Armature> {
        let bones = starbreaker_3d::skeleton::parse_skeleton(bytes)?;
        let mut armature = Armature::default();
        for bone in &bones {
            armature.push(bone, false);
        }
        Some(armature)
    }

    fn push(&mut self, bone: &Bone, attachment: bool) -> usize {
        let parent = bone
            .parent_index
            .and_then(|p| self.bones.get(p as usize).map(|_| p as usize));
        let index = self.bones.len();
        self.bones.push(ArmatureBone {
            name: bone.name.clone(),
            parent,
            local_position: bone.local_position,
            local_rotation: bone.local_rotation,
            world_position: bone.world_position,
            world_rotation: bone.world_rotation,
            attachment,
        });
        self.by_name.insert(key(&bone.name), index);
        index
    }

    pub fn len(&self) -> usize {
        self.bones.len()
    }

    pub fn is_empty(&self) -> bool {
        self.bones.is_empty()
    }

    pub fn index_of(&self, name: &str) -> Option<usize> {
        self.by_name.get(&key(name)).copied()
    }

    pub fn attachments(&self) -> usize {
        self.bones.iter().filter(|b| b.attachment).count()
    }

    /// Copy a donor's attachment bones onto the armature.
    ///
    /// Returns how many were added. A donor bone is taken when its name ends
    /// `_override`, the armature does not already have it, and **its parent is
    /// a bone the armature already has** -- which every one of the 35 a CDS
    /// undersuit contributes does, so this is a copy rather than a merge. A
    /// donor bone whose parent is missing is skipped rather than reparented to
    /// the root, because a guessed parent puts a holstered sidearm on the wrong
    /// limb and nothing would say so.
    pub fn graft(&mut self, donor: &[Bone]) -> usize {
        let mut added = 0;
        for bone in donor {
            if !bone.name.ends_with(ATTACHMENT_SUFFIX) || self.index_of(&bone.name).is_some() {
                continue;
            }
            let parent_name = bone
                .parent_index
                .and_then(|p| donor.get(p as usize))
                .map(|p| p.name.as_str());
            let Some(parent) = parent_name.and_then(|n| self.index_of(n)) else {
                continue;
            };
            let index = self.bones.len();
            self.bones.push(ArmatureBone {
                name: bone.name.clone(),
                parent: Some(parent),
                local_position: bone.local_position,
                local_rotation: bone.local_rotation,
                world_position: bone.world_position,
                world_rotation: bone.world_rotation,
                attachment: true,
            });
            self.by_name.insert(key(&bone.name), index);
            added += 1;
        }
        added
    }

    /// Where each of a mesh's own joints lands on the armature.
    ///
    /// `None` marks a joint the armature does not have -- a simulation bone
    /// that exists only on the piece.
    pub fn remap(&self, mesh_bones: &[String]) -> Vec<Option<u16>> {
        mesh_bones
            .iter()
            .map(|name| self.index_of(name).map(|i| i as u16))
            .collect()
    }
}

/// Bone names are matched case-insensitively.
///
/// The archive is not consistent about case across the files that name the same
/// bone, and a case-sensitive match silently drops the joint -- which here
/// means its weight goes through the stray path and the piece deforms subtly
/// wrongly rather than failing.
fn key(name: &str) -> String {
    name.to_ascii_lowercase()
}

/// What happened while rebinding one mesh, for reporting rather than guessing.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RebindReport {
    /// Joints the armature has.
    pub mapped: usize,
    /// Joints it does not -- simulation bones local to the piece.
    pub stray: usize,
    /// Vertices whose weight was renormalised onto their surviving bones.
    pub redistributed: usize,
    /// Vertices with nothing left, which needed a guess.
    pub guessed: usize,
    /// Vertices left with no weight at all. Should be zero.
    pub unweighted: usize,
}

/// Rewrite a mesh's joint indices to address the armature.
///
/// `joints` and `weights` are the four-wide per-vertex arrays; both are
/// modified in place. Weights are renormalised so every weighted vertex still
/// sums to one.
pub fn rebind(
    armature: &Armature,
    mesh_bones: &[String],
    joints: &mut [u16],
    weights: &mut [f32],
) -> RebindReport {
    let map = armature.remap(mesh_bones);
    let mut report = RebindReport {
        mapped: map.iter().filter(|m| m.is_some()).count(),
        stray: map.iter().filter(|m| m.is_none()).count(),
        ..RebindReport::default()
    };
    let vertices = joints.len() / 4;

    // Which surviving bone carries the most weight overall, and how busy each
    // one is. Both feed the guess for a vertex with nothing left.
    let mut busiest: HashMap<u16, u64> = HashMap::new();
    for vertex in 0..vertices {
        for slot in 0..4 {
            let weight = weights[vertex * 4 + slot];
            if weight <= 0.0 {
                continue;
            }
            if let Some(Some(target)) = map.get(joints[vertex * 4 + slot] as usize) {
                *busiest.entry(*target).or_default() += (weight * 255.0) as u64;
            }
        }
    }
    let dominant = busiest
        .iter()
        .max_by_key(|(_, total)| **total)
        .map(|(joint, _)| *joint)
        .unwrap_or(0);

    // Candidate bones for the guess: everything the armature has that this mesh
    // actually uses, so a cuff lands on a forearm the piece is already bound to
    // rather than on some unrelated bone across the body.
    let candidates: Vec<(u16, &str)> = map
        .iter()
        .enumerate()
        .filter_map(|(i, target)| {
            let target = (*target)?;
            Some((target, mesh_bones.get(i)?.as_str()))
        })
        .collect();

    for vertex in 0..vertices {
        let influences: Influences = (0..4)
            .filter(|slot| weights[vertex * 4 + slot] > 0.0)
            .map(|slot| {
                (
                    joints[vertex * 4 + slot],
                    (weights[vertex * 4 + slot] * 255.0).round() as u8,
                )
            })
            .collect();
        if influences.is_empty() {
            report.unweighted += 1;
            continue;
        }

        let survives = |joint: u16| matches!(map.get(joint as usize), Some(Some(_)));
        let kept = rebind::redistribute(&influences, survives);

        let resolved: Influences = match kept {
            Some(kept) => {
                if kept.len() != influences.len() {
                    report.redistributed += 1;
                }
                kept.into_iter()
                    .map(|(joint, weight)| (map[joint as usize].unwrap_or(dominant), weight))
                    .collect()
            }
            None => {
                // Nothing survived. The guess prefers a same-side bone sharing
                // a word, then the busiest bone on that side, then the mesh's
                // dominant bone -- side first, because matching on words alone
                // put a right wrist cuff on the left forearm.
                report.guessed += 1;
                let stray_names: Vec<&str> = influences
                    .iter()
                    .filter_map(|(joint, _)| mesh_bones.get(*joint as usize).map(String::as_str))
                    .collect();
                let joint = rebind::guess_bone(&stray_names, &candidates, &busiest, dominant);
                vec![(joint, 255)]
            }
        };

        let total: f32 = resolved.iter().map(|(_, w)| f32::from(*w)).sum();
        for slot in 0..4 {
            joints[vertex * 4 + slot] = 0;
            weights[vertex * 4 + slot] = 0.0;
        }
        for (slot, (joint, weight)) in resolved.iter().take(4).enumerate() {
            joints[vertex * 4 + slot] = *joint;
            weights[vertex * 4 + slot] = f32::from(*weight) / total.max(1.0);
        }
    }

    report
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bone(name: &str, parent: Option<u16>) -> Bone {
        Bone {
            name: name.into(),
            parent_index: parent,
            object_node_index: None,
            local_position: [0.0; 3],
            local_rotation: [1.0, 0.0, 0.0, 0.0],
            world_position: [0.0; 3],
            world_rotation: [1.0, 0.0, 0.0, 0.0],
        }
    }

    fn base() -> Armature {
        let mut armature = Armature::default();
        for b in [
            bone("World", None),
            bone("Hips", Some(0)),
            bone("Spine", Some(1)),
            bone("Spine3", Some(2)),
            bone("LeftForeArm", Some(2)),
            bone("RightForeArm", Some(2)),
        ] {
            armature.push(&b, false);
        }
        armature
    }

    #[test]
    fn the_base_skeleton_has_no_attachment_bones() {
        // Which is why a backpack first rendered at the body origin.
        assert_eq!(base().attachments(), 0);
    }

    #[test]
    fn a_donor_contributes_its_attachment_points() {
        let mut armature = base();
        let donor = vec![
            bone("Spine3", None),
            bone("backpack_attach_1_override", Some(0)),
            bone("helmethook_attach_override", Some(0)),
        ];
        assert_eq!(armature.graft(&donor), 2);
        assert_eq!(armature.len(), 8);
        assert_eq!(armature.attachments(), 2);
        // Parented onto the armature's own Spine3, not the donor's index.
        let grafted = armature.index_of("backpack_attach_1_override").unwrap();
        assert_eq!(armature.bones[grafted].parent, armature.index_of("Spine3"));
    }

    #[test]
    fn grafting_twice_does_not_duplicate() {
        let mut armature = base();
        let donor = vec![bone("Spine3", None), bone("backpack_attach_1_override", Some(0))];
        assert_eq!(armature.graft(&donor), 1);
        assert_eq!(armature.graft(&donor), 0, "already present");
        assert_eq!(armature.len(), 7);
    }

    #[test]
    fn a_donor_bone_with_no_parent_here_is_skipped_not_reparented() {
        // Guessing a parent puts a holstered sidearm on the wrong limb, and
        // nothing downstream would say so.
        let mut armature = base();
        let donor = vec![
            bone("SomeBoneWeDoNotHave", None),
            bone("thruster_left_override", Some(0)),
        ];
        assert_eq!(armature.graft(&donor), 0);
    }

    #[test]
    fn only_override_bones_are_grafted() {
        let mut armature = base();
        let donor = vec![bone("Spine3", None), bone("au_shoulder_pad_Left", Some(0))];
        assert_eq!(armature.graft(&donor), 0, "simulation bones are not attachments");
    }

    #[test]
    fn names_match_regardless_of_case() {
        // A case-sensitive match drops the joint silently, and the piece then
        // deforms subtly wrongly rather than failing.
        assert!(base().index_of("leftforearm").is_some());
        assert!(base().index_of("LEFTFOREARM").is_some());
    }

    #[test]
    fn a_fully_known_mesh_keeps_its_weights() {
        let armature = base();
        let mesh_bones = vec!["Hips".to_string(), "Spine".to_string()];
        let mut joints = vec![0u16, 1, 0, 0];
        let mut weights = vec![0.75f32, 0.25, 0.0, 0.0];
        let report = rebind(&armature, &mesh_bones, &mut joints, &mut weights);
        assert_eq!(report.stray, 0);
        assert_eq!(report.guessed, 0);
        // Hips is armature index 1, Spine is 2.
        assert_eq!(&joints[..2], &[1, 2]);
        assert!((weights[0] - 0.75).abs() < 1e-3, "got {}", weights[0]);
        assert!((weights[0] + weights[1] - 1.0).abs() < 1e-5);
    }

    #[test]
    fn stray_weight_goes_to_the_vertex_s_own_surviving_bones() {
        // Not to one bone per mesh: that flung a right wrist cuff onto
        // LeftForeArm on the Defiance arms.
        let armature = base();
        let mesh_bones = vec!["RightForeArm".to_string(), "RightWrist_CuffTwist".to_string()];
        let mut joints = vec![0u16, 1, 0, 0];
        let mut weights = vec![0.5f32, 0.5, 0.0, 0.0];
        let report = rebind(&armature, &mesh_bones, &mut joints, &mut weights);
        assert_eq!(report.stray, 1, "the cuff bone is not on the armature");
        assert_eq!(report.guessed, 0, "it had a surviving bone of its own");
        assert_eq!(joints[0], armature.index_of("RightForeArm").unwrap() as u16);
        assert!((weights[0] - 1.0).abs() < 1e-5, "renormalised, got {}", weights[0]);
    }

    #[test]
    fn a_vertex_with_nothing_left_is_guessed_onto_its_own_side() {
        let armature = base();
        let mesh_bones = vec![
            "LeftForeArm".to_string(),          // 0, survives
            "RightForeArm".to_string(),         // 1, survives
            "RightWrist_CuffTwist".to_string(), // 2, stray
        ];
        // Two vertices: one anchoring weight on each forearm so both are
        // candidates, and one weighted only to the stray right-side cuff.
        let mut joints = vec![0u16, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0];
        let mut weights = vec![1.0f32, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0];
        let report = rebind(&armature, &mesh_bones, &mut joints, &mut weights);
        assert_eq!(report.guessed, 1);
        assert_eq!(
            joints[8],
            armature.index_of("RightForeArm").unwrap() as u16,
            "side is the signal that holds"
        );
        assert_eq!(report.unweighted, 0);
    }

    #[test]
    fn nothing_is_left_unweighted() {
        // Dropping stray weight outright left 1080 of 30901 torso vertices
        // unweighted, and the exporter then pinned that cloth to the origin.
        let armature = base();
        let mesh_bones = vec!["Hips".to_string(), "ac_flap_x03_y02".to_string()];
        let mut joints = vec![1u16, 0, 0, 0];
        let mut weights = vec![1.0f32, 0.0, 0.0, 0.0];
        let report = rebind(&armature, &mesh_bones, &mut joints, &mut weights);
        assert_eq!(report.unweighted, 0);
        let total: f32 = weights.iter().sum();
        assert!((total - 1.0).abs() < 1e-5, "got {total}");
    }
}
