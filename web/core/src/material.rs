//! Resolving an armour `.mtl` and the detail library it references.
//!
//! Armour has **no albedo texture**. Its shader is `LayerBlend_V2`, and a
//! submaterial's appearance is up to four tiling detail materials composited
//! through a blend mask, each optionally worn through to a paired material,
//! with colour coming from the item's tint palette. So "load the material"
//! means reading one `.mtl`, then reading up to eight more per submaterial --
//! the layer library under `Materials/Layers` -- and reporting the whole stack.
//!
//! **`parse_mtl` wants binary CryXML, and the archive has it.** The pipeline's
//! `data/raw` copies are plain XML because extraction runs `--convert cryxml`,
//! and the parser rejects those with "invalid magic: expected CryXmlB". Read
//! straight from the archive the same file parses first time, so the browser's
//! path is *shorter* than the pipeline's, not longer.

use std::collections::HashMap;

use starbreaker_3d::mtl::{self, MtlFile};

/// `TexSlotN` to the role the compositor knows it by.
///
/// **Textures are addressed by number, not by role.** Filename-suffix guessing
/// alone misses all of them: the wear, blend and "hal" masks are slots 11, 12
/// and 13, and nothing in their names says so reliably.
pub fn slot_role(slot: &str) -> Option<&'static str> {
    Some(match slot.to_ascii_lowercase().as_str() {
        "texslot1" => "base_color",
        "texslot2" => "specular",
        "texslot3" => "normal",
        "texslot9" | "texslot7" => "decal",
        "texslot11" => "wear",
        "texslot12" => "blend",
        "texslot13" => "hal",
        _ => return None,
    })
}

/// Fallback when a material names no slot at all.
///
/// Matched against the **end of the stem**, not as a substring anywhere in the
/// path. A substring test reads `nothing_special.dds` as a specular map,
/// because `_special` contains `_spec`, and that is the sort of misread that
/// shows up much later as one surface wearing another's texture.
pub fn suffix_role(path: &str) -> Option<&'static str> {
    let lower = path.to_ascii_lowercase().replace('\\', "/");
    let file = lower.rsplit('/').next()?;
    // Everything from the first dot is extension, including CIG's `.dds.3`
    // mip-stream suffixes.
    let stem = file.split('.').next()?;
    // `_ddna` before `_ddn`: a normal *with* an alpha carries the per-pixel
    // gloss, and reading it as one without loses that silently.
    for (suffix, role) in [
        ("_ddna", "normal"),
        ("_ddn", "normal"),
        ("_diff", "base_color"),
        ("_spec", "specular"),
        ("_blend", "blend"),
        ("_wear", "wear"),
        ("_hal", "hal"),
    ] {
        if stem.ends_with(suffix) {
            return Some(role);
        }
    }
    None
}

/// Reflectance above which a detail layer is bare metal.
///
/// CryEngine's Layer shader states it: a metal carries `Specular` near its F0
/// with `Diffuse` at black, a dielectric sits near 0.04. Across the 495-entry
/// library the populations separate cleanly, the dielectric category topping
/// out at 0.156.
pub const METAL_F0_THRESHOLD: f32 = 0.2;

/// One entry of the detail library, resolved from its own `.mtl`.
#[derive(Debug, Clone, PartialEq)]
pub struct LayerMaterial {
    pub path: String,
    pub diffuse: [f32; 3],
    pub specular: [f32; 3],
    /// 0-1, the layer's own gloss before the armour's per-layer `GlossMult`.
    pub shininess: f32,
    pub metal: bool,
    /// Tiling diffuse (`TexSlot1`), where it has one.
    pub diffuse_tex: Option<String>,
    /// Tiling `_ddna` (`TexSlot2`), which carries the per-pixel gloss in its
    /// alpha.
    pub normal_tex: Option<String>,
    /// The layer's own `TexMod` tiling, multiplied into the reference's.
    pub tile_u: f32,
}

