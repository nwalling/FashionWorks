//! Assembling items, ported from `catalog.build_item` / `catalog.build`.
//!
//! Everything the other modules resolve comes together here into the manifest
//! the viewer reads. Two steps happen *after* every item exists, and must:
//! `assign_sets` needs each item's final name and flags, and `link_variants`
//! needs every item's geometry before it can decide which are the same mesh.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use super::sets;
use super::tint::{self, PaletteIndex};
use super::{
    attach_first, class_name_of, first, flags_for, geometry::materials_for,
    localization::Localization, record_body, select_wearables, slot_of, walk_geometry,
};

/// Rigid pieces hang off an attachment bone rather than deforming with the
/// body. These bones are not in the base skeleton; they are grafted onto the
/// canonical armature from a donor mesh.
fn socket_for(slot: &str, bind_mode: &str) -> Option<&'static str> {
    if bind_mode != "socket" {
        return None;
    }
    match slot {
        "backpack" => Some("backpack_attach_1_override"),
        "helmet" => Some("helmethook_attach_override"),
        _ => None,
    }
}

/// Rigid meshes attach to a socket; skinned ones bind to the skeleton.
fn bind_mode_for(geometry: &[String]) -> &'static str {
    let rigid = |s: &String| {
        let l = s.to_ascii_lowercase();
        l.ends_with(".cga") || l.ends_with(".cgf")
    };
    if !geometry.is_empty() && geometry.iter().all(rigid) {
        "socket"
    } else {
        "skinned"
    }
}

const SUB_SLOT_HINTS: [(&str, &str); 6] = [
    ("shoulder", "shoulders"),
    ("chest", "chest_plate"),
    ("_l_", "left"),
    ("_r_", "right"),
    ("_left", "left"),
    ("_right", "right"),
];

fn sub_slot_for(record: &Value, class_name: &str, slot: &str) -> Option<String> {
    if let Some(subtype) = attach_first(record, &["AttachDef.SubType"]).and_then(Value::as_str) {
        let cleaned = subtype.rsplit('_').next().unwrap_or("").to_ascii_lowercase();
        if !cleaned.is_empty() && cleaned != slot {
            return Some(cleaned);
        }
    }
    let lowered = class_name.to_ascii_lowercase();
    SUB_SLOT_HINTS
        .iter()
        .find(|(needle, _)| lowered.contains(needle))
        .map(|(_, value)| value.to_string())
}

/// `superheavy` is checked before `heavy`, since it contains it.
const WEIGHT_HINTS: [(&str, &str); 4] = [
    ("superheavy", "superheavy"),
    ("heavy", "heavy"),
    ("medium", "medium"),
    ("light", "light"),
];

/// `light | medium | heavy | superheavy`.
///
/// The class name and subtype answer for most items. For the rest the
/// DataCore encodes it in the record's own directory (`.../pu_armor/<weight>/`),
/// which is why the source path is carried this far -- 13 items, the GYS
/// helmets among them, have it nowhere else.
fn weight_class_for(record: &Value, class_name: &str, source_path: &str) -> Option<String> {
    let mut haystack = class_name.to_ascii_lowercase();
    for path in ["AttachDef.SubType", "AttachDef.Size"] {
        if let Some(value) = attach_first(record, &[path]).and_then(Value::as_str) {
            haystack.push(' ');
            haystack.push_str(&value.to_ascii_lowercase());
        }
    }
    if let Some((_, value)) = WEIGHT_HINTS.iter().find(|(needle, _)| haystack.contains(needle)) {
        return Some(value.to_string());
    }
    // The path is matched on whole directory components, not as a substring,
    // so `.../heavy/...` counts and `heavyweight_crate` does not.
    let parts: Vec<String> = source_path
        .replace('\\', "/")
        .split('/')
        .map(|p| p.to_ascii_lowercase())
        .collect();
    WEIGHT_HINTS
        .iter()
        .find(|(_, value)| parts.iter().any(|p| p == value))
        .map(|(_, value)| value.to_string())
}

fn is_null_guid(value: &str) -> bool {
    value
        .trim_matches(|c| c == '{' || c == '}')
        .chars()
        .all(|c| c == '0' || c == '-')
}

/// Resolve the manufacturer, localising its name.
///
/// The reference ends `scitemmanufacturer.<code>.json`, so the code survives
/// even when the manufacturer record is missing from the export. The record's
/// `Name` is itself a localisation key (`@manufacturer_NameCDS`), not display
/// text.
fn manufacturer_for(
    record: &Value,
    makers: &HashMap<String, Value>,
    loc: &Localization,
) -> (String, String) {
    let reference = attach_first(record, &["AttachDef.Manufacturer"]).and_then(Value::as_str);
    let derived = reference
        .and_then(tint::ref_name)
        .filter(|d| !is_null_guid(d));

    let mut code = String::new();
    let mut name = String::new();
    if let Some(resolved) = derived.as_deref().and_then(|d| makers.get(&d.to_ascii_lowercase())) {
        let body = record_body(resolved);
        code = first(body, &["Code", "code", "ShortName"])
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if let Some(raw) = first(body, &["Name", "name", "Localization.Name"]).and_then(Value::as_str)
        {
            name = loc
                .get(raw)
                .map(str::to_string)
                .unwrap_or_else(|| if raw.starts_with('@') { String::new() } else { raw.to_string() });
        }
    }
    if code.is_empty() {
        if let Some(d) = derived {
            code = d;
        }
    }
    (code.to_ascii_uppercase(), name)
}

