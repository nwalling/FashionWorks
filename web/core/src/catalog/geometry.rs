//! The geometry tree, ported from `extract/sc_extract/catalog.py`.
//!
//! **The geometry field is a trap, and this module exists because of it.** The
//! root of `SGeometryResourceParams` is the dropped-item carry prop -- for
//! torso, arms and legs it is literally a storage crate -- and the worn meshes
//! hang off `SubGeometry`, one per gender. Taking the root blindly produces a
//! catalogue of crates.
//!
//! ```text
//! Geometry                      -> carry prop (.cgf), or a .cdf for some helmets
//!   SubGeometry[0]              -> carry prop again
//!   SubGeometry[1]              -> female_v2/... f_*.skin   <- worn, female
//!   SubGeometry[2]              -> male_v7/...   m_*.skin   <- worn, male
//! ```

use serde_json::Value;

use super::fields::{component, first_str};

/// Skeleton name -> the P4K directory holding that gender's wearables.
pub const SKELETON_ROOTS: [(&str, &str); 2] = [("male", "male_v7"), ("female", "female_v2")];

const MESH_SUFFIXES: [&str; 5] = [".skin", ".cdf", ".cga", ".cgf", ".chr"];
const SKINNED_SUFFIXES: [&str; 1] = [".skin"];
const RIGID_SUFFIXES: [&str; 2] = [".cga", ".cgf"];

const NODE_PATH: [&str; 2] = ["Geometry.Geometry.path", "Geometry.path"];
const NODE_MATERIAL: [&str; 2] = ["Geometry.Material.path", "Material.path"];
const NODE_PALETTE: [&str; 2] = ["Geometry.Palette.RootRecord", "Palette.RootRecord"];

/// One node of an `SGeometryResourceParams` geometry tree.
#[derive(Debug, Clone, PartialEq)]
pub struct GeoNode {
    pub path: String,
    pub material: Option<String>,
    pub depth: usize,
    pub palette: Option<String>,
}

impl GeoNode {
    pub fn suffix(&self) -> String {
        match self.path.rsplit_once('.') {
            Some((_, ext)) => format!(".{}", ext.to_ascii_lowercase()),
            None => String::new(),
        }
    }

    /// `_lod0.skin` and friends, matched only at the end of the filename.
    pub fn is_lod(&self) -> bool {
        let stem = self.stem_before_suffix();
        let lowered = stem.to_ascii_lowercase();
        match lowered.rfind("_lod") {
            Some(at) => lowered[at + 4..].chars().all(|c| c.is_ascii_digit())
                && lowered.len() > at + 4,
            None => false,
        }
    }

    /// The dropped/carried world model, not the worn mesh.
    pub fn is_prop(&self) -> bool {
        let lowered = self.stem_before_suffix().to_ascii_lowercase();
        lowered.ends_with("carry_prop") || lowered.ends_with("_prop")
    }

    /// Shared first-person visor meshes, offered per aspect ratio under every
    /// helmet.
    pub fn is_visor(&self) -> bool {
        self.path.to_ascii_lowercase().contains("/shared/visor/")
    }

    fn stem_before_suffix(&self) -> &str {
        match self.path.rsplit_once('.') {
            Some((stem, _)) => stem,
            None => &self.path,
        }
    }
}

/// Windows separators to POSIX, collapsing repeats and any leading slash.
pub fn normalize_asset_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let mut last_sep = false;
    for ch in path.chars() {
        let sep = ch == '\\' || ch == '/';
        if sep {
            if !last_sep {
                out.push('/');
            }
        } else {
            out.push(ch);
        }
        last_sep = sep;
    }
    out.trim_start_matches('/').to_string()
}

/// Flatten the geometry tree, depth-first, skipping paths already seen.
///
/// The de-duplication is load-bearing: the root and its first child are the
/// same carry prop, and keeping both would make every item look like it had an
/// extra mesh.
pub fn walk_geometry(record: &Value) -> Vec<GeoNode> {
    let Some(params) = component(record, "SGeometryResourceParams") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut seen = Vec::new();
    if let Some(root) = params.get("Geometry") {
        visit(root, 0, &mut out, &mut seen);
    }
    out
}

