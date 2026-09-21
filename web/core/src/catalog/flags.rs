//! Item flags, ported from `catalog.flags_for`.
//!
//! Some DataCore records carry an armour attach type without being wearable:
//! shop displays, the loot containers armour drops into, and outright
//! placeholders named `<= PLACEHOLDER =>`. Others are NPC-only. The viewer
//! hides the first group and the catalogue drops NPC items by default, so these
//! decide what a visitor actually sees.
//!
//! `unnamed` is deliberately *not* hidden: it is a real piece whose
//! localisation key did not resolve, and it stays visible under its class name.

pub const PLACEHOLDER_NAME: &str = "<= PLACEHOLDER =>";

/// A whole word within a `_`-separated name, as the Python's
/// `(^|_)(word)(_|$)` patterns match.
fn has_token(haystack: &str, token: &str) -> bool {
    let lowered = haystack.to_ascii_lowercase();
    lowered
        .match_indices(token)
        .any(|(at, _)| {
            let before_ok = at == 0 || lowered.as_bytes()[at - 1] == b'_';
            let end = at + token.len();
            let after_ok = end == lowered.len() || lowered.as_bytes()[end] == b'_';
            before_ok && after_ok
        })
}

fn is_test(class_name: &str) -> bool {
    ["test", "debug", "placeholder", "template", "wip", "dev"]
        .iter()
        .any(|t| has_token(class_name, t))
}

/// NPC-only gear. `outlaw_legacy_armor_heavy_core_01_01_01_ai_exclusive` is the
/// shape: `ai` as its own token, not the `ai` inside "chain" or "plain".
fn is_npc(class_name: &str) -> bool {
    ["npc", "ai", "crew_ai"].iter().any(|t| has_token(class_name, t))
}

fn not_wearable(value: &str) -> bool {
    let lowered = value.to_ascii_lowercase();
    lowered.starts_with("lootable_container")
        || lowered.starts_with("shop_")
        || lowered.starts_with("tint_lootcontainer")
}

/// Every flag that applies to an item.
pub fn flags_for(class_name: &str, name: Option<&str>, has_geometry: bool) -> Vec<String> {
    let mut flags = Vec::new();
    if is_test(class_name) {
        flags.push("test".to_string());
    }
    if is_npc(class_name) {
        flags.push("npc".to_string());
    }
    if !has_geometry {
        flags.push("no_geometry".to_string());
    }
    if name == Some(PLACEHOLDER_NAME) {
        flags.push("placeholder".to_string());
    }
    if not_wearable(name.unwrap_or("")) || not_wearable(class_name) {
        flags.push("not_wearable".to_string());
    }
    if let Some(name) = name {
        if name == class_name {
            flags.push("unnamed".to_string());
        }
    }
    flags
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ai_is_matched_as_a_token_not_a_substring() {
        assert!(is_npc("outlaw_legacy_armor_heavy_core_01_01_01_ai_exclusive"));
        assert!(is_npc("npc_guard_torso"));
        // "ai" inside a word is not an NPC marker, and treating it as one
        // would hide real armour.
        assert!(!is_npc("chainmail_torso_01"));
        assert!(!is_npc("plain_arms_01"));
    }

    #[test]
    fn shop_displays_and_loot_containers_are_not_wearable() {
        assert!(flags_for("shop_display_helmet", None, true).contains(&"not_wearable".into()));
        assert!(flags_for("lootable_container_01", None, true)
            .contains(&"not_wearable".into()));
        assert!(!flags_for("cds_heavy_arms_01", None, true).contains(&"not_wearable".into()));
    }

    #[test]
    fn an_unresolved_name_is_flagged_but_not_hidden() {
        let flags = flags_for("gys_undersuit_01", Some("gys_undersuit_01"), true);
        assert!(flags.contains(&"unnamed".into()));
        assert!(!flags.contains(&"not_wearable".into()));
    }

    #[test]
    fn missing_geometry_is_recorded() {
        assert!(flags_for("x_arms_01", Some("Arms"), false).contains(&"no_geometry".into()));
        assert!(!flags_for("x_arms_01", Some("Arms"), true).contains(&"no_geometry".into()));
    }
}
