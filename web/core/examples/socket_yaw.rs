//! Check the 180-degree yaw a rigid prop needs when mounted to its socket.
//!
//! A rigid prop is authored **around its own origin, not in body space**, and
//! carries locator nodes marking where it mounts. `place_at_socket` composes
//! `bone_rest · locator⁻¹` so the prop's frame lands on the bone.
//!
//! The Python pipeline applies a 180-degree yaw here, and **that yaw is
//! specific to Blender's frame, not to the archive's**. `place_at_socket`
//! composes against `bone.matrix_local`, where a bone's local Y axis runs along
//! the bone; `SOCKET_YAW` corrects for that convention. Composed in the
//! archive's own frame, using the bone's `world_rotation` straight out of the
//! `.skin`, no yaw is needed -- and applying one mounts the pack backwards.
//!
//! A bounding box will not catch either mistake, since a pack's extents look
//! much the same whichever way round it is. Its own `grip_left_1` /
//! `grip_right_1` locators will.
//!
//! This is that test, run against the archive rather than against a render.
//!
//! **The locator's own position does not answer it.** `grip_left_1` sits at
//! x = -0.156 in the prop's local space, which already looks like the
//! character's left -- but the prop is not in body space, and what decides the
//! side is the *composition* `bone_rest · locator⁻¹`, rotations included. So
//! this composes the whole thing and reports where the grip actually lands on
//! the body.
//!
//!   cargo run --example socket_yaw --release -- <backpack.cga> <donor.skin>

use starbreaker_3d::nmc;

/// Rotate a point 180 degrees about the vertical axis: (x, y, z) -> (-x, -y, z).
/// Z is up in this data, so yaw negates x and y and leaves height alone.
fn yaw180(p: [f32; 3]) -> [f32; 3] {
    [-p[0], -p[1], p[2]]
}

/// 3x4 row-major transform times a point.
fn apply(m: &[[f32; 4]; 3], p: [f32; 3]) -> [f32; 3] {
    let mut out = [0.0f32; 3];
    for (i, row) in m.iter().enumerate() {
        out[i] = row[0] * p[0] + row[1] * p[1] + row[2] * p[2] + row[3];
    }
    out
}

/// Inverse of a rigid 3x4 (rotation transposed, translation negated through it).
fn invert(m: &[[f32; 4]; 3]) -> [[f32; 4]; 3] {
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

/// Quaternion [w, x, y, z] and translation to a 3x4.
fn from_quat(q: [f32; 4], t: [f32; 3]) -> [[f32; 4]; 3] {
    let (w, x, y, z) = (q[0], q[1], q[2], q[3]);
    [
        [1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - w * z), 2.0 * (x * z + w * y), t[0]],
        [2.0 * (x * y + w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - w * x), t[1]],
        [2.0 * (x * z - w * y), 2.0 * (y * z + w * x), 1.0 - 2.0 * (x * x + y * y), t[2]],
    ]
}

