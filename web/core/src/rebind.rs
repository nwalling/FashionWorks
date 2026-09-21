//! Moving skin weight off bones the canonical armature does not have.
//!
//! A piece's joint list is its own, not the skeleton's. Most of the strays are
//! `*_override` attachment points that carry no weight, and grafting those onto
//! the armature removes them from the problem entirely -- measured across a
//! spread of armour, most meshes have **no** stray weight at all once that is
//! done. What is left is simulation geometry: `au_shoulder_pad_Left`,
//! `ac_flap_x03_y02` and the like, bones that drive cloth and pads and exist
//! only on the piece.
//!
//! That weight cannot simply be dropped. Doing so left 1080 of 30901 torso
//! vertices unweighted, and Blender's exporter then invented a `neutral_bone`
//! and pinned that cloth to the origin.
//!
//! **Nor can it go to one bone per mesh.** That was tried: a bracelet on the
//! Defiance arms and a left shoulderpad on the Antium set were flung across the
//! body, because the Defiance arms sent 1828 vertices to `LeftForeArm` -- the
//! right wrist cuff among them -- and the Antium arms sent 8037 to `RightArm`,
//! including the left shoulder. Stray weight goes to **each vertex's own**
//! surviving bones, renormalised, which is right whenever a cuff is also
//! weighted to the forearm it sits on.
//!
//! Only a vertex with nothing left needs a guess, and that is a small minority:
//! 759 of 31413 on the worst mesh measured.

use std::collections::HashMap;

/// One vertex's influences, as (joint index, weight) with weights summing to 255.
pub type Influences = Vec<(u16, u8)>;

/// Which side of the body a bone name refers to, if it says.
///
/// **Side is the reliable signal, not the words.** Anatomy names barely
/// overlap: nothing in `LeftWrist_CuffTwist` matches `LeftForeArm` except the
/// side. Tokenising has to split camelCase as well as separators, or
/// `LeftWrist` stays welded together and matches nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Left,
    Right,
}

pub fn side_of(name: &str) -> Option<Side> {
    for token in tokens(name) {
        match token.as_str() {
            "left" | "l" | "lt" => return Some(Side::Left),
            "right" | "r" | "rt" => return Some(Side::Right),
            _ => {}
        }
    }
    None
}

