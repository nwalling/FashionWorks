//! Retargeting a game animation clip onto the canonical armature.
//!
//! Three approaches were tried in the Python and two of them fail, so the one
//! here is not a choice of convenience:
//!
//! 1. *Copy the clip's local rotations.* Fails. A clip stores absolute local
//!    rotations in the animation rig's bone frames, and ours no longer match
//!    after Collada, Blender and the glTF exporter. The character ends up on
//!    its back, and no axis permutation fixes it -- seven were tried.
//! 2. *Copy world orientations,* obtained by running forward kinematics over
//!    the `.chr` hierarchy. Spine and legs land correctly and the **arms point
//!    at the ceiling**: absolute orientation only transfers where the two rigs'
//!    bone axes agree, and for arms they do not.
//! 3. *Transfer the delta from each rig's own bind pose*,
//!    `delta = world_clip · inverse(world_bind)`. This works, because "rotate
//!    this bone by however far the animation moves it" needs no agreement about
//!    axes at all. Bone lengths stay ours, so the pose adapts to our
//!    proportions.
//!
//! Two details the data dictates. The clip's world space has **up along -Y and
//! forward along +Z**, reaching glTF through a 180-degree rotation about X.
//! And the armature **root is skipped** by the caller: it carries the clip's own
//! world placement, which otherwise drags the whole body a metre sideways.

/// A quaternion as `[w, x, y, z]`, matching the archive's own ordering.
pub type Quat = [f32; 4];
pub type Vec3 = [f32; 3];

/// One bone of the bind pose, as the `.chr` stores it.
#[derive(Debug, Clone)]
pub struct BindBone {
    pub name: String,
    pub parent: Option<usize>,
    pub local_rotation: Quat,
    pub local_position: Vec3,
    pub world_rotation: Quat,
}

/// What a clip says about one bone at the frame being sampled.
#[derive(Debug, Clone, Default)]
pub struct Sample {
    pub rotation: Option<Quat>,
    pub position: Option<Vec3>,
}

/// The retargeted pose for one bone, in glTF axes.
#[derive(Debug, Clone, PartialEq)]
pub struct Posed {
    /// Rotation delta as glTF `[x, y, z, w]`.
    pub delta: [f32; 4],
    pub position: Vec3,
}

pub fn qmul(a: Quat, b: Quat) -> Quat {
    let (aw, ax, ay, az) = (a[0], a[1], a[2], a[3]);
    let (bw, bx, by, bz) = (b[0], b[1], b[2], b[3]);
    [
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
    ]
}

pub fn qconj(q: Quat) -> Quat {
    [q[0], -q[1], -q[2], -q[3]]
}

/// Rotate a vector by a quaternion.
pub fn qrot(q: Quat, v: Vec3) -> Vec3 {
    let t = [
        2.0 * (q[2] * v[2] - q[3] * v[1]),
        2.0 * (q[3] * v[0] - q[1] * v[2]),
        2.0 * (q[1] * v[1] - q[2] * v[0]),
    ];
    [
        v[0] + q[0] * t[0] + q[2] * t[2] - q[3] * t[1],
        v[1] + q[0] * t[1] + q[3] * t[0] - q[1] * t[2],
        v[2] + q[0] * t[2] + q[1] * t[1] - q[2] * t[0],
    ]
}

/// Clip world space to glTF, as xyzw. A 180-degree turn about X.
pub fn to_gltf_quat(q: Quat) -> [f32; 4] {
    [q[1], -q[2], -q[3], q[0]]
}

pub fn to_gltf_position(v: Vec3) -> Vec3 {
    [v[0], -v[1], -v[2]]
}

