//! Chunks a piece draws only beside the right partner.
//!
//! An Artimex helmet carries a cowl and a breathing tube that plug into the
//! Artimex core, and a Geist ASD helmet a hood that drapes onto the ASD core.
//! Neither is drawn with another core, or with none: the game's own inventory
//! icon shows the Artimex helmet bare. The record says so per chunk, in
//! `SCItemClothingParams.Chunks[].VisibilityConditions`:
//!
//! ```text
//! Chunks: theta_head_zone, VisibilityConditions:
//!   [ PortVisibility: [ Ports [Armor_Torso],
//!       ActiveTags [Global/Manufacturer/QuirinusTech, Armor/FPS/Archetype/Specialist,
//!                   Armor/FPS/Type/Medium, Theta/Variant] ] ]
//! ```
//!
//! **How it reads**, fitted to all 281 conditions on 204 records and checked
//! against which pieces each one picks:
//!
//! * a chunk with conditions is drawn while **any** of them holds -- the
//!   Arden-SL helmet lists two, its core in `Armor_Torso` or in `Torso_1`;
//! * a condition holds when **all** its port checks pass -- the Aril arms'
//!   chunk needs an Aril core *and* an Aril pack;
//! * a check passes when the item in its port holds every `ActiveTags` tag and
//!   none of its `DisableTags`. An empty port holds no tags, so the Clash
//!   core's back (`DisableTags [Armor/FPS/Part/Backpack]`) shows until a pack
//!   goes on, and the Artimex cowl does not show without a core.
//!
//! A tag is held **through the tree**: the helmet asks for `Theta/Variant` and
//! the core holds `Theta/Variant/01`. And an item's tags are its entity `tags`
//! together with its clothing's `OverlayTags`, because the conditions draw on
//! both -- the Artimex helmet names the entity's `Global/Manufacturer/
//! QuirinusTech`, the Palatino helmet the overlay's `Theta/Manufacturer/Qrt`.
//! Read that way, the Artimex helmet's cowl answers to the three Artimex core
//! families and nothing else, the Geist ASD hood to the ASD cores, the
//! Arden-SL, Palatino and Outback helmets each to their own core, and the
//! Piecemeal core's hood to the Badami helmet.
//!
//! `SkipTags` is empty on every record and is not carried. A check on a port
//! nothing is worn in -- a magazine or a hand -- reads as empty.
//!
//! The Python catalogue does not carry this: the local viewer's baked meshes
//! keep no zone submeshes to hide, and the pipeline's DataCore export has no
//! tag tree. `chunks`, which both carry, is unchanged.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};
use starbreaker_datacore::{export, Database};

use super::fields::{component, record_body};

/// The one record that holds the tag tree.
pub const TAG_DATABASE: &str = "TagDatabase";

/// Every tag's path in the tag tree, by GUID: `Global/Manufacturer/QuirinusTech`.
///
/// A reference names a tag by GUID alone, and a tag's name alone is not enough
/// to test against: "Medium" is a weight under `Armor/FPS/Type` and a size
/// elsewhere. The path is unique, and testing a tag *through the tree* -- the
/// condition's `Theta/Variant` held by a core's `Theta/Variant/01` -- is a
/// prefix test on it.
pub struct TagIndex {
    paths: HashMap<String, String>,
}

impl TagIndex {
    pub fn build(db: &Database) -> Self {
        let mut paths = HashMap::new();
        for record in db.records_by_type_name(TAG_DATABASE) {
            let mut buf = Vec::new();
            if export::write_json_compact(db, record, &mut buf).is_err() {
                continue;
            }
            if let Ok(value) = serde_json::from_slice::<Value>(&buf) {
                walk(record_body(&value).get("tags"), "", &mut paths);
            }
        }
        Self { paths }
    }

    /// The index of a `TagDatabase` record already read as JSON.
    pub fn from_record(record: &Value) -> Self {
        let mut paths = HashMap::new();
        walk(record_body(record).get("tags"), "", &mut paths);
        Self { paths }
    }

    /// The path of the tag a reference names, if it names one.
    pub fn path(&self, reference: &Value) -> Option<&str> {
        let id = reference.get("_RecordId_")?.as_str()?;
        self.paths.get(id).map(String::as_str)
    }

    pub fn len(&self) -> usize {
        self.paths.len()
    }

    pub fn is_empty(&self) -> bool {
        self.paths.is_empty()
    }