/// a * b, both 3x4 rigid.
fn mul(a: &[[f32; 4]; 3], b: &[[f32; 4]; 3]) -> [[f32; 4]; 3] {
    let mut out = [[0.0f32; 4]; 3];
    for i in 0..3 {
        for j in 0..3 {
            out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
        out[i][3] = a[i][0] * b[0][3] + a[i][1] * b[1][3] + a[i][2] * b[2][3] + a[i][3];
    }
    out
}

const YAW: [[f32; 4]; 3] = [
    [-1.0, 0.0, 0.0, 0.0],
    [0.0, -1.0, 0.0, 0.0],
    [0.0, 0.0, 1.0, 0.0],
];

fn main() {
    let path = std::env::args().nth(1).expect("usage: socket_yaw <backpack.cga> <donor.skin>");
    let donor_path = std::env::args().nth(2);
    let bytes = std::fs::read(&path).expect("reading .cga");
    let (nodes, _) = nmc::parse_nmc_full(&bytes).expect("no NodeMeshCombo chunk");

    println!("{}  ({} nodes)", path.rsplit('/').next().unwrap_or(&path), nodes.len());

    let locators: Vec<&nmc::NmcNode> = nodes
        .iter()
        .filter(|n| {
            let l = n.name.to_ascii_lowercase();
            l.contains("grip") || l.contains("_loc") || l.contains("attach")
        })
        .collect();

    if locators.is_empty() {
        println!("  no grip or attachment locators");
        let sample: Vec<&str> = nodes.iter().take(10).map(|n| n.name.as_str()).collect();
        println!("  node names: {sample:?}");
        return;
    }

    println!("\n  {:<34} {:>26} {:>26}", "locator", "as authored", "after 180 yaw");
    let mut grips: Vec<(&str, [f32; 3])> = Vec::new();
    for node in &locators {
        // bone_to_world is 3x4 row-major; the translation is its last column.
        let t = [
            node.bone_to_world[0][3],
            node.bone_to_world[1][3],
            node.bone_to_world[2][3],
        ];
        let y = yaw180(t);
        println!(
            "  {:<34} [{:>7.3}{:>8.3}{:>8.3}] [{:>7.3}{:>8.3}{:>8.3}]",
            node.name, t[0], t[1], t[2], y[0], y[1], y[2]
        );
        if node.name.to_ascii_lowercase().contains("grip") {
            grips.push((node.name.as_str(), t));
        }
    }

    // The verdict. A locator named "left" should sit at negative x on the
    // character, since +x is the character's right in this data.
    let left = grips.iter().find(|(n, _)| n.to_ascii_lowercase().contains("left"));
    let right = grips.iter().find(|(n, _)| n.to_ascii_lowercase().contains("right"));
    if let (Some((ln, lt)), Some((rn, rt))) = (left, right) {
        println!("\n  {ln} authored at x={:.3}, {rn} at x={:.3}", lt[0], rt[0]);
        let direct_ok = lt[0] < 0.0 && rt[0] > 0.0;
        let yawed_ok = yaw180(*lt)[0] < 0.0 && yaw180(*rt)[0] > 0.0;
        println!(
            "  composed directly : left is on the character's {}",
            if direct_ok { "LEFT  (correct)" } else { "RIGHT (backwards)" }
        );
        println!(
            "  with a 180 yaw    : left is on the character's {}",
            if yawed_ok { "LEFT  (correct)" } else { "RIGHT (backwards)" }
        );
        println!(
            "\n  {}",
            match (direct_ok, yawed_ok) {
                (false, true) => "PASS  the yaw is required, as the pipeline assumes",
                (true, false) => "the yaw would BREAK this prop -- it is already body-facing",
                _ => "inconclusive: the grips do not disagree about side",
            }
        );
    } else {
        println!("\n  no left/right grip pair on this prop; nothing to decide the yaw with");
    }

    // The composition that actually decides it.
    let Some(donor_path) = donor_path else { return };
    let donor = std::fs::read(&donor_path).expect("reading donor .skin");
    let skel = starbreaker_3d::skeleton::parse_skeleton(&donor).expect("donor skeleton");
    let Some(bone) = skel.iter().find(|b| b.name == "backpack_attach_1_override") else {
        println!("\n  donor has no backpack_attach_1_override");
        return;
    };
    let node = |want: &str| nodes.iter().find(|n| n.name.eq_ignore_ascii_case(want));
    let (Some(loc), Some(gl), Some(gr)) =
        (node("backpack_attach_1_loc"), node("grip_left_1"), node("grip_right_1"))
    else {
        println!("\n  prop is missing a locator needed for the composition");
        return;
    };

    let bone_rest = from_quat(bone.world_rotation, bone.world_position);
    let base = mul(&bone_rest, &invert(&loc.bone_to_world));
    let yawed = mul(&mul(&bone_rest, &YAW), &invert(&loc.bone_to_world));

    let grip = |m: &[[f32; 4]; 3], n: &nmc::NmcNode| {
        apply(m, [n.bone_to_world[0][3], n.bone_to_world[1][3], n.bone_to_world[2][3]])
    };
    let (dl, dr) = (grip(&base, gl), grip(&base, gr));
    let (yl, yr) = (grip(&yawed, gl), grip(&yawed, gr));

    println!("\n  composed on the body at bone {:?}", bone.name);
    println!("    bone rest position   [{:.3} {:.3} {:.3}]", bone.world_position[0], bone.world_position[1], bone.world_position[2]);
    println!("    no yaw : left grip x={:>7.3}   right grip x={:>7.3}", dl[0], dr[0]);
    println!("    180 yaw: left grip x={:>7.3}   right grip x={:>7.3}", yl[0], yr[0]);

    let direct_ok = dl[0] < 0.0 && dr[0] > 0.0;
    let yaw_ok = yl[0] < 0.0 && yr[0] > 0.0;
    println!(
        "\n  {}",
        match (direct_ok, yaw_ok) {
            (false, true) => "the 180 yaw is required in this frame",
            (true, false) => "PASS  no yaw in the archive's frame; adding one mounts it backwards",
            (true, true) => "inconclusive: both readings put the grips on the right sides",
            (false, false) => "inconclusive: neither reading does",
        }
    );
    println!(
        "  normalize_armor's SOCKET_YAW is a Blender-space correction (bone.matrix_local),\n           so it must not be copied into a port that composes natively."
    );
}
