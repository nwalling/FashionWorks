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
        let Some(attach_type) = super::armor_type(&value) else {
            continue;
        };
        let attach_type = attach_type.to_string();
        let class_name = value
            .get("_RecordName_")
            .and_then(Value::as_str)
            .map(super::class_name_of)
            .unwrap_or_default()
            .to_string();
        out.push(ArmorRecord {
            class_name,
            attach_type,
            value,
        });
    }
    out
}

/// Load a DataCore from the raw `Game2.dcb` bytes.
pub fn open(bytes: &[u8]) -> Result<Database<'_>, String> {
    Database::from_bytes(bytes).map_err(|e| format!("parsing DataCore: {e}"))
}
