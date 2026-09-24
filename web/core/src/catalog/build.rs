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
pub(crate) fn manufacturer_for(
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

/// `Chunks` used to ride along here raw; it is its own field now.
const STAT_KEYS: [&str; 3] = ["TemperatureResistance", "RadiationResistance", "Flight"];

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

/// `SCItemClothingParams.Chunks` as `{zone, layer, visible}`, ported from
/// `catalog.chunks_for`.
///
/// A zone on a lower layer is not drawn where a higher layer lists it, unless
/// the chunk's `visible` keeps that layer (CLOTHING.md, "Phase 0, as run").
/// `VisibilityConditions` is left out, as the Python leaves it out.
fn chunks_for(record: &Value) -> Value {
    let chunks = super::component(record, "SCItemClothingParams")
        .and_then(|p| p.get("Chunks"))
        .and_then(Value::as_array);
    let mut out = Vec::new();
    for chunk in chunks.into_iter().flatten() {
        let zone = chunk.get("MeshChunk").and_then(Value::as_str).filter(|z| !z.is_empty());
        let layer = chunk.get("Layer").and_then(Value::as_i64);
        let (Some(zone), Some(layer)) = (zone, layer) else {
            continue;
        };
        let visible: Vec<i64> = chunk
            .get("VisibleLayers")
            .and_then(Value::as_array)
            .map(|v| v.iter().filter_map(Value::as_i64).collect())
            .unwrap_or_default();
        out.push(json!({ "zone": zone, "layer": layer, "visible": visible }));
    }
    Value::Array(out)
}

/// `SCItemClothingParams.HiddenParts`: port names, first occurrence kept.
fn hidden_for(record: &Value) -> Vec<String> {
    let parts = super::component(record, "SCItemClothingParams")
        .and_then(|p| p.get("HiddenParts"))
        .and_then(Value::as_array);
    let mut out: Vec<String> = Vec::new();
    for part in parts.into_iter().flatten() {
        if let Some(port) = part.get("PortName").and_then(Value::as_str).filter(|p| !p.is_empty()) {
            if !out.iter().any(|seen| seen == port) {
                out.push(port.to_string());
            }
        }
    }
    out
}

/// Squadron 42's crew uniforms live beside the player's clothing and are not
/// in the persistent universe; flagged so a listing can hide them.
fn is_squadron42(source_path: &str) -> bool {
    source_path.replace('\\', "/").to_ascii_lowercase().contains("/clothing/s42_clothing/")
}

/// One assembled item, or `None` when the record is neither armour nor clothing.
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
    if is_squadron42(source_path) {
        flags.push("squadron42".to_string());
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
        "ports": super::gear::ports_for(record),
        "outfit": super::outfit_of(slot),
        "chunks": chunks_for(record),
        "hidden": hidden_for(record),
    }))
}

