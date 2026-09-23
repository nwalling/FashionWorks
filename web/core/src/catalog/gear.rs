//! Gear and holsters, ported from `extract/sc_extract/gear.py`. LOADOUT.md.
//!
//! **Armour ports.** Every armour record carries
//! `SItemPortContainerComponentParams.Ports`, and each port that hangs an item
//! off a bone is a holster. The count follows the torso's weight class exactly
//! across all 1,741 armour records, so it is read, not tabled.
//!
//! **Gear items.** Their geometry tree is the opposite of armour's: the root
//! node is the item, and the tagged `SubGeometry` children are colourways, of
//! which a record wears the one `SCItemWeaponComponentParams.geometryTags`
//! names -- `behr_rifle_ballistic_01_tint01` says `Tint01`, and the child
//! tagged `Tint01` carries its black palette.

use std::collections::HashMap;

use serde_json::{json, Value};

use super::geometry::{normalize_asset_path, GeoNode};
use super::{attach_first, component, first, flags_for, sets, tint, Localization, PaletteIndex};

const PORT_COMPONENT: &str = "SItemPortContainerComponentParams";
const BONE_IMPLEMENTATION: &str = "SItemPortDefAttachmentImplementationBone";
const LOADOUT_COMPONENT: &str = "SEntityComponentDefaultLoadoutParams";
const WEAPON_COMPONENT: &str = "SCItemWeaponComponentParams";

/// Where gear records live. Ship-mounted guns and the dev folder are not gear.
pub const GEAR_SCOPES: [&str; 2] = ["entities/scitem/weapons/", "entities/scitem/consumables/"];
const GEAR_EXCLUDED: [&str; 2] = ["/weapon_mounted/", "/dev/"];

const NODE_PATH: [&str; 2] = ["Geometry.Geometry.path", "Geometry.path"];
const NODE_MATERIAL: [&str; 2] = ["Geometry.Material.path", "Material.path"];
const NODE_PALETTE: [&str; 2] = ["Geometry.Palette.RootRecord", "Palette.RootRecord"];

/// Whether a record path is one gear can come from.
pub fn in_scope(source_path: &str) -> bool {
    let path = source_path.replace('\\', "/").to_ascii_lowercase();
    GEAR_SCOPES.iter().any(|s| path.contains(s)) && !GEAR_EXCLUDED.iter().any(|x| path.contains(x))
}

fn int_of(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)).unwrap_or(0),
        _ => 0,
    }
}

fn non_empty(value: Option<&Value>) -> Value {
    match value.and_then(Value::as_str) {
        Some(s) if !s.is_empty() => json!(s),
        _ => Value::Null,
    }
}