const STAT_KEYS: [&str; 4] = [
    "TemperatureResistance",
    "RadiationResistance",
    "Flight",
    "Chunks",
];

fn stats_for(record: &Value) -> Value {
    let params = super::component(record, "SCItemClothingParams")
        .or_else(|| super::component(record, "SCItemSuitArmorParams"));
    let mut out = Map::new();
    if let Some(params) = params.and_then(Value::as_object) {
        for key in STAT_KEYS {
            if let Some(value) = params.get(key) {
                out.insert(key.to_string(), value.clone());
            }
        }
    }
    Value::Object(out)
}

/// One assembled item, or `None` when the record is not armour.
#[allow(clippy::too_many_arguments)]
pub fn build_item(
    record: &Value,
    palettes: &PaletteIndex,
    makers: &HashMap<String, Value>,
    loc: &Localization,
    skeleton: &str,
    source_path: &str,
) -> Option<Value> {
    let class_name = class_name_of(record.get("_RecordName_")?.as_str()?).to_string();
    let slot = slot_of(super::raw_attach_type(record), &class_name)?;

    let all_nodes = walk_geometry(record);
    let worn = select_wearables(&all_nodes, skeleton);
    let geometry: Vec<String> = worn.iter().map(|n| n.path.clone()).collect();
    let materials = materials_for(&all_nodes, skeleton);

    let name_key = super::name_key(record);
    // An empty resolution counts as no name, not as a name that is empty.
    //
    // The Python writes `name or record.class_name`, and Python's truthiness
    // folds `""` in with `None`; Rust's `unwrap_or` fires only on `None`, so
    // the distinction the original never had to make becomes a bug. CIG uses a
    // real sentinel for this -- `sc_nvy_deckcrew_helmet_01_01_01` carries
    // `AttachDef.Localization.Name = "@LOC_EMPTY"`, and `global.ini` maps
    // `LOC_EMPTY` to the empty string -- so three helmets came out with a blank
    // name and no `unnamed` flag.
    let name = name_key.and_then(|k| loc.get(k)).filter(|value| !value.is_empty());
    let desc_key = super::description_key(record);

    let mut flags = flags_for(&class_name, Some(name.unwrap_or(&class_name)), !geometry.is_empty());
    if geometry.iter().any(|g| g.to_ascii_lowercase().ends_with(".cdf")) {
        // The mesh is named indirectly; extraction resolves it.
        flags.push("cdf".to_string());
    }

    let bind_mode = bind_mode_for(&geometry);
    let (code, maker_name) = manufacturer_for(record, makers, loc);

    Some(json!({
        "id": record.get("_RecordId_").and_then(Value::as_str).unwrap_or(""),
        "class_name": class_name,
        "name": name.unwrap_or(&class_name),
        "name_key": name_key,
        "description": desc_key.and_then(|k| loc.get(k)),
        "description_key": desc_key,
        "slot": slot,
        "sub_slot": sub_slot_for(record, &class_name, slot),
        "weight_class": weight_class_for(record, &class_name, source_path),
        "manufacturer": { "code": code, "name": maker_name },
        "tint": tint::tint_for(&worn, palettes, &all_nodes, super::material_palette(record).as_deref()),
        "stats": stats_for(record),
        "tags": sets::tags_for(record),
        "geometry": geometry.iter().map(|g| json!({ "source": g, "side": Value::Null })).collect::<Vec<_>>(),
        "materials": materials,
        "bind_mode": bind_mode,
        "socket": socket_for(slot, bind_mode),
        "flags": flags,
    }))
}

