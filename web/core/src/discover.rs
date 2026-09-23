//! Finding a material for an item that declares none.
//!
//! A quarter of the catalogue names no `.mtl` anywhere in its geometry tree,
//! and **97 of the 142 backpacks** are among them: Arden-CL, Aril, Cataby and
//! the rest came out in the renderer's placeholder grey. The files are in the
//! archive; nothing points at them. The pipeline finds them at convert time
//! (`pipeline.discover_materials`), and this is that search, ported.
//!
//! Two keys, in the pipeline's order:
//!
//! * **The class name**, when nothing is declared. A backpack colourway hangs
//!   off the same `.cga` as the rest of its family, so pairing on the mesh gives
//!   every member one material -- which is how CSP-68L Forest Camo once wore
//!   Cayman's surface. The class is more specific: sometimes exactly
//!   (`cds_combat_light_backpack_02_02_01.mtl`), sometimes with the trailing
//!   component dropped (`..._01_04_01` -> `..._01_04.mtl`), so tokens come off
//!   one at a time and the most specific match wins.
//! * **The mesh**: the material its own `MTL_NAME` chunk names, then
//!   `<stem>.mtl` beside it, then `<stem>_NN.mtl` lowest first, then the same
//!   with trailing tokens dropped -- `m_cds_heavy_armor_01_arms.skin` pairs with
//!   `m_cds_heavy_armor_01_01.mtl`.

use std::collections::HashMap;

/// Only materials under these can belong to a wearable or a piece of gear.
/// The archive holds 1.37 M entries, and a class-name stem is short enough to
/// collide with an unrelated ship or prop material somewhere else.
const SCOPES: [&str; 2] = ["objects/characters/", "objects/fps_weapons/"];

#[derive(Debug, Default)]
pub struct MtlIndex {
    /// Lowercased stem -> normalised path. First wins, as in the pipeline.
    by_stem: HashMap<String, String>,
    /// Lowercased directory -> the stems in it, sorted.
    by_dir: HashMap<String, Vec<String>>,
}

fn split(path: &str) -> (&str, &str) {
    let (dir, file) = path.rsplit_once('/').unwrap_or(("", path));
    let stem = file.split('.').next().unwrap_or(file);
    (dir, stem)
}

