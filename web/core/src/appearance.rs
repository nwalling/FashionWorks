//! What a character looks like beyond the shape of its face: the head material
//! its skin is drawn with, the colours the customizer set, and the items it
//! wears on its head. CHARACTER.md Phases 2 and 3.
//!
//! **A `.chf` names everything by GUID, and two different tables hold them.**
//! Its items -- hair, brows, beard, lashes, eyes, piercings -- are ordinary
//! DataCore records, `EntityClassDefinition`s under
//! `entities/scitem/characters/human/head/`. Its materials are not records at
//! all: the head material's GUID is a key in the lookup table of one record,
//! `SCharacterGenerationParams.DefaultCharacterGenerationParams`, which maps
//! 94 material GUIDs and 40 texture GUIDs to files. Ilucide's head material is
//! `male36_t1_head_material.mtl`; every one of the 40 archive files resolves.
//!
//! Both tables are small and live in the 316 MB DataCore, which the worker
//! reads once to build the catalogue and deliberately does not keep. So they
//! are taken out then, into a [`Library`] of a few hundred entries.

use std::collections::HashMap;

use serde_json::Value;
use starbreaker_chf::{ChfData, ItemPort};
use starbreaker_common::NameHash;
use starbreaker_datacore::{export, Database};

use crate::catalog::fields::{component, first_str, record_body};
use crate::catalog::geometry::normalize_asset_path;

/// The record whose lookup table resolves a `.chf`'s material GUIDs.
const GENERATION_PARAMS: &str = "SCharacterGenerationParams";

/// Only records under this path are head items.
const HEAD_ITEMS: &str = "entities/scitem/characters/human/head/";

/// One node of an item's geometry tree, pruned to what wearing it needs.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GeoNode {
    pub tags: Vec<String>,
    pub mesh: Option<String>,
    pub material: Option<String>,
    pub children: Vec<GeoNode>,
}

/// One node of an item's material-variant tree: a material chosen by tags.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MatNode {
    pub tags: Vec<String>,
    pub material: Option<String>,
    pub children: Vec<MatNode>,
}

/// A head item: what it is, and the trees that say what it looks like.
#[derive(Debug, Clone, PartialEq)]
pub struct HeadItem {
    pub class_name: String,
    /// `AttachDef.Type`: `Char_Head_Hair`, `Char_Head_Beard`, ...
    pub kind: String,
    /// Tags the item asserts on whoever wears it, from `AttachDef.Tags`
    /// entries written `$tag+` or `$$tag++`: `hair_75` asserts
    /// `scalpVHair_75`, which is how the universal scalp under it knows which
    /// material to wear.
    pub asserts: Vec<String>,
    pub geometry: GeoNode,
    /// The item's own material, `SMaterialNodeParams.Material`.
    pub material: Option<String>,
    pub variants: Vec<MatNode>,
}

/// A head item as worn on one body.
#[derive(Debug, Clone, PartialEq)]
pub struct Worn {
    pub mesh: String,
    /// None where nothing names one; the caller looks beside the mesh.
    pub material: Option<String>,
    /// Alternative meshes by geometry tag -- `hatHair` under a cap. A tag with
    /// no mesh means the part is not drawn while that tag is asked for.
    pub variants: Vec<(String, Option<String>, Option<String>)>,
}

impl HeadItem {
    /// The mesh this item puts on `body` (`Male` or `Female`), given every tag
    /// the character's items assert.
    ///
    /// The body's node is the child tagged with it. The eyes carry one more
    /// level -- a node per head they were made for, the body under each -- and
    /// take the `Protos_head` one, the head a `.chf` is written against.
    pub fn worn(&self, body: &str, asserted: &[String]) -> Option<Worn> {
        let has = |node: &GeoNode, tag: &str| node.tags.iter().any(|t| t.eq_ignore_ascii_case(tag));
        let scope = self
            .geometry
            .children
            .iter()
            .find(|c| has(c, "Protos_head"))
            .unwrap_or(&self.geometry);
        let node = scope
            .children
            .iter()
            .find(|c| has(c, body) && c.mesh.is_some())
            .or_else(|| scope.mesh.as_ref().map(|_| scope))?;
        let mesh = node.mesh.clone()?;

        let mut active: Vec<String> = vec![body.to_string()];
        active.extend(asserted.iter().cloned());
        let (score, chosen) = best_variant(&self.variants, &active, 0);
        // A variant that matches on more than the body's own tag is the item
        // choosing a material for this character -- the scalp's
        // `scalpVHair_75` -- and outranks the node's default.
        let material = match (score, chosen) {
            (s, Some(m)) if s >= 2 => Some(m),
            (_, found) => node.material.clone().or(found).or_else(|| self.material.clone()),
        };
        let variants = node
            .children
            .iter()
            .flat_map(|child| {
                child.tags.iter().map(move |tag| (tag.clone(), child.mesh.clone(), child.material.clone()))
            })
            .collect();
        Some(Worn { mesh, material, variants })
    }
}

