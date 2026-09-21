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

pub mod build;
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
pub use build::{assign_sets, build_item, link_variants};
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

/// Substrings matched against a class name when the attach type does not say,
/// most specific first.
///
/// The Python keeps this as a safety net *"so a renamed attach type cannot
/// silently empty the catalog"*, and the port not having it was a real gap
/// rather than a simplification: it costs **23 wearable items**. The Ready-Up
/// Helmet's twenty colourways and the three ThermoWeave pieces are filed under
/// `clothing/pu_clothing/clothing_hats/`, carry geometry and materials, and
/// have an attach type outside the `Char_Armor_*` family. Nothing but the name
/// identifies them.
///
/// It also admits eleven `med_body_*` and `med_skeleton_*` records named
/// "Body", which are the medical-bed mannequin and junk. They come in here in
/// the pipeline too, and `CLAUDE.md` already lists them as wanting a flag; the
/// port matching the reference matters more than the port being tidier than it.
pub const SLOT_NAME_HINTS: [(&str, &str); 13] = [
    ("undersuit", "undersuit"),
    ("backpack", "backpack"),
    ("_bag", "backpack"),
    ("helmet", "helmet"),
    ("_hel_", "helmet"),
    ("torso", "torso"),
    ("_tor_", "torso"),
    ("core", "torso"), // CIG calls the torso slot "core"
    ("chest", "torso"),
    ("arms", "arms"),
    ("_arm", "arms"),
    ("legs", "legs"),
    ("_leg", "legs"),
];

/// The slot a record belongs to: its attach type, then its class name.
///
/// Mirrors the Python's `catalog.slot_for` exactly, including the order. The
/// attach type is authoritative; the name hints only run when it says nothing
/// recognisable.
pub fn slot_of(attach_type: Option<&str>, class_name: &str) -> Option<&'static str> {
    if let Some(value) = attach_type {
        if let Some(slot) = slot_for(value) {
            return Some(slot);
        }
        // A `Char_Armor_*` type this table does not list still names its slot
        // in its suffix, which is what keeps a renamed variant working.
        if value.to_ascii_lowercase().starts_with("char_armor_") {
            if let Some(suffix) = value.rsplit('_').next() {
                let suffix = suffix.to_ascii_lowercase();
                for slot in ["helmet", "torso", "arms", "legs", "backpack", "undersuit"] {
                    if suffix.starts_with(&slot[..4]) {
                        return Some(slot);
                    }
                }
            }
        }
    }
    let name = class_name.to_ascii_lowercase();
    SLOT_NAME_HINTS
        .iter()
        .find(|(needle, _)| name.contains(needle))
        .map(|(_, slot)| *slot)
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
    let value = raw_attach_type(record)?;
    ARMOR_TYPES.contains(&value).then_some(value)
}

/// The attach type as written, whether or not it is one we recognise.
///
/// [`armor_type`] filters to the `Char_Armor_*` family; the slot decision needs
/// the raw value, because a record outside that family may still be placed by
/// its class name.
pub fn raw_attach_type(record: &Value) -> Option<&str> {
    attach_first(record, &["AttachDef.Type", "AttachDef.type"])?.as_str()
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
    fn a_clothing_hat_is_placed_by_its_name() {
        // The Ready-Up Helmet's twenty colourways are filed under
        // `clothing/pu_clothing/clothing_hats/` with an attach type outside the
        // Char_Armor_* family. Without the name fallback the port lost all
        // twenty, plus three ThermoWeave pieces.
        assert_eq!(
            slot_of(Some("Char_Clothing_Hat"), "gys_helmet_01_01_01"),
            Some("helmet")
        );
        assert_eq!(
            slot_of(Some("Char_Clothing_Hat"), "grin_refinery_backpack_01_01_01"),
            Some("backpack")
        );
    }

    #[test]
    fn the_attach_type_wins_over_the_name() {
        // A name hint must never override an explicit armour type, or a piece
        // called `..._core_arms_01` would land on the wrong slot.
        assert_eq!(
            slot_of(Some("Char_Armor_Arms"), "cds_core_armor_01"),
            Some("arms")
        );
    }

    #[test]
    fn an_unknown_armour_type_still_finds_its_slot_in_its_suffix() {
        // The suffix rule reads the *last* token, exactly as the Python's
        // `split("_")[-1]` does, and matches on the slot's first four letters.
        // So a pluralised or lengthened tail still lands.
        assert_eq!(slot_of(Some("Char_Armor_Helmets"), "whatever"), Some("helmet"));
        assert_eq!(slot_of(Some("Char_Armor_Backpacks"), "whatever"), Some("backpack"));
        // And a suffix that is not the slot falls through to the name, which is
        // why `Char_Armor_Helmet_V2` -- last token "V2" -- is not a helmet by
        // this rule. Worth pinning: the obvious reading of "the suffix names
        // the slot" would have it match.
        assert_eq!(slot_of(Some("Char_Armor_Helmet_V2"), "whatever"), None);
        assert_eq!(
            slot_of(Some("Char_Armor_Helmet_V2"), "cds_helmet_01"),
            Some("helmet"),
            "the name hint still places it"
        );
    }

    #[test]
    fn a_record_with_neither_is_not_an_item() {
        assert_eq!(slot_of(Some("Char_Weapon_Pistol"), "behr_p8sc_smg"), None);
        assert_eq!(slot_of(None, "scitemmanufacturer_cds"), None);
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