fn visit(node: &Value, depth: usize, out: &mut Vec<GeoNode>, seen: &mut Vec<String>) {
    if !node.is_object() {
        return;
    }
    if let Some(path) = first_str(node, &NODE_PATH).filter(|p| !p.is_empty()) {
        let normalized = normalize_asset_path(path);
        let key = normalized.to_ascii_lowercase();
        if !seen.contains(&key) {
            seen.push(key);
            out.push(GeoNode {
                path: normalized,
                material: first_str(node, &NODE_MATERIAL).map(normalize_asset_path),
                depth,
                palette: first_str(node, &NODE_PALETTE)
                    .filter(|p| !p.is_empty())
                    .map(str::to_string),
            });
        }
    }
    if let Some(children) = node.get("SubGeometry").and_then(Value::as_array) {
        for child in children {
            visit(child, depth + 1, out, seen);
        }
    }
}

/// Pick the meshes actually worn on `skeleton`.
///
/// Drops LODs, carry props and shared visors, and prefers the gendered `.skin`
/// over anything else. Falls back to a `.cdf` (which names the real mesh
/// indirectly) and finally to a rigid `.cga`/`.cgf`, which is how backpacks
/// ship. Returning nothing is better than returning a crate.
pub fn select_wearables<'a>(nodes: &'a [GeoNode], skeleton: &str) -> Vec<&'a GeoNode> {
    let root = SKELETON_ROOTS
        .iter()
        .find(|(name, _)| *name == skeleton)
        .map(|(_, dir)| *dir)
        .unwrap_or(skeleton);
    let others: Vec<&str> = SKELETON_ROOTS
        .iter()
        .filter(|(name, _)| *name != skeleton)
        .map(|(_, dir)| *dir)
        .collect();

    let usable: Vec<&GeoNode> = nodes
        .iter()
        .filter(|n| !n.is_lod() && !n.is_visor() && MESH_SUFFIXES.contains(&n.suffix().as_str()))
        .collect();

    let scoped: Vec<&GeoNode> = usable
        .into_iter()
        .filter(|n| {
            let lowered = n.path.to_ascii_lowercase();
            if lowered.contains(&format!("/{root}/")) {
                return true;
            }
            // Backpacks and other shared props live outside the gendered trees.
            !others
                .iter()
                .any(|o| lowered.contains(&format!("/{o}/")))
        })
        .collect();

    let skins: Vec<&GeoNode> = scoped
        .iter()
        .copied()
        .filter(|n| SKINNED_SUFFIXES.contains(&n.suffix().as_str()) && !n.is_prop())
        .collect();
    if !skins.is_empty() {
        return skins;
    }

    if let Some(cdf) = scoped.iter().copied().find(|n| n.suffix() == ".cdf") {
        return vec![cdf];
    }

    if let Some(rigid) = scoped
        .iter()
        .copied()
        .find(|n| RIGID_SUFFIXES.contains(&n.suffix().as_str()) && !n.is_prop())
    {
        return vec![rigid];
    }

    Vec::new()
}

/// Material paths for the worn meshes, falling back to the other skeleton's.
///
/// The material is often authored on one gender's node only -- ADP, Aril and
/// Aves put it on the female `.skin` and leave the male one null -- and an item
/// with no material does not render untinted, it wears whatever baked the
/// shared mesh. The fallback takes the *other skeleton's worn nodes* and never
/// the root, whose material is the carry crate's.
pub fn materials_for(nodes: &[GeoNode], skeleton: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for node in select_wearables(nodes, skeleton) {
        if let Some(material) = &node.material {
            if !out.contains(material) {
                out.push(material.clone());
            }
        }
    }
    if out.is_empty() {
        let other = if skeleton == "male" { "female" } else { "male" };
        for node in select_wearables(nodes, other) {
            // Skinned only. The fallback exists for the gendered-`.skin` case,
            // and a rigid piece has no gender split for it to help with -- but
            // the carry crate is a `.cgf` that is in scope for *both* genders,
            // so an unrestricted fallback hands a backpack the crate's
            // material and paints it as a storage box.
            if !SKINNED_SUFFIXES.contains(&node.suffix().as_str()) {
                continue;
            }
            if let Some(material) = &node.material {
                if !out.contains(material) {
                    out.push(material.clone());
                }
            }
        }
    }
    out
}