/// The deepest material variant whose tags are all active, and how many tags
/// it matched on the way down.
fn best_variant(nodes: &[MatNode], active: &[String], depth: usize) -> (usize, Option<String>) {
    let mut best = (0, None);
    for node in nodes {
        let matches = node.tags.iter().all(|t| active.iter().any(|a| a.eq_ignore_ascii_case(t)));
        if !matches {
            continue;
        }
        let score = depth + node.tags.len();
        if let Some(material) = &node.material {
            if score > best.0 {
                best = (score, Some(material.clone()));
            }
        }
        let below = best_variant(&node.children, active, score);
        if below.1.is_some() && below.0 > best.0 {
            best = below;
        }
    }
    best
}

/// The customizer's tables, taken out of the DataCore once.
#[derive(Debug, Clone, Default)]
pub struct Library {
    /// Material GUID, lowercased, to `.mtl` path.
    pub materials: HashMap<String, String>,
    /// Texture GUID, lowercased, to texture path.
    pub textures: HashMap<String, String>,
    /// Head items by record GUID, lowercased.
    pub items: HashMap<String, HeadItem>,
}

impl Library {
    pub fn build(db: &Database) -> Library {
        let mut library = Library::default();
        for record in db.records_by_type_name(GENERATION_PARAMS) {
            let Some(value) = record_json(db, record) else { continue };
            let Some(table) = record_body(&value).get("materialLookupTable") else { continue };
            for (key, into) in [("materials", &mut library.materials), ("textures", &mut library.textures)] {
                for entry in table.get(key).and_then(Value::as_array).into_iter().flatten() {
                    let guid = entry.get("guid").and_then(Value::as_str);
                    let path = entry.get("filePath").and_then(Value::as_str).filter(|p| !p.is_empty());
                    if let (Some(guid), Some(path)) = (guid, path) {
                        into.entry(guid.to_ascii_lowercase()).or_insert_with(|| normalize_asset_path(path));
                    }
                }
            }
        }
        for record in db.records_by_type_name("EntityClassDefinition") {
            let source = db.resolve_string(record.file_name_offset).replace('\\', "/").to_ascii_lowercase();
            if !source.contains(HEAD_ITEMS) {
                continue;
            }
            let Some(value) = record_json(db, record) else { continue };
            let Some(guid) = value.get("_RecordId_").and_then(Value::as_str) else { continue };
            if let Some(item) = head_item(&value) {
                library.items.insert(guid.to_ascii_lowercase(), item);
            }
        }
        library
    }

    pub fn material(&self, guid: &str) -> Option<&str> {
        self.materials.get(&guid.to_ascii_lowercase()).map(String::as_str)
    }

    pub fn item(&self, guid: &str) -> Option<&HeadItem> {
        self.items.get(&guid.to_ascii_lowercase())
    }
}

fn record_json(db: &Database, record: &starbreaker_datacore::types::Record) -> Option<Value> {
    let mut buf = Vec::new();
    export::write_json_compact(db, record, &mut buf).ok()?;
    serde_json::from_slice(&buf).ok()
}

fn tags_of(value: &Value) -> Vec<String> {
    value
        .get("Tags")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .split_whitespace()
        .map(str::to_string)
        .collect()
}