/// Lowercased words, splitting on separators *and* camelCase boundaries.
pub fn tokens(name: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut prev_lower = false;
    for ch in name.chars() {
        if ch == '_' || ch == '-' || ch == '.' || ch == ' ' {
            if !current.is_empty() {
                out.push(std::mem::take(&mut current));
            }
            prev_lower = false;
            continue;
        }
        if ch.is_ascii_uppercase() && prev_lower && !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }
        prev_lower = ch.is_ascii_lowercase() || ch.is_ascii_digit();
        current.push(ch.to_ascii_lowercase());
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// Redistribute a vertex's stray weight onto its own surviving bones.
///
/// Returns `None` when the vertex has no surviving bone, which is the caller's
/// signal to fall back to [`guess_bone`].
pub fn redistribute(influences: &Influences, survives: impl Fn(u16) -> bool) -> Option<Influences> {
    let kept: Influences = influences.iter().copied().filter(|(j, _)| survives(*j)).collect();
    if kept.is_empty() {
        return None;
    }
    let kept_total: u32 = kept.iter().map(|(_, w)| *w as u32).sum();
    if kept_total == 0 {
        return None;
    }
    // Renormalise to 255, giving the remainder to the heaviest so the sum is
    // exact rather than 254 or 256.
    let mut out: Influences = kept
        .iter()
        .map(|(j, w)| (*j, ((*w as u32 * 255) / kept_total) as u8))
        .collect();
    let sum: u32 = out.iter().map(|(_, w)| *w as u32).sum();
    if sum < 255 {
        if let Some(heaviest) = out.iter_mut().max_by_key(|(_, w)| *w) {
            heaviest.1 = heaviest.1.saturating_add((255 - sum) as u8);
        }
    }
    Some(out)
}

/// Pick a bone for a vertex that has none left.
///
/// Prefers a surviving bone on the same side sharing a word, then the busiest
/// surviving bone on that side, then the mesh's dominant bone. Side comes first
/// because it is the signal that actually holds: matching on words alone put a
/// right wrist cuff on the left forearm.
pub fn guess_bone(
    stray_names: &[&str],
    candidates: &[(u16, &str)],
    busiest: &HashMap<u16, u64>,
    dominant: u16,
) -> u16 {
    let want_side = stray_names.iter().find_map(|n| side_of(n));
    let same_side: Vec<&(u16, &str)> = candidates
        .iter()
        .filter(|(_, name)| want_side.is_none() || side_of(name) == want_side)
        .collect();

    if !same_side.is_empty() {
        let stray_tokens: Vec<String> =
            stray_names.iter().flat_map(|n| tokens(n)).collect();
        let shared = same_side
            .iter()
            .filter_map(|(joint, name)| {
                let overlap = tokens(name)
                    .iter()
                    .filter(|t| t.len() > 1 && stray_tokens.contains(t) && !is_side_token(t))
                    .count();
                (overlap > 0).then_some((overlap, *joint))
            })
            .max_by_key(|(overlap, joint)| (*overlap, busiest.get(joint).copied().unwrap_or(0)));
        if let Some((_, joint)) = shared {
            return joint;
        }
        if let Some((joint, _)) = same_side
            .iter()
            .max_by_key(|(joint, _)| busiest.get(joint).copied().unwrap_or(0))
        {
            return *joint;
        }
    }
    dominant
}

fn is_side_token(token: &str) -> bool {
    matches!(token, "left" | "right" | "l" | "r" | "lt" | "rt")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camel_case_splits_or_side_is_invisible() {
        // The whole reason tokenising exists: `LeftWrist` must yield `left`.
        assert_eq!(tokens("LeftWrist_CuffTwist"), ["left", "wrist", "cuff", "twist"]);
        assert_eq!(side_of("LeftWrist_CuffTwist"), Some(Side::Left));
        assert_eq!(side_of("RightForeArm"), Some(Side::Right));
        assert_eq!(side_of("Spine3"), None);
    }

    #[test]
    fn stray_weight_renormalises_onto_the_vertex_s_own_bones() {
        // Two thirds of this vertex is on a bone that does not survive.
        let v: Influences = vec![(1, 85), (99, 170)];
        let out = redistribute(&v, |j| j != 99).unwrap();
        assert_eq!(out, vec![(1, 255)], "the survivor takes it all");
        let total: u32 = out.iter().map(|(_, w)| *w as u32).sum();
        assert_eq!(total, 255);
    }

    #[test]
    fn proportions_between_survivors_are_kept() {
        let v: Influences = vec![(1, 60), (2, 120), (99, 75)];
        let out = redistribute(&v, |j| j != 99).unwrap();
        let total: u32 = out.iter().map(|(_, w)| *w as u32).sum();
        assert_eq!(total, 255, "sums exactly, no 254 or 256");
        // 60:120 was 1:2 and must stay 1:2.
        assert_eq!(out[1].1 as u32, out[0].1 as u32 * 2);
    }

    #[test]
    fn a_vertex_with_nothing_left_asks_for_a_guess() {
        let v: Influences = vec![(99, 255)];
        assert!(redistribute(&v, |j| j != 99).is_none());
    }

    #[test]
    fn the_guess_prefers_side_over_words() {
        // This is the Defiance arms failure: a right wrist cuff must not land
        // on the left forearm just because both say "forearm".
        let candidates = [(10u16, "LeftForeArm"), (11u16, "RightForeArm")];
        let mut busiest = HashMap::new();
        busiest.insert(10u16, 5000u64); // the left arm is far busier
        busiest.insert(11u16, 10u64);
        let joint = guess_bone(&["RightWrist_CuffTwist"], &candidates, &busiest, 10);
        assert_eq!(joint, 11, "side wins over the busier bone");
    }

    #[test]
    fn with_no_side_the_busiest_wins_then_the_dominant() {
        let candidates = [(10u16, "Spine"), (11u16, "Spine3")];
        let mut busiest = HashMap::new();
        busiest.insert(11u16, 99u64);
        assert_eq!(guess_bone(&["ac_flap_x03_y02"], &candidates, &busiest, 10), 11);
        // Nothing to choose from at all falls back to the mesh's dominant bone.
        assert_eq!(guess_bone(&["ac_flap_x03_y02"], &[], &busiest, 7), 7);
    }
}