/// Run forward kinematics over the bind hierarchy, substituting whatever the
/// clip animates, and return each bone's delta from its own bind pose.
///
/// Bones the clip does not animate keep their bind local transform, so their
/// delta comes out as identity -- which is what makes a clip that touches 145
/// of 220 bones leave the other 75 alone rather than resetting them.
pub fn forward_kinematics(
    bind: &[BindBone],
    sample_of: impl Fn(&str) -> Option<Sample>,
) -> Vec<(String, Posed)> {
    let mut world_rotation: Vec<Quat> = vec![[1.0, 0.0, 0.0, 0.0]; bind.len()];
    let mut world_position: Vec<Vec3> = vec![[0.0, 0.0, 0.0]; bind.len()];

    for (i, bone) in bind.iter().enumerate() {
        let mut local_rotation = bone.local_rotation;
        let mut local_position = bone.local_position;
        if let Some(sample) = sample_of(&bone.name) {
            if let Some(r) = sample.rotation {
                local_rotation = r;
            }
            if let Some(p) = sample.position {
                local_position = p;
            }
        }

        match bone.parent {
            None => {
                world_rotation[i] = local_rotation;
                world_position[i] = local_position;
            }
            Some(parent) => {
                world_rotation[i] = qmul(world_rotation[parent], local_rotation);
                let offset = qrot(world_rotation[parent], local_position);
                world_position[i] = [
                    world_position[parent][0] + offset[0],
                    world_position[parent][1] + offset[1],
                    world_position[parent][2] + offset[2],
                ];
            }
        }
    }

    bind.iter()
        .enumerate()
        .map(|(i, bone)| {
            let delta = qmul(world_rotation[i], qconj(bone.world_rotation));
            (
                bone.name.clone(),
                Posed {
                    delta: to_gltf_quat(delta),
                    position: to_gltf_position(world_position[i]),
                },
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: Quat = [1.0, 0.0, 0.0, 0.0];

    fn bone(name: &str, parent: Option<usize>, local: Quat, world: Quat) -> BindBone {
        BindBone {
            name: name.into(),
            parent,
            local_rotation: local,
            local_position: [0.0, 0.0, 0.0],
            world_rotation: world,
        }
    }

    #[test]
    fn an_unanimated_bone_gets_an_identity_delta() {
        // The reason a clip touching 145 of 220 bones leaves the rest alone.
        let bind = vec![bone("World", None, ID, ID), bone("Hips", Some(0), ID, ID)];
        let out = forward_kinematics(&bind, |_| None);
        for (name, posed) in &out {
            assert_eq!(posed.delta, [0.0, -0.0, -0.0, 1.0], "{name} should not move");
        }
    }

    #[test]
    fn the_delta_is_measured_from_the_bone_s_own_bind_pose() {
        // A quarter turn about Z, as the clip would store it.
        let turn: Quat = [0.70710677, 0.0, 0.0, 0.70710677];
        // The bind already has that turn, so animating to it must be a no-op.
        let bind = vec![bone("World", None, turn, turn)];
        let out = forward_kinematics(&bind, |_| {
            Some(Sample { rotation: Some(turn), position: None })
        });
        let d = out[0].1.delta;
        assert!((d[3] - 1.0).abs() < 1e-5, "identity delta, got {d:?}");
    }

    #[test]
    fn rotation_accumulates_down_the_chain() {
        let turn: Quat = [0.70710677, 0.0, 0.0, 0.70710677];
        let bind = vec![bone("World", None, ID, ID), bone("Hips", Some(0), ID, ID)];
        // Turning the parent must move the child too.
        let out = forward_kinematics(&bind, |n| {
            (n == "World").then_some(Sample { rotation: Some(turn), position: None })
        });
        let child = out[1].1.delta;
        assert!((child[3] - 0.70710677).abs() < 1e-5, "child inherits the turn: {child:?}");
    }

    #[test]
    fn gltf_conversion_is_a_180_about_x() {
        // [w,x,y,z] in, [x,y,z,w] out, with y and z negated.
        assert_eq!(to_gltf_quat([1.0, 2.0, 3.0, 4.0]), [2.0, -3.0, -4.0, 1.0]);
        assert_eq!(to_gltf_position([1.0, 2.0, 3.0]), [1.0, -2.0, -3.0]);
    }
}
