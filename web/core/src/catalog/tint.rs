//! Tint palettes, ported from `catalog.tint_for`.
//!
//! Armour in this build ships **no albedo texture**. Its `LayerBlend_V2` shader
//! composites tinted layers, and the colours live in a `TintPaletteTree` record
//! referenced per geometry node. Each of `entryA`/`entryB`/`entryC` carries a
//! tint colour, a **specular** colour and a glossiness.
//!
//! Both of those colours matter, and which one is visible depends on the layer.
//! A metal has no diffuse albedo -- its appearance is its F0 -- so for a metal
//! layer the entry's specular *is* the colour. The Lynx arms are the proof:
//! every colourway names the same mesh, the same `.mtl` and the same palette
//! record, with `TintColor` white throughout, and the whole colourway lives in
//! the specular (Red `#ff0000`, Green `#0a921c`, Blue `#0314fd`). Reading only
//! the tint colour renders ten colourways as the same grey arm. The compositor
//! consumes that rule; this module's job is to carry *both* colours across
//! intact so it can.

use std::collections::HashMap;

use serde_json::{json, Value};
use starbreaker_datacore::{export, Database};

use super::fields::{first, record_body};
use super::geometry::GeoNode;

/// The record type a palette reference must resolve to.
///
/// **Asking for the type is not optional.** A record name is not unique across
/// types: the VGL Warden backpack ships an entity *and* a tint palette both
/// called `vgl_combat_heavy_backpack_01_03_01`, and resolving by name alone
/// returned whichever loaded first. That sent 165 items to a record with no
/// `root`, so they came back with a palette reference and no colours.
pub const PALETTE_TYPE: &str = "TintPaletteTree";

/// Palette records by name, for resolving references.
pub struct PaletteIndex {
    by_name: HashMap<String, Value>,
}

impl PaletteIndex {
    /// Build the index from every `TintPaletteTree` in the database.
    pub fn build(db: &Database) -> Self {
        let mut by_name = HashMap::new();
        for record in db.records_by_type_name(PALETTE_TYPE) {
            let mut buf = Vec::new();
            if export::write_json_compact(db, record, &mut buf).is_err() {
                continue;
            }
            let Ok(value) = serde_json::from_slice::<Value>(&buf) else {
                continue;
            };
            if let Some(name) = value.get("_RecordName_").and_then(Value::as_str) {
                // Lowercased, because the record and the reference disagree on
                // case: the record is `TintPaletteTree.IAE_2022` and the
                // reference is `.../iae_2022.json`. 124 items resolved a
                // reference to nothing over this, coming back with a palette
                // name and no colours.
                //
                // First wins, matching the Python's `setdefault`. A later
                // record with the same name must not displace an earlier one,
                // or which palette an item gets depends on iteration order.
                by_name
                    .entry(super::class_name_of(name).to_ascii_lowercase())
                    .or_insert(value);
            }
        }
        Self { by_name }
    }

    pub fn len(&self) -> usize {
        self.by_name.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_name.is_empty()
    }

    fn get(&self, name: &str) -> Option<&Value> {
        self.by_name.get(&name.to_ascii_lowercase())
    }
}

/// The record name a reference points at.
///
/// References are relative `file://` URLs into the foundry record tree, ending
/// `<record type>.<record name>.json`, so the name is what follows the first
/// dot of the filename. A name may itself contain dots.
pub fn ref_name(reference: &str) -> Option<String> {
    let value = reference.trim();
    if value.is_empty() {
        return None;
    }
    if !value.starts_with("file://") {
        let bare = value.trim_matches(|c| c == '{' || c == '}');
        return (!bare.is_empty()).then(|| bare.to_string());
    }
    let stem = value.rsplit('/').next()?;
    let stem = stem.strip_suffix(".json").unwrap_or(stem);
    match stem.split_once('.') {
        Some((_, name)) => Some(name.to_string()),
        None => Some(stem.to_string()),
    }
}

/// An `SRGB8` sub-object as `#rrggbb`.
fn srgb(entry: &Value, key: &str) -> Option<String> {
    let colour = entry.get(key)?;
    let channel = |k: &str| colour.get(k)?.as_f64();
    let (r, g, b) = (channel("r")?, channel("g")?, channel("b")?);
    Some(format!("#{:02x}{:02x}{:02x}", r as u8, g as u8, b as u8))
}

