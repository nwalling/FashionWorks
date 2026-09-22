//! Mounting a rigid prop on a socket.
//!
//! A backpack is not skinned. It is a single `.cga` with no bone weights at
//! all, and it hangs off one attachment bone -- `backpack_attach_1_override`,
//! which the base skeleton does not have and an undersuit donates.
//!
//! **The prop is authored around its own origin, not in body space**, and
//! carries locator nodes marking where it mounts: a `backpack_attach_1_loc`
//! that pairs with the bone of almost the same name. Placing it is
//! `bone_world · locator⁻¹`, which maps the prop's own space onto the body.
//!
//! Two earlier attempts in the pipeline were wrong and are worth not
//! repeating. Baking the mesh into the bone's local space in Blender fought the
//! exporter's Z-up to Y-up conversion of the bone's rest rotation and put packs
//! 1.3 m off the body. Skipping the locator and using the bone position alone
//! left the pack floating at head height, because **the prop's origin is not
//! its mount point**.
//!
//! And the 180-degree yaw the pipeline applies here **must not be ported**. It
//! corrects for Blender's bone convention, where a bone's local Y runs along
//! the bone; composed in the archive's own frame it mounts the pack backwards.
//! A bounding box cannot catch that -- a pack's extents look much the same
//! either way -- but the prop's own `grip_left_1` and `grip_right_1` locators
//! can, and do.

use starbreaker_3d::nmc;

/// A rigid 3x4 row-major transform: rotation in the first three columns,
/// translation in the fourth.
pub type Transform = [[f32; 4]; 3];

pub const IDENTITY: Transform = [
    [1.0, 0.0, 0.0, 0.0],
    [0.0, 1.0, 0.0, 0.0],
    [0.0, 0.0, 1.0, 0.0],
];

/// Inverse of a rigid transform: rotation transposed, translation back through it.
pub fn invert(m: &Transform) -> Transform {
    let mut out = [[0.0f32; 4]; 3];
    for i in 0..3 {
        for j in 0..3 {
            out[i][j] = m[j][i];
        }
    }
    let t = [m[0][3], m[1][3], m[2][3]];
    for i in 0..3 {
        out[i][3] = -(out[i][0] * t[0] + out[i][1] * t[1] + out[i][2] * t[2]);
    }
    out
}

pub fn multiply(a: &Transform, b: &Transform) -> Transform {
    let mut out = [[0.0f32; 4]; 3];
    for i in 0..3 {
        for j in 0..3 {
            out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
        out[i][3] = a[i][0] * b[0][3] + a[i][1] * b[1][3] + a[i][2] * b[2][3] + a[i][3];
    }
    out
}

pub fn apply(m: &Transform, p: [f32; 3]) -> [f32; 3] {
    let mut out = [0.0f32; 3];
    for (i, row) in m.iter().enumerate() {
        out[i] = row[0] * p[0] + row[1] * p[1] + row[2] * p[2] + row[3];
    }
    out
}

/// Quaternion `[w, x, y, z]` plus translation to a rigid transform.
pub fn from_quat(q: [f32; 4], t: [f32; 3]) -> Transform {
    let (w, x, y, z) = (q[0], q[1], q[2], q[3]);
    [
        [1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - w * z), 2.0 * (x * z + w * y), t[0]],
        [2.0 * (x * y + w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - w * x), t[1]],
        [2.0 * (x * z - w * y), 2.0 * (y * z + w * x), 1.0 - 2.0 * (x * x + y * y), t[2]],
    ]
}

/// A node in a prop's tree that is not geometry.
///
/// `geometry_type` 0 is a mesh; the locators are helpers. Matching on the type
/// rather than on the name means a prop whose mount is spelled differently is
/// still found by [`mount_for`]'s fallbacks.
pub fn is_helper(node: &nmc::NmcNode) -> bool {
    node.geometry_type != 0
}