    /// The paths of a list of references, in order, dropping any that name no
    /// tag. A condition that cannot be read then asks for less, never more: it
    /// hides nothing a record did not say to hide.
    fn paths_of(&self, references: Option<&Value>) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for reference in references.and_then(Value::as_array).into_iter().flatten() {
            if let Some(path) = self.path(reference) {
                if !out.iter().any(|seen| seen == path) {
                    out.push(path.to_string());
                }
            }
        }
        out
    }
}

fn walk(tags: Option<&Value>, parent: &str, out: &mut HashMap<String, String>) {
    for tag in tags.and_then(Value::as_array).into_iter().flatten() {
        let Some(name) = tag.get("tagName").and_then(Value::as_str) else {
            continue;
        };
        let path = if parent.is_empty() { name.to_string() } else { format!("{parent}/{name}") };
        if let Some(id) = tag.get("_RecordId_").and_then(Value::as_str) {
            out.entry(id.to_string()).or_insert_with(|| path.clone());
        }
        walk(tag.get("children"), &path, out);
    }
}

/// The chunks a record draws only under conditions, as
/// `{zone, when: [[{ports, active, disable}]]}`: the zone is drawn while any
/// entry of `when` holds, each a list of checks that must all pass.
///
/// A check with no port is dropped, and so is a condition left with no checks:
/// the eight Arden-SL cores carry one with neither ports nor tags, which asks
/// for nothing. A chunk with no condition left is unconditional and not listed.
pub fn visibility_for(record: &Value, tags: &TagIndex) -> Vec<Value> {
    let chunks = component(record, "SCItemClothingParams")
        .and_then(|p| p.get("Chunks"))
        .and_then(Value::as_array);
    let mut out = Vec::new();
    for chunk in chunks.into_iter().flatten() {
        let Some(zone) = chunk.get("MeshChunk").and_then(Value::as_str).filter(|z| !z.is_empty()) else {
            continue;
        };
        let mut when = Vec::new();
        for condition in chunk.get("VisibilityConditions").and_then(Value::as_array).into_iter().flatten() {
            let mut checks = Vec::new();
            for check in condition.get("PortVisibility").and_then(Value::as_array).into_iter().flatten() {
                let ports: Vec<&str> = check
                    .get("Ports")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .filter(|p| !p.is_empty())
                    .collect();
                if ports.is_empty() {
                    continue;
                }
                checks.push(json!({
                    "ports": ports,
                    "active": tags.paths_of(check.get("ActiveTags")),
                    "disable": tags.paths_of(check.get("DisableTags")),
                }));
            }
            if !checks.is_empty() {
                when.push(Value::Array(checks));
            }
        }
        if !when.is_empty() {
            out.push(json!({ "zone": zone, "when": when }));
        }
    }
    out
}

/// What a check can test an item for: its entity `tags` and its clothing's
/// `OverlayTags`, as paths. Trimmed to what some condition reads once the
/// catalogue is built ([`keep_read_tags`]).
pub fn tagged_for(record: &Value, tags: &TagIndex) -> Vec<String> {
    let overlay = component(record, "SCItemClothingParams")
        .and_then(|p| p.get("OverlayTags"))
        .and_then(|t| t.get("tags"));
    let mut out = tags.paths_of(record_body(record).get("tags"));
    for path in tags.paths_of(overlay) {
        if !out.contains(&path) {
            out.push(path);
        }
    }
    out
}

/// Whether `held` is `wanted` or sits under it in the tree.
pub fn holds(held: &str, wanted: &str) -> bool {
    held == wanted || (held.len() > wanted.len() && held.starts_with(wanted) && held.as_bytes()[wanted.len()] == b'/')
}

