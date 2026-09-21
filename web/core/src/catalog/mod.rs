//! The catalogue, ported from `extract/sc_extract/catalog.py`.
//!
//! WEB.md Phase 1. The exit bar is ≥99.5% field agreement with the Python
//! manifest on a full build, and the reason the bar is that high is written in
//! the plan: *the expensive part is not the port, it is the knowledge*. The
//! geometry tree's carry-crate trap, record-type collisions, per-gender
//! material fallbacks and the rest each cost real debugging, and a port that
//! merely compiles will quietly lose them.
//!
//! So this deliberately does **not** re-derive anything. `walk_record` plus the
//! crate's own `JsonSink` produce the same JSON shape the Python reads, and the
//! logic below is a transliteration of `fields.py` and `catalog.py` against
//! that shape. Slower than reading the binary structures directly, and worth
//! it: every rule here can be diffed line-for-line against its original.

use serde_json::Value;

pub mod db;
mod fields;
mod flags;
pub mod localization;
pub mod sets;
pub mod tint;
mod geometry;

pub use fields::{component, first, record_body};
pub use flags::{flags_for, PLACEHOLDER_NAME};
pub use localization::Localization;
pub use sets::{canonical_key, geometry_key, product_key, set_key, tag_value, tags_for};
pub use tint::{tint_for, PaletteIndex};
pub use geometry::{materials_for, material_palette, select_wearables, walk_geometry, GeoNode};

/// Attach types that make a record wearable armour.
///
/// Verified against build 1.0.191.55227: `AttachDef.Type` uses exactly this
/// family. CIG calls the torso slot `core` in paths and filenames, but the
/// attach type says `Torso`.
pub const ARMOR_TYPES: [&str; 6] = [
    "Char_Armor_Helmet",
    "Char_Armor_Torso",
    "Char_Armor_Arms",
    "Char_Armor_Legs",
    "Char_Armor_Backpack",
    "Char_Armor_Undersuit",
];

/// The manifest's slot name for an `AttachDef.Type`.
pub fn slot_for(attach_type: &str) -> Option<&'static str> {
    Some(match attach_type {
        "Char_Armor_Helmet" => "helmet",
        "Char_Armor_Torso" => "torso",
        "Char_Armor_Arms" => "arms",
        "Char_Armor_Legs" => "legs",
        "Char_Armor_Backpack" => "backpack",
        "Char_Armor_Undersuit" => "undersuit",
        _ => return None,
    })
}

/// `EntityClassDefinition.<class_name>` -> `<class_name>`.
///
/// A record's name carries its type as a prefix, and the name alone is not
/// unique across types -- the VGL Warden backpack ships an entity and a tint
/// palette both called `vgl_combat_heavy_backpack_01_03_01`, which is how 165
/// items resolved a palette to the wrong record.
pub fn class_name_of(record_name: &str) -> &str {
    match record_name.split_once('.') {
        Some((_, rest)) => rest,
        None => record_name,
    }
}

/// The `SAttachableComponentParams` component, or `None`.
///
/// Returns the *component*, not its inner `AttachDef`, so every path below
/// reads the same as its Python counterpart (`AttachDef.Type`,
/// `AttachDef.Localization.Name`) rather than silently shifting by one level.
pub fn attach_def(record: &Value) -> Option<&Value> {
    component(record, "SAttachableComponentParams")
}

/// A field of the attach component, by the first path that resolves.
pub fn attach_first<'a>(record: &'a Value, paths: &[&str]) -> Option<&'a Value> {
    first(attach_def(record)?, paths)
}

/// An armour record's attach type, if it is armour at all.
pub fn armor_type(record: &Value) -> Option<&str> {
    let value = attach_first(record, &["AttachDef.Type", "AttachDef.type"])?.as_str()?;
    ARMOR_TYPES.contains(&value).then_some(value)
}

/// The localisation key for an item's display name.
pub fn name_key(record: &Value) -> Option<&str> {
    attach_first(record, &["AttachDef.Localization.Name"])?.as_str()
}

/// The localisation key for an item's description.
pub fn description_key(record: &Value) -> Option<&str> {
    attach_first(record, &["AttachDef.Localization.Description"])?.as_str()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_record_name_carries_its_type() {
        assert_eq!(
            class_name_of("EntityClassDefinition.cds_heavy_armor_01_arms"),
            "cds_heavy_armor_01_arms"
        );
        assert_eq!(class_name_of("bare_name"), "bare_name");
    }

    #[test]
    fn only_the_armor_attach_family_counts() {
        let armor = json!({
            "_RecordValue_": { "Components": [
                { "_Type_": "SAttachableComponentParams",
                  "AttachDef": { "Type": "Char_Armor_Torso" } }
            ]}
        });
        assert_eq!(armor_type(&armor), Some("Char_Armor_Torso"));
        assert_eq!(slot_for("Char_Armor_Torso"), Some("torso"));

        // A weapon attaches too, and is not armour.
        let weapon = json!({
            "_RecordValue_": { "Components": [
                { "_Type_": "SAttachableComponentParams",
                  "AttachDef": { "Type": "Char_Weapon_Primary" } }
            ]}
        });
        assert_eq!(armor_type(&weapon), None);
    }
}