impl LayerMaterial {
    /// Whether this layer is bare metal.
    ///
    /// `PublicParams TintMode` is the artist stating it outright and wins where
    /// present: mode 2 is metal, mode 1 is not. **Mode 0 is not a statement**
    /// and falls through to reflectance -- reading it as "not tinted" forced
    /// 1185 armour layer references to white and baked twelve Venture
    /// undersuits flat.
    ///
    /// The fallback is CryEngine's own signature, and it is *not* the directory:
    /// keying on `Materials/Layers/metal` misses the whole `metallic/` category
    /// and promotes the 24% of `/metal/` that is dielectric by its own numbers.
    fn decide_metal(tint_mode: Option<u8>, diffuse: [f32; 3], specular: [f32; 3]) -> bool {
        match tint_mode {
            Some(2) => return true,
            Some(1) => return false,
            _ => {}
        }
        let spec_max = specular.iter().copied().fold(0.0f32, f32::max);
        let diff_max = diffuse.iter().copied().fold(0.0f32, f32::max);
        spec_max > METAL_F0_THRESHOLD || (diff_max < 0.02 && spec_max > 0.04)
    }
}

/// One layer reference on an armour submaterial.
#[derive(Debug, Clone, PartialEq)]
pub struct LayerRef {
    pub name: String,
    pub path: String,
    /// The layer's own colour, linear, from the armour `.mtl`.
    pub tint_color: [f32; 3],
    /// 0 means "the artist already chose this colour"; 1-3 index palette entry
    /// A, B or C. **87% of armour layers are 0**, which is why painting every
    /// layer with the palette was the original colour bug.
    pub palette_tint: u8,
    pub gloss_mult: f32,
    pub uv_tiling: f32,
    pub is_wear: bool,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct SubMaterial {
    pub name: String,
    pub shader: String,
    /// `blend`, `wear`, `hal`, `normal`, ... to the texture path.
    pub textures: HashMap<String, String>,
    pub base_layers: Vec<LayerRef>,
    pub wear_layers: Vec<LayerRef>,
    /// The submaterial's own constants. A LayerBlend surface takes its colour
    /// from its layers and ignores these; every other shader -- `Illum`,
    /// `MeshDecal`, glass, screens -- has nothing else. Dropping them is how a
    /// backpack's `Illum` strap rendered as the renderer's placeholder grey.
    pub diffuse: [f32; 3],
    pub specular: [f32; 3],
    pub emissive: [f32; 3],
    /// CryEngine's glow factor. On a LayerBlend surface it is a fraction of
    /// the composited albedo emitted -- which is what makes the ADP-mk4 Big
    /// Boss graffiti glow while the near-black plate around it stays dark.
    pub glow: f32,
    pub opacity: f32,
    pub alpha_test: f32,
    /// 0-1, from the archive's 0-255.
    pub shininess: f32,
    /// The numeric `PublicParams`, for shaders the compositor does not own.
    ///
    /// Hair is the case that needs them: `HairPBR` has no colour texture and
    /// no meaningful `Diffuse`, and takes its colour from `BaseMelanin`,
    /// `DyeColor` and their kin. LayerBlend keeps only its `Decal*` values --
    /// the rest of its block is about twenty template values per submaterial
    /// that nothing reads.
    pub params: Vec<(String, Vec<f32>)>,
    /// The decal sheet: `TexSlot9`, where the shader is compiled with
    /// `%DECALS`. Placed by the UV set the mesh packs into its vertex colour
    /// (`mesh::decal_uv`). None where the material has no decals.
    pub decal_sheet: Option<String>,
    /// How a `HairPBR` surface is drawn, from its shader flags: `cards` for
    /// strands (`%HAIR_CARDS`), `cap` for the shadow a hairline casts on the
    /// skin (`%HAIR_CAP`), `coat` for short hair laid over the scalp
    /// (`%HAIR_COAT`). None for anything else. Names cannot say it: a buzz
    /// cut's coat is `hair_02_shaved_opac`, and `_opac` read as cards drew it
    /// as a solid band across the forehead.
    pub hair: Option<&'static str>,
}

impl SubMaterial {
    pub fn tintable(&self) -> bool {
        self.shader.to_ascii_lowercase().contains("layerblend")
    }

