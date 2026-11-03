//! `global.ini` parsing and key resolution, ported from `localization.py`.
//!
//! The file is a flat `key=value` table with no INI sections, UTF-8 with a BOM,
//! one entry per line and 90,363 keys in this build. Records refer to entries
//! with a leading `@` (`@item_Name_foo`); the file stores them without it.
//!
//! **A key can carry a `,P` suffix**, and 13,380 of 90,437 do -- among them the
//! names of the Clash Arms, Defiance Arms Ultimatum and the Strata Levski
//! Edition (`item_Name_doom_combat_medium_arms_01_01_01,P`). The record names
//! the key without it, and stripping it never collides with a key that exists.
//! Read as written, 72 items found no name and showed their class name.
//!
//! **A placeholder is not text.** 58 item names read `PH - <class name>` or
//! `PLACEHOLDER - <class name>`; they resolve as absent, so the item is
//! `unnamed` like any other that has no name in the game.
//!
//! An unresolved key is not an error: what matters is recording the miss, not
//! failing on it.

use std::collections::HashMap;

/// A resolved `key -> text` table.
#[derive(Default)]
pub struct Localization {
    table: HashMap<String, String>,
    lowered: HashMap<String, String>,
}

impl Localization {
    /// Parse the contents of `global.ini`.
    pub fn parse(text: &str) -> Self {
        let mut table = HashMap::new();
        for raw in text.lines() {
            // The BOM survives into the first line's text when the caller has
            // not stripped it.
            let line = raw.trim_start_matches('\u{feff}').trim();
            if line.is_empty() || line.starts_with(';') || line.starts_with('#') || line.starts_with('[')
            {
                continue;
            }
            // Values may contain `=`; only the first one splits.
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            let key = key.trim();
            let key = key.strip_suffix(",P").unwrap_or(key);
            table.insert(key.to_string(), value.trim().to_string());
        }
        let lowered = table
            .iter()
            .map(|(k, v)| (k.to_ascii_lowercase(), v.clone()))
            .collect();
        Self { table, lowered }
    }

    pub fn len(&self) -> usize {
        self.table.len()
    }

    pub fn is_empty(&self) -> bool {
        self.table.is_empty()
    }

    /// Resolve `@key` to English text.
    ///
    /// Falls back to a case-insensitive match, because the DataCore and the ini
    /// file do not always agree on casing (`GRIN_utility` against `grin_utility`).
    /// A placeholder resolves as absent.
    pub fn get(&self, key: &str) -> Option<&str> {
        if key.is_empty() {
            return None;
        }
        let normalized = key.strip_prefix('@').unwrap_or(key);
        self.table
            .get(normalized)
            .or_else(|| self.lowered.get(&normalized.to_ascii_lowercase()))
            .map(String::as_str)
            .filter(|text| !is_placeholder(text))
    }
}

/// `PH - 987_shoes_01_01_9tails01`, `PLACEHOLDER - cbd_hat_03_01_CFP_var2`:
/// what the localisers left where a name will go.
pub fn is_placeholder(text: &str) -> bool {
    text.starts_with("PH - ") || text.starts_with("PLACEHOLDER - ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_flat_table_parses_without_sections() {
        let loc = Localization::parse("\u{feff}item_Name_foo=Deep-Space Undersuit\n\n; a comment\n");
        assert_eq!(loc.len(), 1);
        assert_eq!(loc.get("@item_Name_foo"), Some("Deep-Space Undersuit"));
        assert_eq!(loc.get("item_Name_foo"), Some("Deep-Space Undersuit"));
    }

    #[test]
    fn only_the_first_equals_splits() {
        let loc = Localization::parse("item_Desc_x=Damage: 5% = nothing\n");
        assert_eq!(loc.get("item_Desc_x"), Some("Damage: 5% = nothing"));
    }

    #[test]
    fn casing_is_a_fallback_not_a_requirement() {
        // The DataCore and the ini file do not always agree.
        let loc = Localization::parse("item_Name_Foo=Helmet\n");
        assert_eq!(loc.get("@item_name_foo"), Some("Helmet"));
    }

    #[test]
    fn a_key_suffixed_p_answers_to_its_bare_name() {
        let loc = Localization::parse(
            "item_Name_doom_combat_medium_arms_01_01_01,P=Clash Arms\n\
             item_Name_GRIN_utility_medium_arms_03_05_16,P=Strata Arms Levski Edition\n",
        );
        assert_eq!(loc.get("@item_Name_doom_combat_medium_arms_01_01_01"), Some("Clash Arms"));
        assert_eq!(
            loc.get("@item_Name_grin_utility_medium_arms_03_05_16"),
            Some("Strata Arms Levski Edition")
        );
    }

    #[test]
    fn a_placeholder_is_not_a_name() {
        let loc = Localization::parse(
            "item_Name_alb_shirt_04=PH - alb_shirt_04\n\
             item_Name_x,P=PLACEHOLDER - x\nitem_Name_y=Philosopher's Hat\n",
        );
        assert_eq!(loc.get("@item_Name_alb_shirt_04"), None);
        assert_eq!(loc.get("@item_Name_x"), None);
        assert_eq!(loc.get("@item_Name_y"), Some("Philosopher's Hat"));
    }

    #[test]
    fn an_unresolved_key_is_absent_rather_than_fatal() {
        let loc = Localization::parse("a=b\n");
        assert_eq!(loc.get("@item_Name_missing"), None);
        assert_eq!(loc.get(""), None);
    }
}