/// Resolve an item's tint palette to the manifest's `tint` block.
///
/// `fallback` is searched when no worn node carries a reference, because a
/// rigid piece hangs its palette off a node that is not the worn mesh -- the
/// CSP-68H Red Alert names its IAE palette on one node only, and not the one
/// `select_wearables` keeps. Missing it left 16 of that pack's 23
/// palette-tinted layers on neutral grey, so the red pack rendered grey.
pub fn tint_for(
    nodes: &[&GeoNode],
    palettes: &PaletteIndex,
    fallback: &[GeoNode],
    override_ref: Option<&str>,
) -> Option<Value> {
    let reference = nodes
        .iter()
        .find_map(|n| n.palette.as_deref())
        .or_else(|| fallback.iter().find_map(|n| n.palette.as_deref()))
        .or(override_ref)?;

    let name = ref_name(reference)?;
    let Some(record) = palettes.get(&name) else {
        return Some(json!({ "palette_ref": name }));
    };
    let Some(root) = first(record_body(record), &["root"]).filter(|r| r.is_object()) else {
        return Some(json!({ "palette_ref": name }));
    };

    let mut layers = Vec::new();
    for key in ["entryA", "entryB", "entryC"] {
        let Some(entry) = root.get(key).filter(|e| e.is_object()) else {
            continue;
        };
        layers.push(json!({
            "color": srgb(entry, "tintColor"),
            // Carried across even when it looks redundant: for a metal layer
            // this is the colour, not a highlight tint.
            "spec": srgb(entry, "specColor"),
            "glossiness": entry.get("glossiness").and_then(Value::as_f64).map(|g| g / 255.0),
        }));
    }

    let colors: Vec<&Value> = layers
        .iter()
        .filter_map(|l| l.get("color"))
        .filter(|c| !c.is_null())
        .collect();

    Some(json!({
        "palette_ref": name,
        "layers": layers,
        "colors": colors,
        "glass": srgb(root, "glassColor"),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reference_names_the_record_after_its_type() {
        assert_eq!(
            ref_name("file://./../../libs/foundry/records/tintpalettes/brand/outlaw/outlaw_legacy_armor_light_01_04_07.json").as_deref(),
            // "<type>.<name>.json" -- but this one has no type prefix, so the
            // whole stem is the name.
            Some("outlaw_legacy_armor_light_01_04_07"),
        );
        assert_eq!(
            ref_name("file://./x/scitemmanufacturer.cds.json").as_deref(),
            Some("cds")
        );
        assert_eq!(ref_name("   ").as_deref(), None);
    }

    #[test]
    fn srgb_channels_become_a_hex_string() {
        let entry = serde_json::json!({ "tintColor": { "r": 255, "g": 0, "b": 0 } });
        assert_eq!(srgb(&entry, "tintColor").as_deref(), Some("#ff0000"));
        assert_eq!(srgb(&entry, "specColor"), None);
    }

    #[test]
    fn both_colours_survive_the_port() {
        // The Lynx shape: a white tint colour and the colourway in the
        // specular. Dropping `spec` here is what rendered ten colourways grey.
        let palettes = PaletteIndex {
            by_name: HashMap::from([(
                "lynx".to_string(),
                serde_json::json!({
                    "_RecordName_": "TintPaletteTree.lynx",
                    "_RecordValue_": { "root": {
                        "entryA": {
                            "tintColor": { "r": 255, "g": 255, "b": 255 },
                            "specColor": { "r": 3, "g": 20, "b": 253 },
                            "glossiness": 255
                        }
                    }}
                }),
            )]),
        };
        let node = GeoNode {
            path: "m.skin".into(),
            material: None,
            depth: 1,
            palette: Some("file://./x/lynx.json".into()),
        };
        let tint = tint_for(&[&node], &palettes, &[], None).unwrap();
        assert_eq!(tint["layers"][0]["color"], "#ffffff");
        assert_eq!(tint["layers"][0]["spec"], "#0314fd");
        assert_eq!(tint["layers"][0]["glossiness"], 1.0);
    }

    #[test]
    fn a_reference_resolves_regardless_of_case() {
        // The record is `TintPaletteTree.IAE_2022`; the reference that points
        // at it is `.../iae_2022.json`.
        let palettes = PaletteIndex {
            by_name: HashMap::from([(
                "iae_2022".to_string(),
                serde_json::json!({
                    "_RecordName_": "TintPaletteTree.IAE_2022",
                    "_RecordValue_": { "root": { "entryA": {
                        "tintColor": { "r": 191, "g": 38, "b": 40 }
                    }}}
                }),
            )]),
        };
        let node = GeoNode {
            path: "m.skin".into(),
            material: None,
            depth: 1,
            palette: Some("file://./x/iae_2022.json".into()),
        };
        let tint = tint_for(&[&node], &palettes, &[], None).unwrap();
        assert_eq!(tint["colors"][0], "#bf2628", "case cost this its colours");
    }

    #[test]
    fn a_rigid_piece_finds_its_palette_off_the_worn_node() {
        let worn = GeoNode {
            path: "backpack.cga".into(),
            material: Some("m.mtl".into()),
            depth: 1,
            palette: None,
        };
        let other = GeoNode {
            path: "prop.cgf".into(),
            material: None,
            depth: 0,
            palette: Some("file://./x/pal.json".into()),
        };
        let empty = PaletteIndex { by_name: HashMap::new() };
        assert!(tint_for(&[&worn], &empty, &[], None).is_none());
        let found = tint_for(&[&worn], &empty, std::slice::from_ref(&other), None).unwrap();
        assert_eq!(found["palette_ref"], "pal");
    }
}