fn geo_node(value: &Value) -> GeoNode {
    let path = |paths: &[&str]| first_str(value, paths).filter(|p| !p.is_empty()).map(normalize_asset_path);
    GeoNode {
        tags: tags_of(value),
        mesh: path(&["Geometry.Geometry.path"]),
        material: path(&["Geometry.Material.path"]),
        children: value
            .get("SubGeometry")
            .and_then(Value::as_array)
            .map(|c| c.iter().map(geo_node).collect())
            .unwrap_or_default(),
    }
}

fn mat_node(value: &Value) -> MatNode {
    MatNode {
        tags: tags_of(value),
        material: first_str(value, &["Material.path"]).filter(|p| !p.is_empty()).map(normalize_asset_path),
        children: value
            .get("materialVariants")
            .and_then(Value::as_array)
            .map(|c| c.iter().map(mat_node).collect())
            .unwrap_or_default(),
    }
}

/// A head item from its record, or None for a record that is not one.
pub fn head_item(value: &Value) -> Option<HeadItem> {
    let attach = component(value, "SAttachableComponentParams")?.get("AttachDef")?;
    let kind = attach.get("Type").and_then(Value::as_str)?.to_string();
    let asserts = attach
        .get("Tags")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .split_whitespace()
        .filter(|t| t.starts_with('$'))
        .map(|t| t.trim_start_matches('$').trim_end_matches('+').to_string())
        .filter(|t| !t.is_empty())
        .collect();
    let class_name = value
        .get("_RecordName_")
        .and_then(Value::as_str)
        .map(crate::catalog::class_name_of)
        .unwrap_or_default()
        .to_string();
    let geometry = component(value, "SGeometryResourceParams");
    let material = geometry.and_then(|g| g.get("Material"));
    Some(HeadItem {
        class_name,
        kind,
        asserts,
        geometry: geometry.and_then(|g| g.get("Geometry")).map(geo_node).unwrap_or_default(),
        material: material
            .and_then(|m| first_str(m, &["Material.path"]))
            .filter(|p| !p.is_empty())
            .map(normalize_asset_path),
        variants: material
            .and_then(|m| m.get("materialVariants"))
            .and_then(Value::as_array)
            .map(|c| c.iter().map(mat_node).collect())
            .unwrap_or_default(),
    })
}

/// A hair material's colour parameters, as the `.chf` sets them.
///
/// Names match the `HairPBR` `.mtl` parameters one for one, except the dye:
/// the `.chf`'s `HairDyeColor1` is the material's `DyeColor`, written in sRGB.
/// The masculine default's `#89756b` is exactly `hair_31`'s
/// `DyeColor="0.25015837,0.17788844,0.14702728"`.
pub type HairParams = Vec<(String, Vec<f32>)>;

/// What the `.chf` says about colour. Every colour here is linear.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Looks {
    /// The head material's GUID, for [`Library::material`].
    pub head_material: Option<String>,
    /// `BodyColor`: the `HumanSkin_V2` `FinalSkinTone` both head and body are
    /// recoloured to. The masculine default's `#513428` is exactly
    /// `MasculineDefault.xml`'s `FinalSkinTone`.
    pub skin: Option<[f32; 3]>,
    /// `EyeColor`: the `Eye` shader's `IrisColor`. The masculine default's
    /// `#37110a` is exactly its XML's `IrisColor`.
    pub iris: Option<[f32; 3]>,
    pub hair: HairParams,
    pub beard: HairParams,
    pub eyebrows: HairParams,
    /// The head's own scalar parameters: freckles, sun spots, and the rest.
    pub head: Vec<(String, f32)>,
}

/// Whether a `.chf` name hash is `name`.
///
/// **Not always its CRC32C.** Most names are, but the material and colour
/// names -- `Head Material`, `HairDyeMaterial`, `BodyColor`, `EyeColor`,
/// `HairDyeColor1` among them -- are stored under hashes that match no
/// spelling anyone has found, and StarBreaker maps them by hand. Comparing
/// against `NameHash::from_string` read every colour as absent.
fn is(hash: NameHash, name: &str) -> bool {
    hash.name() == Some(name) || hash == NameHash::from_string(name)
}