/// Group colour variants so the viewer shows one entry with swatches.
///
/// Two items are variants when they are the same slot and point at **the same
/// mesh**, differing only in tint. Grouping on the `Set_<n>` tag alone is too
/// loose: a set can contain several genuinely different backpacks, and merging
/// them hid real items behind one entry.
pub fn link_variants(items: &mut [Value]) {
    // Keyed on slot, **product line** and mesh. The mesh alone is too loose:
    // product lines reuse each other's meshes -- `Defiance Legs Sunchaser` and
    // `ADP-mk4 Legs Woodland` are both `m_cds_heavy_armor_01_legs.skin`, which
    // is genuine reuse -- so geometry alone merged them into one family of
    // eleven across two lines, and every Defiance colourway disappeared under
    // an ADP-mk4 name.
    //
    // The product name, not the `set`: `set` separates `citadel` from
    // `citadel-se` and splits Aves across four keys, over-splitting lines that
    // are one product with several editions. Across the catalogue this takes
    // families spanning more than one product from 71 to 0.
    //
    // An unnamed item's `name` **is** its class name -- `build_item` writes
    // `name.unwrap_or(&class_name)` and `flags_for` records the `unnamed` flag
    // at the same time -- so the fallback keys on the flag, exactly as
    // `sets::set_key` already does. Testing the name for emptiness finds
    // nothing to fall back on, and `product_key` of a class name is the whole
    // class name, colour index and all, which gives every unnamed colourway a
    // key of its own. The stripped class name drops the index.
    //
    // Measured on the 2615-item catalogue: families sharing no name prefix --
    // exactly the case that titles a row after an unrelated member -- go from
    // 53 to 19, and all 19 that remain are unnamed items whose "name" is a
    // class name and so share no words by construction.
    let mut groups: HashMap<(String, String, Vec<String>), Vec<usize>> = HashMap::new();
    for (index, item) in items.iter().enumerate() {
        let slot = item["slot"].as_str().unwrap_or("").to_string();
        let class_name = item["class_name"].as_str().unwrap_or("");
        let unnamed = item["flags"]
            .as_array()
            .is_some_and(|f| f.iter().any(|v| v.as_str() == Some("unnamed")));
        let product = match item["name"].as_str().filter(|_| !unnamed) {
            Some(display) => sets::product_key_for(display, &slot),
            None => String::new(),
        };
        let product = if product.is_empty() { sets::canonical_key(class_name) } else { product };
        let sources: Vec<String> = item["geometry"]
            .as_array()
            .map(|a| a.iter().filter_map(|g| g["source"].as_str()).map(str::to_string).collect())
            .unwrap_or_default();
        let key = if sources.is_empty() {
            // Items with no geometry fall back to a stripped class name, so
            // placeholder records collapse instead of flooding the list.
            vec!["name".to_string(), sets::canonical_key(class_name)]
        } else {
            sets::geometry_key(&sources)
        };
        groups.entry((slot, product, key)).or_default().push(index);
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
            item["slot"].as_str().unwrap_or(""),
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
    fn chunks_and_hidden_parts_are_read() {
        let record = json!({ "_RecordValue_": { "Components": [
            { "_Type_": "SCItemClothingParams",
              "HiddenParts": [
                { "PortName": "Clothing_Torso_0" }, { "PortName": "Clothing_Legs" },
                { "PortName": "Clothing_Torso_0" } ],
              "Chunks": [
                { "MeshChunk": "torso01_zone", "Layer": 2, "VisibleLayers": [] },
                { "MeshChunk": "l_arm05_zone", "Layer": 2, "VisibleLayers": [0] },
                { "MeshChunk": "", "Layer": 2 } ],
              "Flight": { "gForceResistance": 0.0 } }
        ]}});
        assert_eq!(hidden_for(&record), vec!["Clothing_Torso_0", "Clothing_Legs"]);
        assert_eq!(
            chunks_for(&record),
            json!([
                { "zone": "torso01_zone", "layer": 2, "visible": [] },
                { "zone": "l_arm05_zone", "layer": 2, "visible": [0] },
            ])
        );
        assert!(stats_for(&record).get("Chunks").is_none());
    }

    #[test]
    fn squadron42_uniforms_are_recognised_by_their_folder() {
        let root = "libs/foundry/records/entities/scitem/characters/human/clothing";
        assert!(is_squadron42(&format!("{root}/s42_clothing/s42_clothing_legs/x.xml")));
        assert!(!is_squadron42(&format!("{root}/pu_clothing/clothing_legs/x.xml")));
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

    #[test]
    fn two_product_lines_sharing_a_mesh_stay_two_families() {
        // The real case: `Defiance Legs Sunchaser` and `ADP-mk4 Legs Woodland`
        // are both `m_cds_heavy_armor_01_legs.skin`. That reuse is genuine, so
        // the mesh alone put all of them in one family under an ADP-mk4 name
        // and the Defiance colourways vanished from the listing.
        let mesh = json!([{ "source": "m_cds_heavy_armor_01_legs.skin" }]);
        let mut items = vec![
            json!({ "id": "d1", "class_name": "cds_heavy_legs_01_01_01", "slot": "legs",
                    "name": "Defiance Legs Sunchaser", "tags": ["Color_01"], "geometry": mesh }),
            json!({ "id": "d2", "class_name": "cds_heavy_legs_01_01_02", "slot": "legs",
                    "name": "Defiance Legs Tactical", "tags": ["Color_02"], "geometry": mesh }),
            json!({ "id": "a1", "class_name": "adp_mk4_legs_01_01_01", "slot": "legs",
                    "name": "ADP-mk4 Legs Woodland", "tags": ["Color_01"], "geometry": mesh }),
        ];
        link_variants(&mut items);
        assert_eq!(items[0]["variants"], json!(["d2"]));
        assert_eq!(items[1]["variant_of"], "d1");
        // The ADP-mk4 piece keeps its own identity rather than swallowing them.
        assert_eq!(items[2]["variant_of"], Value::Null);
        assert_eq!(items[2]["variants"], json!([]));
    }

    #[test]
    fn an_unnamed_item_keys_on_its_stripped_class_name() {
        // An unnamed item's `name` is its class name, so `product_key` of it is
        // the class name, colour index and all -- one key per colourway, and
        // the family splits into singletons. The flag is what says so.
        let mesh = json!([{ "source": "m_vgl.skin" }]);
        let mut items = vec![
            json!({ "id": "u1", "class_name": "vgl_flightsuit_helmet_01_03_01", "slot": "helmet",
                    "name": "vgl_flightsuit_helmet_01_03_01", "flags": ["unnamed"],
                    "tags": ["Color_01"], "geometry": mesh }),
            json!({ "id": "u2", "class_name": "vgl_flightsuit_helmet_01_04_01", "slot": "helmet",
                    "name": "vgl_flightsuit_helmet_01_04_01", "flags": ["unnamed"],
                    "tags": ["Color_02"], "geometry": mesh }),
        ];
        link_variants(&mut items);
        assert_eq!(items[0]["variants"], json!(["u2"]));
        assert_eq!(items[1]["variant_of"], "u1");
    }
}