/// The palette hung off the record's `Material` sibling rather than its tree.
///
/// A rigid piece's colourway lives here: the CSP-68H Red Alert leaves every
/// `Palette` in its geometry tree null and names its IAE palette here instead.
pub fn material_palette(record: &Value) -> Option<String> {
    let params = component(record, "SGeometryResourceParams")?;
    let node = params.get("Material")?;
    let reference = node.get("Palette")?.get("RootRecord")?.as_str()?;
    (!reference.is_empty()).then(|| reference.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node(path: &str, material: Option<&str>) -> Value {
        let mut inner = json!({ "Geometry": { "path": path } });
        if let Some(m) = material {
            inner["Material"] = json!({ "path": m });
        }
        json!({ "Geometry": inner })
    }

    fn record(children: Vec<Value>) -> Value {
        json!({ "_RecordValue_": { "Components": [{
            "_Type_": "SGeometryResourceParams",
            "Geometry": {
                "Geometry": { "Geometry": { "path": "crate_armor_arms_1.cgf" } },
                "SubGeometry": children,
            }
        }]}})
    }

    #[test]
    fn the_root_is_a_crate_and_the_worn_mesh_hangs_off_subgeometry() {
        let rec = record(vec![
            node("Objects/Characters/Human/female_v2/armor/f_arms.skin", None),
            node("Objects/Characters/Human/male_v7/armor/m_arms.skin", None),
        ]);
        let nodes = walk_geometry(&rec);
        assert_eq!(nodes.len(), 3, "crate plus one mesh per gender");
        let worn = select_wearables(&nodes, "male");
        assert_eq!(worn.len(), 1);
        assert!(worn[0].path.ends_with("m_arms.skin"), "not the crate");
    }

    #[test]
    fn lods_props_and_visors_are_dropped() {
        let rec = record(vec![
            node("Objects/Characters/Human/male_v7/armor/m_arms_lod2.skin", None),
            node("Objects/Characters/Human/male_v7/armor/m_arms_prop.skin", None),
            node("Objects/Characters/Human/shared/visor/v_16x9.skin", None),
            node("Objects/Characters/Human/male_v7/armor/m_arms.skin", None),
        ]);
        let worn = walk_geometry(&rec);
        let picked = select_wearables(&worn, "male");
        assert_eq!(picked.len(), 1);
        assert!(picked[0].path.ends_with("m_arms.skin"));
    }

    #[test]
    fn a_material_falls_back_to_the_other_gender() {
        let rec = record(vec![
            node("Objects/Characters/Human/female_v2/armor/f_arms.skin", Some("shared.mtl")),
            node("Objects/Characters/Human/male_v7/armor/m_arms.skin", None),
        ]);
        let nodes = walk_geometry(&rec);
        assert_eq!(materials_for(&nodes, "male"), vec!["shared.mtl".to_string()]);
    }

    #[test]
    fn the_fallback_never_reaches_the_crate() {
        let mut rec = record(vec![node(
            "Objects/Characters/Human/male_v7/armor/m_arms.skin",
            None,
        )]);
        rec["_RecordValue_"]["Components"][0]["Geometry"]["Geometry"]["Material"] =
            json!({ "path": "crate.mtl" });
        let nodes = walk_geometry(&rec);
        assert!(materials_for(&nodes, "male").is_empty());
    }

    #[test]
    fn windows_separators_collapse() {
        assert_eq!(
            normalize_asset_path("Data\\\\Objects//x.skin"),
            "Data/Objects/x.skin"
        );
        assert_eq!(normalize_asset_path("/Data/x.skin"), "Data/x.skin");
    }
}