/// The locator a socket bone mounts to.
///
/// Tried in order: the bone's name with `_override` swapped for `_loc`, which
/// is the convention (`backpack_attach_1_override` ->
/// `backpack_attach_1_loc`); then the bone's name exactly, since some props
/// carry the `_override` name itself; then any helper whose name shares the
/// socket's leading word.
pub fn mount_for<'a>(nodes: &'a [nmc::NmcNode], socket: &str) -> Option<&'a nmc::NmcNode> {
    let socket_lower = socket.to_ascii_lowercase();
    let expected = socket_lower.replace("_override", "_loc");

    if let Some(node) = nodes.iter().find(|n| n.name.to_ascii_lowercase() == expected) {
        return Some(node);
    }
    if let Some(node) = nodes.iter().find(|n| n.name.to_ascii_lowercase() == socket_lower) {
        return Some(node);
    }
    let stem = socket_lower.split('_').next()?;
    nodes
        .iter()
        .filter(|n| is_helper(n))
        .find(|n| n.name.to_ascii_lowercase().starts_with(stem))
}

/// Where a prop's own space sits once mounted, in world space.
///
/// `bone` is the socket bone's world transform from the skeleton; `locator` the
/// mount node's transform within the prop. **No yaw**: see the module note.
///
/// Use this to *report* where something lands. To actually hang the prop off
/// the bone in a scene graph, use [`mount`] instead and let the bone supply its
/// own transform -- composing the bone in here and then parenting to it applies
/// it twice, which floated a backpack a metre above the head.
pub fn place(bone: &Transform, locator: &Transform) -> Transform {
    multiply(bone, &invert(locator))
}

/// A prop's local matrix when parented to its socket bone.
///
/// Just the inverse of the mount locator: the bone contributes the rest. This
/// is the one a renderer wants, and keeping it separate from [`place`] is what
/// stops the bone being applied twice.
pub fn mount(locator: &Transform) -> Transform {
    invert(locator)
}

/// Every node of a prop, with the mesh nodes and helpers separated.
pub struct Prop {
    pub nodes: Vec<nmc::NmcNode>,
}

impl Prop {
    pub fn parse(cga: &[u8]) -> Option<Prop> {
        let (nodes, _) = nmc::parse_nmc_full(cga)?;
        Some(Prop { nodes })
    }

    pub fn helpers(&self) -> impl Iterator<Item = &nmc::NmcNode> {
        self.nodes.iter().filter(|n| is_helper(n))
    }