    /// The wear layer paired with each base layer, by trailing slot number.
    ///
    /// `WearLayerN` is what `BaseLayerN` looks like worn through. An entry is
    /// `None` where the artist opted out by pointing the wear entry at the same
    /// material as the base -- **29% of all pairs**, 2744 of 9436 -- so the
    /// composite skips the blend rather than lerping a material with itself.
    pub fn wear_pairs(&self) -> Vec<Option<&LayerRef>> {
        self.base_layers
            .iter()
            .map(|base| {
                let slot = base.name.chars().last();
                self.wear_layers
                    .iter()
                    .find(|w| w.name.chars().last() == slot)
                    .filter(|w| !w.path.eq_ignore_ascii_case(&base.path))
            })
            .collect()
    }
}

fn layer_ref(layer: &mtl::MatLayer) -> LayerRef {
    LayerRef {
        name: layer.name.clone(),
        path: layer.path.clone(),
        tint_color: layer.tint_color,
        palette_tint: layer.palette_tint,
        gloss_mult: layer.gloss_mult,
        uv_tiling: layer.uv_tiling,
        is_wear: layer.name.to_ascii_lowercase().starts_with("wear"),
    }
}

/// Parse an armour `.mtl` into its submaterials.
pub fn parse(bytes: &[u8]) -> Result<Vec<SubMaterial>, String> {
    let file: MtlFile = mtl::parse_mtl(bytes).map_err(|e| format!("parsing .mtl: {e}"))?;
    Ok(file
        .materials
        .iter()
        .map(|sub| {
            // Slot numbers mean different things to different shaders. On
            // LayerBlend, TexSlot2 is unused and TexSlot3 is the normal map; on
            // Illum and the decal shaders TexSlot2 carries the `_ddna` normal.
            // So only LayerBlend trusts the number first, and everything else
            // trusts the file name first -- which is what CIG's own suffixes
            // (`_diff`, `_ddna`, `_spec`) are for.
            let layered = sub.shader.to_ascii_lowercase().contains("layerblend");
            let skin = sub.shader.to_ascii_lowercase().contains("humanskin");
            let mut textures = HashMap::new();
            for binding in &sub.texture_slots {
                if binding.path.is_empty() {
                    continue;
                }
                let role = if skin && binding.slot.eq_ignore_ascii_case("TexSlot7") {
                    // Skin's slot 7 is its tone mask, whose green says where
                    // the texture shows and where the flat skin tone does --
                    // black exactly where head and body meet. Read as the
                    // decal slot it would be drawn as a sticker sheet.
                    Some("tone_mask")
                } else if layered {
                    slot_role(&binding.slot).or_else(|| suffix_role(&binding.path))
                } else {
                    suffix_role(&binding.path).or_else(|| slot_role(&binding.slot))
                };
                if let Some(role) = role {
                    textures.entry(role.to_string()).or_insert_with(|| binding.path.clone());
                }
            }
            let (wear_layers, base_layers): (Vec<_>, Vec<_>) =
                sub.layers.iter().map(layer_ref).partition(|l| l.is_wear);
            SubMaterial {
                name: sub.name.clone(),
                shader: sub.shader.clone(),
                textures,
                base_layers,
                wear_layers,
                diffuse: sub.diffuse,
                specular: sub.specular,
                emissive: sub.emissive,
                glow: sub.glow,
                opacity: sub.opacity,
                alpha_test: sub.alpha_test,
                shininess: (sub.shininess / 255.0).clamp(0.0, 1.0),
                // LayerBlend's block is ~20 template values nobody reads; its
                // decal constants are the exception.
                // LayerBlend's flag is `%DECALS`; StarBreaker's decoded
                // `has_decal` matches only `DECAL`, and misses every armour.
                decal_sheet: sub
                    .string_gen_mask
                    .split('%')
                    .any(|t| t.eq_ignore_ascii_case("DECALS") || t.eq_ignore_ascii_case("DECAL"))
                    .then(|| {
                        sub.texture_slots
                            .iter()
                            .find(|b| b.slot.eq_ignore_ascii_case("TexSlot9") && !b.path.is_empty())
                            .map(|b| b.path.clone())
                    })
                    .flatten(),
                hair: {
                    let flags: Vec<&str> = sub.string_gen_mask.split('%').collect();
                    let has = |f: &str| flags.iter().any(|t| t.eq_ignore_ascii_case(f));
                    if has("HAIR_CARDS") {
                        Some("cards")
                    } else if has("HAIR_CAP") {
                        Some("cap")
                    } else if has("HAIR_COAT") {
                        Some("coat")
                    } else {
                        None
                    }
                },
                params: if layered {
                    numeric_params(&sub.public_params)
                        .into_iter()
                        .filter(|(name, _)| name.to_ascii_lowercase().contains("decal"))
                        .collect()
                } else {
                    numeric_params(&sub.public_params)
                },
            }
        })
        .collect())
}

/// `PublicParams` whose values are numbers or comma-separated vectors.
fn numeric_params(params: &[mtl::PublicParam]) -> Vec<(String, Vec<f32>)> {
    params
        .iter()
        .filter_map(|p| {
            let values: Option<Vec<f32>> =
                p.value.split(',').map(|v| v.trim().parse::<f32>().ok()).collect();
            Some((p.name.clone(), values.filter(|v| !v.is_empty())?))
        })
        .collect()
}

/// Parse one detail-library `.mtl`.
pub fn parse_layer(path: &str, bytes: &[u8]) -> Option<LayerMaterial> {
    let file: MtlFile = mtl::parse_mtl(bytes).ok()?;
    let sub = file.materials.first()?;

    let tint_mode = sub
        .public_params
        .iter()
        .find(|p| p.name.eq_ignore_ascii_case("TintMode"))
        .and_then(|p| p.value.trim().parse::<f32>().ok())
        .map(|v| v as u8);

    let mut diffuse_tex = None;
    let mut normal_tex = None;
    for binding in &sub.texture_slots {
        if binding.path.is_empty() {
            continue;
        }
        match slot_role(&binding.slot) {
            Some("base_color") => diffuse_tex.get_or_insert_with(|| binding.path.clone()),
            Some("specular") | Some("normal") => {
                normal_tex.get_or_insert_with(|| binding.path.clone())
            }
            _ => continue,
        };
    }

    Some(LayerMaterial {
        path: path.to_string(),
        diffuse: sub.diffuse,
        specular: sub.specular,
        // The archive stores Shininess 0-255.
        shininess: (sub.shininess / 255.0).clamp(0.0, 1.0),
        metal: LayerMaterial::decide_metal(tint_mode, sub.diffuse, sub.specular),
        diffuse_tex,
        normal_tex,
        tile_u: tex_mod_tile_u(&sub.authored_textures),
    })
}

/// The layer diffuse's own `TexMod` tiling, or 1.
///
/// 87 of the 495 library layers carry one on `TexSlot1`, from 1.5 to 20, and
/// the pipeline multiplies it into the reference's `UVTiling`
/// (`tint.py`: `repeat = entry.uv_tiling * detail.tile_u`). The port used to
/// hard-code 1.0, so those layers' grain came out up to twenty times too
/// coarse -- invisible while the bake averaged it away, and wrong the moment
/// the detail is drawn at render time.
fn tex_mod_tile_u(textures: &[mtl::AuthoredTexture]) -> f32 {
    textures
        .iter()
        .filter(|t| t.slot.eq_ignore_ascii_case("TexSlot1"))
        .flat_map(|t| t.child_blocks.iter())
        .filter(|b| b.tag.eq_ignore_ascii_case("TexMod"))
        .flat_map(|b| b.attributes.iter())
        .find(|a| a.name.eq_ignore_ascii_case("TileU"))
        .and_then(|a| a.value.trim().parse::<f32>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_control_maps_are_numbered_slots_not_names() {
        // Filename-suffix guessing alone misses every one of these.
        assert_eq!(slot_role("TexSlot11"), Some("wear"));
        assert_eq!(slot_role("TexSlot12"), Some("blend"));
        assert_eq!(slot_role("texslot13"), Some("hal"));
        assert_eq!(slot_role("TexSlot3"), Some("normal"));
        assert_eq!(slot_role("TexSlot42"), None);
    }

    #[test]
    fn a_suffix_is_only_the_fallback() {
        assert_eq!(suffix_role("m_slaver_helmet_01_blend.dds"), Some("blend"));
        assert_eq!(suffix_role("paint_01_ddna.dds"), Some("normal"));
        // `_ddna` must win over `_ddn`, or a normal-with-alpha reads as one
        // without and its per-pixel gloss is lost.
        assert_eq!(suffix_role("x_ddna.dds"), Some("normal"));
        assert_eq!(suffix_role("nothing_special.dds"), None, "_special is not _spec");
        assert_eq!(suffix_role("Textures/armour/x_wear.dds.3"), Some("wear"), "mip streams");
        assert_eq!(suffix_role("Textures\\armour\\y_hal.dds"), Some("hal"), "backslashes");
    }

    #[test]
    fn tint_mode_wins_over_reflectance_where_it_is_stated() {
        // anodized_white_metal_01: specular 0.061, diffuse 1.0. The numbers say
        // dielectric and the artist says metal.
        assert!(LayerMaterial::decide_metal(Some(2), [1.0; 3], [0.061; 3]));
        // And mode 1 says not metal however high the reflectance reads.
        assert!(!LayerMaterial::decide_metal(Some(1), [0.0; 3], [0.9; 3]));
    }

    #[test]
    fn mode_zero_is_not_a_statement() {
        // It is absence of a claim, not a claim of the negative. Reading it as
        // "dielectric, untinted" forced 1185 layer references to white.
        assert!(LayerMaterial::decide_metal(Some(0), [0.013; 3], [0.84; 3]), "reflectance decides");
        assert!(!LayerMaterial::decide_metal(Some(0), [0.8; 3], [0.04; 3]));
    }

    #[test]
    fn a_black_diffuse_with_real_reflectance_is_metal() {
        // CryEngine's signature for bare metal, and it catches near-metals
        // sitting just under the threshold: weapon_bare_120 at 0.188.
        assert!(LayerMaterial::decide_metal(None, [0.013; 3], [0.188; 3]));
    }

    #[test]
    fn a_dielectric_stays_one() {
        assert!(!LayerMaterial::decide_metal(None, [0.5; 3], [0.04; 3]));
        assert!(!LayerMaterial::decide_metal(None, [0.9; 3], [0.156; 3]), "the category tops out here");
    }

    fn layer(name: &str, path: &str) -> LayerRef {
        LayerRef {
            name: name.into(),
            path: path.into(),
            tint_color: [1.0; 3],
            palette_tint: 0,
            gloss_mult: 1.0,
            uv_tiling: 1.0,
            is_wear: name.to_ascii_lowercase().starts_with("wear"),
        }
    }

    #[test]
    fn wear_pairs_match_on_the_slot_number() {
        let sub = SubMaterial {
            base_layers: vec![layer("BaseLayer1", "paint_01"), layer("BaseLayer2", "paint_02")],
            wear_layers: vec![layer("WearLayer2", "iron_polished"), layer("WearLayer1", "steel_dark")],
            ..SubMaterial::default()
        };
        let pairs = sub.wear_pairs();
        assert_eq!(pairs[0].map(|l| l.path.as_str()), Some("steel_dark"));
        assert_eq!(pairs[1].map(|l| l.path.as_str()), Some("iron_polished"));
    }

    #[test]
    fn a_wear_entry_pointing_at_its_own_base_means_no_wear() {
        // 29% of pairs do this. Lerping a material with itself is a no-op that
        // costs a second full layer evaluation per pixel.
        let sub = SubMaterial {
            base_layers: vec![layer("BaseLayer1", "paint_01")],
            wear_layers: vec![layer("WearLayer1", "PAINT_01")],
            ..SubMaterial::default()
        };
        assert!(sub.wear_pairs()[0].is_none(), "matched case-insensitively");
    }

    #[test]
    fn a_layer_takes_its_own_texmod_tiling() {
        let texture = |slot: &str, tile: &str| mtl::AuthoredTexture {
            slot: slot.into(),
            path: "textures/layers/x_diff.tif".into(),
            is_virtual: false,
            attributes: vec![],
            child_blocks: vec![mtl::AuthoredBlock {
                tag: "TexMod".into(),
                attributes: vec![mtl::AuthoredAttribute { name: "TileU".into(), value: tile.into() }],
                children: vec![],
            }],
        };
        assert_eq!(tex_mod_tile_u(&[texture("TexSlot1", "4")]), 4.0);
        assert_eq!(tex_mod_tile_u(&[texture("TexSlot2", "4")]), 1.0, "only the diffuse's");
        assert_eq!(tex_mod_tile_u(&[texture("TexSlot1", "0")]), 1.0, "a zero tiling is no tiling");
        assert_eq!(tex_mod_tile_u(&[]), 1.0);
    }

    #[test]
    fn only_layerblend_submaterials_composite() {
        let mut sub = SubMaterial { shader: "LayerBlend_V2".into(), ..SubMaterial::default() };
        assert!(sub.tintable());
        sub.shader = "Illum".into();
        assert!(!sub.tintable(), "the helmet light is not composited");
    }
}