/// Group colour variants so the viewer shows one entry with swatches.
///
/// Two items are variants when they are the same slot and point at **the same
/// mesh**, differing only in tint. Grouping on the `Set_<n>` tag alone is too
/// loose: a set can contain several genuinely different backpacks, and merging
/// them hid real items behind one entry.
pub fn link_variants(items: &mut [Value]) {
    let mut groups: HashMap<(String, Vec<String>), Vec<usize>> = HashMap::new();
    for (index, item) in items.iter().enumerate() {
        let slot = item["slot"].as_str().unwrap_or("").to_string();
        let sources: Vec<String> = item["geometry"]
            .as_array()
            .map(|a| a.iter().filter_map(|g| g["source"].as_str()).map(str::to_string).collect())
            .unwrap_or_default();
        let key = if sources.is_empty() {
            // Items with no geometry fall back to a stripped class name, so
            // placeholder records collapse instead of flooding the list.
            vec![
                "name".to_string(),
                sets::canonical_key(item["class_name"].as_str().unwrap_or("")),
            ]
        } else {
            sets::geometry_key(&sources)
        };
        groups.entry((slot, key)).or_default().push(index);
    }

    for item in items.iter_mut() {
        item["variant_of"] = Value::Null;
        item["variants"] = json!([]);
    }

    for mut group in groups.into_values() {
        if group.len() < 2 {
            continue;
        }
        group.sort_by_key(|&i| {
            let tags: Vec<String> = items[i]["tags"]
                .as_array()
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            (
                sets::tag_value(&tags, "Color").unwrap_or_default(),
                items[i]["class_name"].as_str().unwrap_or("").to_string(),
            )
        });
        let canonical = group[0];
        let canonical_id = items[canonical]["id"].as_str().unwrap_or("").to_string();
        let rest: Vec<String> = group[1..]
            .iter()
            .map(|&i| items[i]["id"].as_str().unwrap_or("").to_string())
            .collect();
        items[canonical]["variants"] = json!(rest);
        for &i in &group[1..] {
            items[i]["variant_of"] = json!(canonical_id);
        }
    }
}

/// Assign each item its set key, once every item has its final name and flags.
pub fn assign_sets(items: &mut [Value]) {
    for item in items.iter_mut() {
        let flags: Vec<String> = item["flags"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        let tags: Vec<String> = item["tags"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        let geometry: Vec<String> = item["geometry"]
            .as_array()
            .map(|a| a.iter().filter_map(|g| g["source"].as_str()).map(str::to_string).collect())
            .unwrap_or_default();
        let key = sets::set_key(
            item["name"].as_str().unwrap_or(""),
            &flags,
            &tags,
            item["manufacturer"]["code"].as_str().unwrap_or(""),
            item["weight_class"].as_str(),
            &geometry,
            item["class_name"].as_str().unwrap_or(""),
        );
        item["set"] = json!(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rigid_piece_binds_to_a_socket_and_a_skinned_one_does_not() {
        assert_eq!(bind_mode_for(&["backpack.cga".into()]), "socket");
        assert_eq!(bind_mode_for(&["m_arms.skin".into()]), "skinned");
        // No geometry is not rigid.
        assert_eq!(bind_mode_for(&[]), "skinned");
        assert_eq!(socket_for("backpack", "socket"), Some("backpack_attach_1_override"));
        assert_eq!(socket_for("backpack", "skinned"), None);
    }

    #[test]
    fn superheavy_is_matched_before_heavy() {
        // "superheavy" contains "heavy"; order decides the answer.
        let record = json!({});
        assert_eq!(
            weight_class_for(&record, "cds_combat_superheavy_arms_01", "").as_deref(),
            Some("superheavy")
        );
        assert_eq!(
            weight_class_for(&record, "cds_combat_heavy_arms_01", "").as_deref(),
            Some("heavy")
        );
    }

    #[test]
    fn the_record_path_answers_when_the_name_does_not() {
        // The GYS helmets say nothing in their class name or subtype.
        let record = json!({});
        assert_eq!(weight_class_for(&record, "gys_helmet_03_01_01", "").as_deref(), None);
        assert_eq!(
            weight_class_for(&record, "gys_helmet_03_01_01",
                "libs/foundry/records/entities/scitem/characters/human/pu_armor/medium/helmet/x.xml")
                .as_deref(),
            Some("medium")
        );
        // A component match, not a substring one.
        assert_eq!(
            weight_class_for(&record, "gys_helmet_03_01_01", "libs/heavyweight_crate/x.xml").as_deref(),
            None
        );
    }

    #[test]
    fn a_null_guid_manufacturer_is_not_a_code() {
        assert!(is_null_guid("00000000-0000-0000-0000-000000000000"));
        assert!(is_null_guid("{0000-0000}"));
        assert!(!is_null_guid("cds"));
    }

    #[test]
    fn variants_group_on_the_mesh_not_the_set_tag() {
        let mut items = vec![
            json!({ "id": "a", "class_name": "x_01", "slot": "arms", "tags": ["Color_02"],
                    "geometry": [{ "source": "m_arms.skin" }] }),
            json!({ "id": "b", "class_name": "x_02", "slot": "arms", "tags": ["Color_01"],
                    "geometry": [{ "source": "m_arms.skin" }] }),
            // Same set, genuinely different mesh: must not be folded in.
            json!({ "id": "c", "class_name": "y_01", "slot": "arms", "tags": ["Color_01"],
                    "geometry": [{ "source": "m_other.skin" }] }),
        ];
        link_variants(&mut items);
        // Lowest Color_<n> is canonical.
        assert_eq!(items[1]["variants"], json!(["a"]));
        assert_eq!(items[0]["variant_of"], "b");
        assert_eq!(items[2]["variant_of"], Value::Null);
        assert_eq!(items[2]["variants"], json!([]));
    }
}