/// The ports a record declares that hang an item off a bone. Skin-implemented
/// ports -- how armour layers onto the body -- are not holsters.
pub fn ports_for(record: &Value) -> Value {
    let Some(ports) = component(record, PORT_COMPONENT)
        .and_then(|c| c.get("Ports"))
        .and_then(Value::as_array)
    else {
        return json!([]);
    };
    let mut out = Vec::new();
    for port in ports.iter().filter(|p| p.is_object()) {
        let implementation = port.get("AttachmentImplementation").unwrap_or(&Value::Null);
        if implementation.get("_Type_").and_then(Value::as_str) != Some(BONE_IMPLEMENTATION) {
            continue;
        }
        let helper = implementation
            .get("Helper")
            .and_then(|h| h.get("Helper"))
            .unwrap_or(&Value::Null);
        let types: Vec<Value> = port
            .get("Types")
            .and_then(Value::as_array)
            .map(|types| {
                types
                    .iter()
                    .filter_map(|t| {
                        let kind = t.get("Type")?.as_str().filter(|k| !k.is_empty())?;
                        let subtypes: Vec<&str> = t
                            .get("SubTypes")
                            .and_then(Value::as_array)
                            .map(|a| a.iter().filter_map(Value::as_str).filter(|s| !s.is_empty()).collect())
                            .unwrap_or_default();
                        Some(json!({ "type": kind, "subtypes": subtypes }))
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.push(json!({
            "name": port.get("Name").and_then(Value::as_str).unwrap_or(""),
            "types": types,
            "min_size": int_of(port.get("MinSize")),
            "max_size": int_of(port.get("MaxSize")),
            "helper": non_empty(helper.get("Name")),
            "offset": non_empty(helper.get("ItemOffsetHelperName")),
            "select_tag": non_empty(port.get("Extension").and_then(|e| e.get("SelectTag"))),
        }));
    }
    Value::Array(out)
}

/// `AttachDef` type and subtype to the slot a visitor browses.
pub fn gear_slot_for(attach_type: &str, subtype: &str) -> Option<&'static str> {
    let kind = attach_type.to_ascii_lowercase();
    let sub = subtype.to_ascii_lowercase();
    match kind.as_str() {
        "weaponpersonal" => match sub.as_str() {
            "medium" | "large" => Some("primary"),
            "small" => Some("sidearm"),
            "knife" => Some("knife"),
            "gadget" => Some("gadget"),
            "grenade" => Some("grenade"),
            _ => None,
        },
        "weaponattachment" => (sub == "magazine").then_some("magazine"),
        "fps_consumable" => matches!(sub.as_str(), "medpack" | "medical" | "oxygencap").then_some("consumable"),
        "gadget" => Some("gadget"),
        _ => None,
    }
}

/// The animation set that holds an item: from its tags, else its slot.
pub fn anim_set_for(slot: &str, tags: &[String]) -> Option<&'static str> {
    for name in ["stocked", "pistol", "knife", "multitool", "grenade"] {
        if tags.iter().any(|t| t.eq_ignore_ascii_case(name)) {
            return Some(name);
        }
    }
    match slot {
        "primary" => Some("stocked"),
        "sidearm" => Some("pistol"),
        "knife" => Some("knife"),
        "grenade" => Some("grenade"),
        _ => None,
    }
}

/// What the item ships with, by port: a rifle's magazine.
pub fn default_children_for(record: &Value) -> Value {
    let entries = component(record, LOADOUT_COMPONENT)
        .and_then(|c| c.get("loadout"))
        .and_then(|l| l.get("entries"))
        .and_then(Value::as_array);
    let out: Vec<Value> = entries
        .map(|entries| {
            entries
                .iter()
                .filter_map(|e| {
                    let port = e.get("itemPortName")?.as_str().filter(|s| !s.is_empty())?;
                    let child = e.get("entityClassName")?.as_str().filter(|s| !s.is_empty())?;
                    Some(json!({ "port": port, "class_name": child }))
                })
                .collect()
        })
        .unwrap_or_default();
    Value::Array(out)
}

/// The tags a weapon selects its colourway by.
pub fn geometry_tags(record: &Value) -> Vec<String> {
    component(record, WEAPON_COMPONENT)
        .and_then(|c| c.get("geometryTags"))
        .and_then(Value::as_str)
        .map(|s| s.split_whitespace().map(str::to_string).collect())
        .unwrap_or_default()
}

fn read_node(node: &Value) -> (Option<String>, Option<String>, Option<String>) {
    let text = |paths: &[&str]| first(node, paths).and_then(Value::as_str).filter(|s| !s.is_empty());
    (
        text(&NODE_PATH).map(normalize_asset_path),
        text(&NODE_MATERIAL).map(normalize_asset_path),
        text(&NODE_PALETTE).map(str::to_string),
    )
}

/// The node a gear record wears: the tagged child its `geometryTags` names,
/// else the root. A child that leaves a field empty takes the root's.
pub fn selected_node(record: &Value) -> Option<GeoNode> {
    let root = component(record, "SGeometryResourceParams")?.get("Geometry")?;
    if !root.is_object() {
        return None;
    }
    let (mut path, mut material, mut palette) = read_node(root);
    let wanted: Vec<String> = geometry_tags(record).iter().map(|t| t.to_ascii_lowercase()).collect();
    if !wanted.is_empty() {
        if let Some(children) = root.get("SubGeometry").and_then(Value::as_array) {
            for child in children.iter().filter(|c| c.is_object()) {
                let tag = child.get("Tags").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
                if wanted.contains(&tag) {
                    let (c_path, c_material, c_palette) = read_node(child);
                    path = c_path.or(path);
                    material = c_material.or(material);
                    palette = c_palette.or(palette);
                    break;
                }
            }
        }
    }
    Some(GeoNode { path: path?, material, depth: 0, palette })
}

/// One gear item, or `None` when the record is not gear.
pub fn build_gear_item(
    record: &Value,
    palettes: &PaletteIndex,
    makers: &HashMap<String, Value>,
    loc: &Localization,
) -> Option<Value> {
    let class_name = super::class_name_of(record.get("_RecordName_")?.as_str()?).to_string();
    let attach_type = attach_first(record, &["AttachDef.Type"]).and_then(Value::as_str).unwrap_or("");
    let subtype = attach_first(record, &["AttachDef.SubType"]).and_then(Value::as_str).unwrap_or("");
    let slot = gear_slot_for(attach_type, subtype)?;

    let node = selected_node(record);
    let geometry: Vec<Value> = node
        .iter()
        .map(|n| json!({ "source": n.path, "side": Value::Null }))
        .collect();
    let materials: Vec<&str> = node.iter().filter_map(|n| n.material.as_deref()).collect();

    let name_key = super::name_key(record);
    let name = name_key.and_then(|k| loc.get(k)).filter(|value| !value.is_empty());
    let desc_key = super::description_key(record);
    let flags = flags_for(&class_name, Some(name.unwrap_or(&class_name)), !geometry.is_empty());

    let attach_tags: Vec<String> = attach_first(record, &["AttachDef.Tags"])
        .and_then(Value::as_str)
        .map(|s| s.split_whitespace().map(str::to_string).collect())
        .unwrap_or_default();
    let size = int_of(attach_first(record, &["AttachDef.Size"]));
    let (code, maker_name) = super::build::manufacturer_for(record, makers, loc);
    let nodes: Vec<&GeoNode> = node.iter().collect();

    Some(json!({
        "id": record.get("_RecordId_").and_then(Value::as_str).unwrap_or(""),
        "class_name": class_name,
        "name": name.unwrap_or(&class_name),
        "name_key": name_key,
        "description": desc_key.and_then(|k| loc.get(k)),
        "description_key": desc_key,
        "slot": slot,
        "manufacturer": { "code": code, "name": maker_name },
        "attach": { "type": attach_type, "subtype": subtype, "size": size, "tags": attach_tags },
        "anim_set": anim_set_for(slot, &attach_tags),
        "tint": tint::tint_for(&nodes, palettes, &[], None),
        "geometry": geometry,
        "materials": materials,
        "default_children": default_children_for(record),
        "ports": ports_for(record),
        "flags": flags,
        "tags": sets::tags_for(record),
    }))
}

/// Colourways are one mesh in one slot. A weapon's edition sits mid-name in
/// quotes -- `P4-AR "Blacklist" Rifle` -- so armour's product-name key would
/// make every colourway its own family.
pub fn link_gear_variants(items: &mut [Value]) {
    let mut groups: HashMap<(String, String), Vec<usize>> = HashMap::new();
    for (index, item) in items.iter().enumerate() {
        let slot = item["slot"].as_str().unwrap_or("").to_string();
        let source = item["geometry"]
            .as_array()
            .and_then(|g| g.first())
            .and_then(|g| g["source"].as_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_else(|| sets::canonical_key(item["class_name"].as_str().unwrap_or("")));
        groups.entry((slot, source)).or_default().push(index);
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
            let class = items[i]["class_name"].as_str().unwrap_or("").to_string();
            (class.len(), class)
        });
        let canonical_id = items[group[0]]["id"].as_str().unwrap_or("").to_string();
        let rest: Vec<String> = group[1..]
            .iter()
            .map(|&i| items[i]["id"].as_str().unwrap_or("").to_string())
            .collect();
        items[group[0]]["variants"] = json!(rest);
        for &i in &group[1..] {
            items[i]["variant_of"] = json!(canonical_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slots_follow_the_attach_type() {
        assert_eq!(gear_slot_for("WeaponPersonal", "Medium"), Some("primary"));
        assert_eq!(gear_slot_for("WeaponPersonal", "Large"), Some("primary"));
        assert_eq!(gear_slot_for("WeaponPersonal", "Small"), Some("sidearm"));
        assert_eq!(gear_slot_for("WeaponAttachment", "Magazine"), Some("magazine"));
        assert_eq!(gear_slot_for("WeaponAttachment", "IronSight"), None, "optics are out");
        assert_eq!(gear_slot_for("FPS_Consumable", "Hacking"), None, "hacking chips are out");
        assert_eq!(gear_slot_for("FPS_Consumable", "Medical"), Some("consumable"));
    }

    #[test]
    fn scope_excludes_ship_guns_and_dev() {
        assert!(in_scope("libs/foundry/records/entities/scitem/weapons/fps_weapons/behr_rifle_ballistic_01.xml"));
        assert!(!in_scope("libs/foundry/records/entities/scitem/weapons/weapon_mounted/gats.xml"));
        assert!(!in_scope("libs/foundry/records/entities/scitem/weapons/fps_weapons/dev/x.xml"));
        assert!(!in_scope("libs/foundry/records/entities/scitem/characters/human/armor/x.xml"));
    }

    #[test]
    fn a_record_wears_the_child_its_geometry_tags_name() {
        let record = json!({ "_RecordValue_": { "Components": [
            { "_Type_": "SCItemWeaponComponentParams", "geometryTags": "Tint01" },
            { "_Type_": "SGeometryResourceParams", "Geometry": {
                "Geometry": { "Geometry": { "path": "objects/p4ar.cdf" }, "Material": { "path": "" },
                              "Palette": { "RootRecord": "file://default.json" } },
                "SubGeometry": [
                    { "Tags": "Green01", "Geometry": { "Geometry": { "path": "objects/p4ar.cdf" },
                      "Material": { "path": "objects/p4ar_green.mtl" } } },
                    { "Tags": "Tint01", "Geometry": { "Geometry": { "path": "objects/p4ar.cdf" },
                      "Palette": { "RootRecord": "file://black.json" } } }
                ] } }
        ] } });
        let node = selected_node(&record).unwrap();
        assert_eq!(node.palette.as_deref(), Some("file://black.json"));
        assert_eq!(node.material, None, "the root's empty material stays empty");
    }

    #[test]
    fn a_port_is_a_bone_port_with_its_types_and_sizes() {
        let record = json!({ "_RecordValue_": { "Components": [
            { "_Type_": "SItemPortContainerComponentParams", "Ports": [
                { "Name": "wep_stocked_3", "MinSize": 2, "MaxSize": 5,
                  "Types": [ { "Type": "WeaponPersonal", "SubTypes": ["Medium", "Large", ""] }, { "Type": "" } ],
                  "Extension": { "SelectTag": "backRight" },
                  "AttachmentImplementation": { "_Type_": "SItemPortDefAttachmentImplementationBone",
                    "Helper": { "Helper": { "Name": "wep_stocked_attach_3_override",
                                            "ItemOffsetHelperName": "attach_offset_left_01" } } } },
                { "Name": "Armor_Arms", "AttachmentImplementation": {
                    "_Type_": "SItemPortDefAttachmentImplementationSkin" } }
            ] }
        ] } });
        let ports = ports_for(&record);
        assert_eq!(ports.as_array().unwrap().len(), 1, "skin ports are not holsters");
        assert_eq!(ports[0]["types"], json!([{ "type": "WeaponPersonal", "subtypes": ["Medium", "Large"] }]));
        assert_eq!(ports[0]["offset"], json!("attach_offset_left_01"));
        assert_eq!(ports[0]["max_size"], json!(5));
    }
}