/// sRGB bytes to linear.
pub fn srgb_to_linear(c: u8) -> f32 {
    let c = f32::from(c) / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// Parameter names the hair shader reads. The `.chf` stores names as CRC32C
/// hashes, so a name has to be known to be read back.
const HAIR_PARAMS: [&str; 7] = [
    "BaseMelanin",
    "BaseMelaninRedness",
    "BaseMelaninVariation",
    "DyeAmount",
    "DyeShift",
    "DyeFadeout",
    "DyePigmentVariation",
];

const HEAD_PARAMS: [&str; 4] = ["FrecklesAmount", "FrecklesOpacity", "SunSpotsAmount", "SunSpotsOpacity"];

pub fn read_looks(data: &ChfData) -> Looks {
    let mut looks = Looks::default();
    let colour = |sub: &starbreaker_chf::material::SubMaterial, name: &str| {
        sub.material_colors
            .iter()
            .find(|c| is(c.name, name))
            .map(|c| [srgb_to_linear(c.value.r), srgb_to_linear(c.value.g), srgb_to_linear(c.value.b)])
    };
    let hair = |sub: &starbreaker_chf::material::SubMaterial| {
        let mut out: HairParams = HAIR_PARAMS
            .iter()
            .filter_map(|name| {
                let found = sub.material_params.iter().find(|p| is(p.name, name))?;
                Some((name.to_string(), vec![found.value]))
            })
            .collect();
        if let Some(dye) = colour(sub, "HairDyeColor1") {
            out.push(("DyeColor".to_string(), dye.to_vec()));
        }
        out
    };
    for material in &data.materials {
        let Some(sub) = material.sub_materials.first() else { continue };
        if is(material.name, "Head Material") {
            let guid = material.guid.to_string();
            if guid != "00000000-0000-0000-0000-000000000000" {
                looks.head_material = Some(guid);
            }
            looks.skin = looks.skin.or_else(|| colour(sub, "BodyColor"));
            looks.head = HEAD_PARAMS
                .iter()
                .filter_map(|name| {
                    let found = sub.material_params.iter().find(|p| is(p.name, name))?;
                    Some((name.to_string(), found.value))
                })
                .collect();
        } else if is(material.name, "BodyMaterial") {
            looks.skin = looks.skin.or_else(|| colour(sub, "BodyColor"));
        } else if is(material.name, "EyeMaterial") {
            looks.iris = colour(sub, "EyeColor");
        } else if is(material.name, "HairDyeMaterial") {
            looks.hair = hair(sub);
        } else if is(material.name, "BeardDyeMaterial") {
            looks.beard = hair(sub);
        } else if is(material.name, "EyebrowDyeMaterial") {
            looks.eyebrows = hair(sub);
        }
    }
    looks
}

/// Every item in the `.chf`'s port tree, as (port name, record GUID).
pub fn read_items(data: &ChfData) -> Vec<(String, String)> {
    fn walk(port: &ItemPort, out: &mut Vec<(String, String)>) {
        let guid = port.id.to_string();
        if guid != "00000000-0000-0000-0000-000000000000" {
            out.push((port.name.to_string(), guid));
        }
        for child in &port.children {
            walk(child, out);
        }
    }
    let mut out = Vec::new();
    walk(&data.itemport, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node(tags: &str, mesh: Option<&str>, material: Option<&str>, children: Vec<GeoNode>) -> GeoNode {
        GeoNode {
            tags: tags.split_whitespace().map(str::to_string).collect(),
            mesh: mesh.map(str::to_string),
            material: material.map(str::to_string),
            children,
        }
    }

    fn item(geometry: GeoNode, material: Option<&str>, variants: Vec<MatNode>) -> HeadItem {
        HeadItem {
            class_name: "x".into(),
            kind: "Char_Head_Hair".into(),
            asserts: vec![],
            geometry,
            material: material.map(str::to_string),
            variants,
        }
    }

    #[test]
    fn the_body_s_node_is_worn_with_its_variants() {
        let hair = item(
            node("", None, None, vec![
                node("Female", Some("f_hair_75.skin"), None, vec![]),
                node("Male", Some("m_hair_75.skin"), None, vec![
                    node("hatHair", Some("m_hair_75_casual.skin"), Some("m_hair_75.mtl"), vec![]),
                    node("hatHair_mask", None, None, vec![]),
                ]),
            ]),
            None,
            vec![],
        );
        let worn = hair.worn("Male", &[]).unwrap();
        assert_eq!(worn.mesh, "m_hair_75.skin");
        assert_eq!(worn.material, None);
        assert_eq!(worn.variants.len(), 2);
        assert_eq!(worn.variants[1], ("hatHair_mask".to_string(), None, None));
        assert_eq!(hair.worn("Female", &[]).unwrap().mesh, "f_hair_75.skin");
    }

    #[test]
    fn eyes_take_the_protos_head_s_node() {
        let eyes = item(
            node("", None, None, vec![
                node("macken_t2_head", Some("protos_eyes.skin"), Some("macken_eyes.mtl"), vec![]),
                node("Protos_head", None, None, vec![
                    node("Male", Some("protos_male_eyes.skin"), None, vec![]),
                    node("Female", Some("protos_female_eyes.skin"), None, vec![]),
                ]),
            ]),
            Some("eyes_white_01_charactercustomizer.mtl"),
            vec![],
        );
        let worn = eyes.worn("Male", &[]).unwrap();
        assert_eq!(worn.mesh, "protos_male_eyes.skin");
        assert_eq!(worn.material.as_deref(), Some("eyes_white_01_charactercustomizer.mtl"));
    }

    #[test]
    fn an_asserted_tag_chooses_the_scalp_s_material() {
        let scalp = item(
            node("", None, None, vec![node("Male", Some("m_universal_scalp.skin"), Some("m_hair_02.mtl"), vec![])]),
            None,
            vec![MatNode {
                tags: vec!["Male".into()],
                material: None,
                children: vec![
                    MatNode { tags: vec!["scalpVHair_02".into()], material: Some("m_hair_02.mtl".into()), children: vec![] },
                    MatNode { tags: vec!["scalpVHair_75".into()], material: Some("m_hair_75.mtl".into()), children: vec![] },
                ],
            }],
        );
        assert_eq!(scalp.worn("Male", &["scalpVHair_75".into()]).unwrap().material.as_deref(), Some("m_hair_75.mtl"));
        // Nothing asserted: the node's own material.
        assert_eq!(scalp.worn("Male", &[]).unwrap().material.as_deref(), Some("m_hair_02.mtl"));
    }

    #[test]
    fn a_body_only_variant_does_not_outrank_the_node() {
        let brows = item(
            node("", None, None, vec![node("Male", Some("m_brows_001.skin"), Some("male/brows_001.mtl"), vec![])]),
            None,
            vec![MatNode { tags: vec!["Male".into()], material: Some("other.mtl".into()), children: vec![] }],
        );
        assert_eq!(brows.worn("Male", &[]).unwrap().material.as_deref(), Some("male/brows_001.mtl"));
    }

    #[test]
    fn asserted_tags_are_read_off_the_attach_def() {
        let record = json!({
            "_RecordName_": "EntityClassDefinition.hair_75",
            "_RecordValue_": {"Components": [
                {"_Type_": "SAttachableComponentParams", "AttachDef": {
                    "Type": "Char_Head_Hair", "Tags": "UnifiedHead CustomizerReady $$scalpVHair_75++"}},
                {"_Type_": "SGeometryResourceParams", "Geometry": {"Tags": "", "SubGeometry": [
                    {"Tags": "Male", "Geometry": {"Geometry": {"path": "Objects\\m_hair_75.skin"}, "Material": {"path": ""}}}
                ]}}
            ]}
        });
        let hair = head_item(&record).unwrap();
        assert_eq!(hair.class_name, "hair_75");
        assert_eq!(hair.asserts, vec!["scalpVHair_75".to_string()]);
        assert_eq!(hair.worn("Male", &[]).unwrap().mesh, "Objects/m_hair_75.skin");
    }

    #[test]
    fn srgb_round_trips_the_default_s_skin() {
        // `#513428` is MasculineDefault.xml's FinalSkinTone.
        let skin = [srgb_to_linear(0x51), srgb_to_linear(0x34), srgb_to_linear(0x28)];
        for (got, want) in skin.iter().zip([0.082282715, 0.034339812, 0.021219013]) {
            assert!((got - want).abs() < 0.0006, "{got} vs {want}");
        }
    }
}