/// Keep of each item's `tagged` only the tags some condition in the catalogue
/// tests, and drop the field where none is left. An item carries thirteen tags
/// or so, loot tables and interaction points among them, and a check only ever
/// asks about a few dozen.
pub fn keep_read_tags(items: &mut [Value]) {
    let mut read: HashSet<String> = HashSet::new();
    for item in items.iter() {
        for chunk in item.get("visibility").and_then(Value::as_array).into_iter().flatten() {
            for condition in chunk["when"].as_array().into_iter().flatten() {
                for check in condition.as_array().into_iter().flatten() {
                    for key in ["active", "disable"] {
                        for tag in check[key].as_array().into_iter().flatten().filter_map(Value::as_str) {
                            read.insert(tag.to_string());
                        }
                    }
                }
            }
        }
    }
    for item in items.iter_mut() {
        let Some(object) = item.as_object_mut() else { continue };
        let kept: Vec<Value> = object
            .get("tagged")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|held| read.iter().any(|wanted| holds(held, wanted)))
            .map(|held| Value::String(held.to_string()))
            .collect();
        if kept.is_empty() {
            object.remove("tagged");
        } else {
            object.insert("tagged".to_string(), Value::Array(kept));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tag(id: &str, name: &str, children: Vec<Value>) -> Value {
        json!({ "_RecordId_": id, "_Type_": "Tag", "tagName": name, "children": children })
    }

    fn reference(id: &str) -> Value {
        json!({ "_RecordName_": format!("Tag.{id}"), "_RecordId_": id })
    }

    fn index() -> TagIndex {
        TagIndex::from_record(&json!({ "_RecordValue_": { "_Type_": "TagDatabase", "tags": [
            tag("g", "Global", vec![tag("m", "Manufacturer", vec![tag("q", "QuirinusTech", vec![]), tag("k", "KilgoreAndPoole", vec![])])]),
            tag("t", "Theta", vec![tag("v", "Variant", vec![tag("v1", "01", vec![])]), tag("tm", "Manufacturer", vec![tag("tq", "Qrt", vec![])])]),
        ]}}))
    }

    #[test]
    fn a_tag_is_its_path_in_the_tree() {
        let tags = index();
        assert_eq!(tags.len(), 9);
        assert_eq!(tags.path(&reference("q")), Some("Global/Manufacturer/QuirinusTech"));
        assert_eq!(tags.path(&reference("v1")), Some("Theta/Variant/01"));
        assert_eq!(tags.path(&reference("missing")), None);
        assert!(holds("Theta/Variant/01", "Theta/Variant"));
        assert!(holds("Theta/Variant", "Theta/Variant"));
        assert!(!holds("Theta/Variants", "Theta/Variant"), "a sibling with a longer name is not a child");
        assert!(!holds("Theta", "Theta/Variant"));
    }

    #[test]
    fn the_artimex_cowl_is_drawn_with_its_core() {
        let tags = index();
        let helmet = json!({ "_RecordValue_": { "Components": [ { "_Type_": "SCItemClothingParams",
            "Chunks": [
                { "MeshChunk": "theta_head_zone", "Layer": 2, "VisibleLayers": [], "VisibilityConditions": [
                    { "PortVisibility": [ { "Ports": ["Armor_Torso"], "ActiveTags": [reference("q"), reference("v"), null], "DisableTags": [], "SkipTags": [] } ] } ] },
                { "MeshChunk": "torso01_zone", "Layer": 2, "VisibleLayers": [] },
                // Ports and tags both empty: asks for nothing.
                { "MeshChunk": "omega_core_zone", "Layer": 4, "VisibilityConditions": [ { "PortVisibility": [ { "Ports": [], "ActiveTags": [] } ] } ] } ] } ] } });
        assert_eq!(
            visibility_for(&helmet, &tags),
            vec![json!({ "zone": "theta_head_zone", "when": [[
                { "ports": ["Armor_Torso"], "active": ["Global/Manufacturer/QuirinusTech", "Theta/Variant"], "disable": [] } ]] })],
        );
    }

    #[test]
    fn an_item_is_tagged_by_its_entity_and_its_overlay() {
        let tags = index();
        let core = json!({ "_RecordValue_": { "tags": [reference("q"), reference("v1")], "Components": [
            { "_Type_": "SCItemClothingParams", "OverlayTags": { "_Type_": "TagList", "tags": [reference("tq"), reference("v1")] } } ] } });
        assert_eq!(tagged_for(&core, &tags), vec!["Global/Manufacturer/QuirinusTech", "Theta/Variant/01", "Theta/Manufacturer/Qrt"]);
    }

    #[test]
    fn only_the_tags_a_condition_reads_are_kept() {
        let mut items = vec![
            json!({ "class_name": "helmet", "visibility": [ { "zone": "theta_head_zone", "when": [[
                { "ports": ["Armor_Torso"], "active": ["Global/Manufacturer/QuirinusTech", "Theta/Variant"], "disable": [] } ]] } ] }),
            json!({ "class_name": "core", "tagged": ["Global/Manufacturer/QuirinusTech", "LootGeneration/CanGenerateAsLoot", "Theta/Variant/01"] }),
            json!({ "class_name": "other", "tagged": ["LootGeneration/CanGenerateAsLoot"] }),
        ];
        keep_read_tags(&mut items);
        assert_eq!(items[1]["tagged"], json!(["Global/Manufacturer/QuirinusTech", "Theta/Variant/01"]));
        assert!(items[2].get("tagged").is_none());
        assert!(items[0].get("tagged").is_none());
    }
}