    /// The grips, which are what tell left from right.
    ///
    /// A pack's extents look much the same whichever way round it is mounted,
    /// so these are the only thing that catches a backwards mount.
    pub fn grip(&self, side: &str) -> Option<&nmc::NmcNode> {
        let want = format!("grip_{}_1", side.to_ascii_lowercase());
        self.nodes.iter().find(|n| n.name.to_ascii_lowercase() == want)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(name: &str, geometry_type: u16, t: [f32; 3]) -> nmc::NmcNode {
        let mut m = IDENTITY;
        for i in 0..3 {
            m[i][3] = t[i];
        }
        nmc::NmcNode {
            name: name.into(),
            parent_index: None,
            world_to_bone: invert(&m),
            bone_to_world: m,
            scale: [1.0; 3],
            geometry_type,
            properties: Default::default(),
        }
    }

    #[test]
    fn inverting_a_transform_undoes_it() {
        let m = from_quat([0.7071068, 0.7071068, 0.0, 0.0], [0.1, -0.2, 1.44]);
        let back = multiply(&m, &invert(&m));
        for i in 0..3 {
            for j in 0..3 {
                let want = if i == j { 1.0 } else { 0.0 };
                assert!((back[i][j] - want).abs() < 1e-5, "{back:?}");
            }
            assert!(back[i][3].abs() < 1e-5, "translation should cancel: {back:?}");
        }
    }

    #[test]
    fn the_mount_puts_the_locator_on_the_bone() {
        // This is the whole point of the composition: wherever the locator sits
        // inside the prop, it must end up exactly at the bone.
        let bone = from_quat([1.0, 0.0, 0.0, 0.0], [0.0, -0.130, 1.440]);
        let locator = from_quat([1.0, 0.0, 0.0, 0.0], [0.0, 0.0, 0.028]);
        let placed = place(&bone, &locator);
        // The locator's own origin, taken through the placement.
        let landed = apply(&placed, [0.0, 0.0, 0.028]);
        assert!((landed[0] - 0.0).abs() < 1e-5);
        assert!((landed[1] + 0.130).abs() < 1e-5);
        assert!((landed[2] - 1.440).abs() < 1e-5, "got {landed:?}");
    }

    #[test]
    fn the_prop_s_origin_is_not_its_mount_point() {
        // Using the bone position alone left packs floating at head height.
        let bone = from_quat([1.0, 0.0, 0.0, 0.0], [0.0, -0.130, 1.440]);
        let locator = from_quat([1.0, 0.0, 0.0, 0.0], [0.0, 0.0, 0.028]);
        let placed = place(&bone, &locator);
        let origin = apply(&placed, [0.0, 0.0, 0.0]);
        assert!((origin[2] - 1.412).abs() < 1e-5, "offset by the locator: {origin:?}");
    }

    #[test]
    fn a_mount_is_found_by_the_loc_convention() {
        let nodes = vec![
            node("mesh", 0, [0.0; 3]),
            node("backpack_attach_1_loc", 3, [0.0, 0.0, 0.028]),
        ];
        let found = mount_for(&nodes, "backpack_attach_1_override").unwrap();
        assert_eq!(found.name, "backpack_attach_1_loc");
    }

    #[test]
    fn a_prop_carrying_the_override_name_itself_still_mounts() {
        let nodes = vec![node("gadget_attach_1_override", 3, [0.0, -0.29, 0.103])];
        assert!(mount_for(&nodes, "gadget_attach_1_override").is_some());
    }

    #[test]
    fn a_mesh_node_is_never_taken_as_a_mount() {
        // Falling back to a geometry node would mount the pack to its own hull.
        let nodes = vec![node("backpack_shell", 0, [0.0; 3])];
        assert!(mount_for(&nodes, "backpack_attach_1_override").is_none());
    }

    #[test]
    fn the_mount_is_bone_relative_and_place_is_not() {
        // Parenting to a bone and *also* composing the bone in applies it
        // twice. The measured symptom was a backpack at y 2.5-3.5 on a body
        // whose torso spans 1.0-1.73.
        let bone = from_quat([1.0, 0.0, 0.0, 0.0], [0.0, -0.130, 1.440]);
        let locator = from_quat([1.0, 0.0, 0.0, 0.0], [0.0, 0.0, 0.028]);

        let bone_relative = mount(&locator);
        assert!(bone_relative[2][3].abs() < 0.1, "no body height in it: {bone_relative:?}");

        // Composing the bone onto the bone-relative matrix reproduces `place`,
        // which is what the scene graph does for us.
        let composed = multiply(&bone, &bone_relative);
        let world = place(&bone, &locator);
        for i in 0..3 {
            for j in 0..4 {
                assert!((composed[i][j] - world[i][j]).abs() < 1e-6);
            }
        }
    }

    #[test]
    fn no_yaw_is_applied() {
        // The pipeline's SOCKET_YAW is a Blender-frame correction. Composed
        // natively it mounts the pack backwards: the measured case is
        // grip_left_1 authored at x = -0.156, which must stay negative.
        let bone = from_quat([1.0, 0.0, 0.0, 0.0], [0.0, -0.130, 1.440]);
        let locator = from_quat([1.0, 0.0, 0.0, 0.0], [0.0, 0.0, 0.028]);
        let placed = place(&bone, &locator);
        let left_grip = apply(&placed, [-0.156, 0.011, 0.095]);
        assert!(left_grip[0] < 0.0, "left stays left, got {left_grip:?}");
    }
}