impl MtlIndex {
    /// Build from normalised archive paths (lowercase, forward slashes, no
    /// leading `data/`).
    pub fn build<'a>(paths: impl IntoIterator<Item = &'a str>) -> MtlIndex {
        let mut index = MtlIndex::default();
        for path in paths {
            if !SCOPES.iter().any(|scope| path.starts_with(scope)) || !path.ends_with(".mtl") {
                continue;
            }
            let (dir, stem) = split(path);
            index.by_stem.entry(stem.to_string()).or_insert_with(|| path.to_string());
            index.by_dir.entry(dir.to_string()).or_default().push(stem.to_string());
        }
        for stems in index.by_dir.values_mut() {
            stems.sort();
            stems.dedup();
        }
        index
    }

    pub fn len(&self) -> usize {
        self.by_stem.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_stem.is_empty()
    }

    /// The material named after a class, longest prefix first.
    pub fn by_class(&self, class_name: &str) -> Option<&str> {
        let lowered = class_name.to_ascii_lowercase();
        let mut parts: Vec<&str> = lowered.split('_').collect();
        while parts.len() > 2 {
            let stem = parts.join("_");
            for candidate in [stem.clone(), format!("m_{stem}")] {
                if let Some(path) = self.by_stem.get(&candidate) {
                    return Some(path);
                }
            }
            parts.pop();
        }
        None
    }

    /// The material paired with a mesh, by the mesh's own name.
    ///
    /// `mesh` is a normalised path; `named` is the file its `MTL_NAME` chunk
    /// names, if any, which beats any guess from the mesh's filename.
    pub fn by_mesh(&self, mesh: &str, named: Option<&str>) -> Option<String> {
        let (dir, stem) = split(mesh);
        let stems = self.by_dir.get(dir)?;
        let at = |s: &str| format!("{dir}/{s}.mtl");

        if let Some(named) = named {
            let lowered = named.replace('\\', "/").to_ascii_lowercase();
            let (_, own) = split(&lowered);
            if stems.iter().any(|s| s == own) {
                return Some(at(own));
            }
        }
        if stems.iter().any(|s| s == stem) {
            return Some(at(stem));
        }
        let mut parts: Vec<&str> = stem.split('_').collect();
        loop {
            let prefix = format!("{}_", parts.join("_"));
            if let Some(found) = stems.iter().find(|s| s.starts_with(&prefix)) {
                return Some(at(found));
            }
            if parts.len() <= 2 {
                return None;
            }
            parts.pop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index() -> MtlIndex {
        MtlIndex::build([
            "objects/characters/human/backpack/cds/cds_combat_light_backpack_02_02_01.mtl",
            "objects/characters/human/backpack/cds/cds_combat_light_backpack_01_04.mtl",
            "objects/characters/human/backpack/cds/cds_combat_light_backpack_01.mtl",
            "objects/characters/human/male_v7/armor/cds/m_cds_heavy_armor_01_02.mtl",
            "objects/characters/human/male_v7/armor/cds/m_cds_heavy_armor_01_01.mtl",
            "objects/characters/human/male_v7/armor/qrt/m_qrt_utility_heavy_core_02_01.mtl",
            "objects/spaceships/ships/cds_combat_light_backpack_02.mtl",
            "objects/fps_weapons/gadgets/crlf/medical_pen/gdgt_fps_crlf_medical_pen_mat.mtl",
        ])
    }

    #[test]
    fn a_class_name_matches_exactly_or_by_dropping_trailing_tokens() {
        let index = index();
        assert_eq!(
            index.by_class("cds_combat_light_backpack_02_02_01"),
            Some("objects/characters/human/backpack/cds/cds_combat_light_backpack_02_02_01.mtl"),
        );
        assert_eq!(
            index.by_class("cds_combat_light_backpack_01_04_01"),
            Some("objects/characters/human/backpack/cds/cds_combat_light_backpack_01_04.mtl"),
            "the most specific prefix wins, not the family's base",
        );
        assert_eq!(index.by_class("rsi_nothing_here_01"), None);
    }

    #[test]
    fn nothing_outside_the_characters_tree_is_a_candidate() {
        // A ship material sharing the stem would otherwise be a match.
        assert!(index().by_stem.values().all(|p| SCOPES.iter().any(|s| p.starts_with(s))));
    }

    #[test]
    fn a_mesh_pairs_by_suffix_then_by_dropping_tokens() {
        let index = index();
        assert_eq!(
            index.by_mesh("objects/characters/human/male_v7/armor/qrt/m_qrt_utility_heavy_core_02.skin", None),
            Some("objects/characters/human/male_v7/armor/qrt/m_qrt_utility_heavy_core_02_01.mtl".into()),
        );
        assert_eq!(
            index.by_mesh("objects/characters/human/male_v7/armor/cds/m_cds_heavy_armor_01_arms.skin", None),
            Some("objects/characters/human/male_v7/armor/cds/m_cds_heavy_armor_01_01.mtl".into()),
            "lowest suffix first",
        );
    }

    #[test]
    fn gear_pairs_by_what_its_mesh_names() {
        // A medpen's definition names no material; its mesh does.
        assert_eq!(
            index().by_mesh(
                "objects/fps_weapons/gadgets/crlf/medical_pen/gdgt_fps_crlf_medical_pen_parts.skin",
                Some("gdgt_fps_crlf_medical_pen_mat"),
            ),
            Some("objects/fps_weapons/gadgets/crlf/medical_pen/gdgt_fps_crlf_medical_pen_mat.mtl".into()),
        );
    }

    #[test]
    fn what_the_mesh_names_beats_its_filename() {
        let index = index();
        assert_eq!(
            index.by_mesh(
                "objects/characters/human/male_v7/armor/cds/m_cds_heavy_armor_01_arms.skin",
                Some("Objects\\Characters\\Human\\male_v7\\armor\\cds\\m_cds_heavy_armor_01_02"),
            ),
            Some("objects/characters/human/male_v7/armor/cds/m_cds_heavy_armor_01_02.mtl".into()),
        );
    }
}
