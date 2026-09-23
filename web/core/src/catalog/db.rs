//! Finding armour records in a DataCore, and reading them as JSON.
//!
//! The port reads records through the crate's own JSON export rather than its
//! binary structures. That costs a serialise and a parse per record and buys
//! the thing that matters: the Python in `extract/sc_extract/` reads exactly
//! this shape, so its logic transliterates instead of being re-derived. See
//! `catalog/mod.rs` for why that trade is the right way round here.

use serde_json::Value;
use starbreaker_datacore::{export, Database};

/// Records of this struct type are the ones that can be wearable items.
const ENTITY_CLASS: &str = "EntityClassDefinition";

/// Only records under this path are human wearables.
///
/// The Python reaches the same scope from the other end: its DCB export filters
/// on `**/entities/scitem/characters/human/**`, so records outside that never
/// reach `catalog.py` at all. Without the same limit the port picks up eleven
/// extra pieces -- `vanduul_pilot_core_01_01_01` and friends -- which are
/// armour by attach type and are not human armour. Matching the scope here
/// keeps the two catalogues comparable, and keeps a Vanduul drone undersuit out
/// of the picker.
const HUMAN_ITEMS: &str = "entities/scitem/characters/human/";

/// One armour record, as JSON, with the two fields the index needs to hand.
pub struct ArmorRecord {
    pub class_name: String,
    pub attach_type: String,
    /// Where the record lives in the foundry tree. The weight class is encoded
    /// in it (`.../pu_armor/<weight>/<slot>/`) for items whose class name and
    /// subtype do not say, so it is carried rather than discarded.
    pub source_path: String,
    pub value: Value,
}

/// Every wearable armour record in the database.
///
/// Filtering on the struct type first matters: the build holds 116,921 records
/// and only a few thousand are armour, so serialising all of them to JSON to
/// find out would dominate the run.
pub fn armor_records(db: &Database) -> Vec<ArmorRecord> {
    let mut out = Vec::new();
    for record in db.records_by_type_name(ENTITY_CLASS) {
        let source = db.resolve_string(record.file_name_offset);
        if !source.replace('\\', "/").to_ascii_lowercase().contains(HUMAN_ITEMS) {
            continue;
        }
        let mut buf = Vec::new();
        if export::write_json_compact(db, record, &mut buf).is_err() {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&buf) else {
            continue;
        };
        let class_name = value
            .get("_RecordName_")
            .and_then(Value::as_str)
            .map(super::class_name_of)
            .unwrap_or_default()
            .to_string();
        // The attach type decides, and the class name is the fallback -- which
        // is not a nicety: 23 wearable items, the Ready-Up Helmet's twenty
        // colourways among them, are filed under `clothing/` with an attach
        // type outside the `Char_Armor_*` family and nothing but their name to
        // say what they are.
        let attach_type = super::raw_attach_type(&value).unwrap_or_default().to_string();
        if super::slot_of(
            (!attach_type.is_empty()).then_some(attach_type.as_str()),
            &class_name,
        )
        .is_none()
        {
            continue;
        }
        out.push(ArmorRecord {
            class_name,
            attach_type,
            source_path: source.to_string(),
            value,
        });
    }
    out
}

/// Every gear record -- weapons, knives, grenades, magazines, pens, gadgets --
/// in the database. Scoped by path as the Python's DCB export is; which of
/// them is gear the builder decides from the attach type.
pub fn gear_records(db: &Database) -> Vec<ArmorRecord> {
    let mut out = Vec::new();
    for record in db.records_by_type_name(ENTITY_CLASS) {
        let source = db.resolve_string(record.file_name_offset);
        if !super::gear::in_scope(source) {
            continue;
        }
        let mut buf = Vec::new();
        if export::write_json_compact(db, record, &mut buf).is_err() {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&buf) else {
            continue;
        };
        let class_name = value
            .get("_RecordName_")
            .and_then(Value::as_str)
            .map(super::class_name_of)
            .unwrap_or_default()
            .to_string();
        let attach_type = super::raw_attach_type(&value).unwrap_or_default().to_string();
        out.push(ArmorRecord { class_name, attach_type, source_path: source.to_string(), value });
    }
    out
}

/// Every record of one struct type, as JSON, keyed by lowercased name.
///
/// Lowercased because a reference and the record it points at do not always
/// agree on case -- `TintPaletteTree.IAE_2022` is reached by `.../iae_2022.json`
/// -- and first-wins because a later record with the same name must not
/// displace an earlier one.
pub fn index_by_name(db: &Database, struct_type: &str) -> std::collections::HashMap<String, Value> {
    let mut out = std::collections::HashMap::new();
    for record in db.records_by_type_name(struct_type) {
        let mut buf = Vec::new();
        if export::write_json_compact(db, record, &mut buf).is_err() {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&buf) else {
            continue;
        };
        if let Some(name) = value.get("_RecordName_").and_then(Value::as_str) {
            out.entry(super::class_name_of(name).to_ascii_lowercase())
                .or_insert(value);
        }
    }
    out
}

/// Load a DataCore from the raw `Game2.dcb` bytes.
pub fn open(bytes: &[u8]) -> Result<Database<'_>, String> {
    Database::from_bytes(bytes).map_err(|e| format!("parsing DataCore: {e}"))
}
