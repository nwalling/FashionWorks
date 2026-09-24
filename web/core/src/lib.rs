//! The engine behind the FashionWorks web page.
//!
//! There is no server. The visitor points the page at their own `Data.p4k` and
//! everything -- indexing, extraction, decode -- happens in a worker on their
//! machine. This crate is the part that understands the archive; the TypeScript
//! package around it owns the worker protocol and the rendering.
//!
//! The whole design follows from one number: the archive is 158 GB. Nothing may
//! read it whole, so every entry point here is range-based.
//!
//! See `WEB.md` for the architecture and `WEB-INTEGRATION.md` for the contract
//! the Hangarworks site consumes.

pub mod armature;
pub mod audit;
pub mod blend;
pub mod catalog;
pub mod clips;
pub mod composite;
pub mod discover;
pub mod gear;
pub mod gold;
pub mod lighting;
pub mod material;
pub mod mesh;
mod p4k;
pub mod poses;
pub mod rebind;
pub mod socket;
mod range;

use wasm_bindgen::prelude::*;

pub use p4k::{read_entry, Extracted, RangeReader};
pub use range::RangeSource;

/// An opened archive: an entry index plus the reader it was built from.
///
/// Held by the archive worker for as long as the visitor's file handle is
/// alive. The index is a few tens of megabytes for 1.37 M entries and is worth
/// caching between visits; the archive bytes never are.
#[wasm_bindgen]
pub struct Archive {
    reader: RangeReader,
    entries: Vec<starbreaker_p4k::P4kEntry>,
    /// The canonical armature, once built. One per session.
    rig: Option<armature::Armature>,
    /// Normalised path to entry index, built on first lookup.
    ///
    /// **Not an optimisation, a fix.** Looking an asset up by scanning the
    /// entry list normalises both sides per comparison, which is two String
    /// allocations against each of 1,365,842 entries. One texture costs about
    /// eighteen lookups, because a split DDS gathers its mip streams from
    /// sibling entries, and a piece wants a dozen textures -- so a naive scan
    /// is tens of billions of allocations for one armour piece.
    by_path: std::cell::OnceCell<std::collections::HashMap<String, usize>>,
    /// Every character `.mtl`, by stem and by directory, for items that name
    /// no material of their own. Built on first use.
    mtls: std::cell::OnceCell<discover::MtlIndex>,
}

#[wasm_bindgen]
impl Archive {
    /// Open an archive over a synchronous JS range reader.
    ///
    /// `read_range(offset, length) -> Uint8Array` must be synchronous, which in
    /// practice means `FileReaderSync` inside a worker.
    #[wasm_bindgen(constructor)]
    pub fn new(read_range: js_sys::Function, byte_length: f64) -> Result<Archive, JsValue> {
        let source = RangeSource::new(read_range, byte_length as u64);
        let mut reader = RangeReader::new(source);
        let entries = p4k::index(&mut reader).map_err(|e| JsValue::from_str(&e))?;
        Ok(Archive {
            reader,
            entries,
            rig: None,
            by_path: std::cell::OnceCell::new(),
            mtls: std::cell::OnceCell::new(),
        })
    }

    /// Number of entries in the archive. The 4.10 build indexes 1,365,842.
    #[wasm_bindgen(js_name = entryCount)]
    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }

    /// Find an entry by exact path. Paths use backslashes, as the archive does.
    pub fn find(&self, path: &str) -> Option<usize> {
        self.entries.iter().position(|e| e.name == path)
    }

    /// Read and decompress one entry by index, fetching only its bytes.
    pub fn read(&self, index: usize) -> Result<Vec<u8>, JsValue> {
        let entry = self
            .entries
            .get(index)
            .ok_or_else(|| JsValue::from_str("entry index out of range"))?;
        p4k::read_entry(self.reader.source(), entry)
            .map(|e| e.bytes)
            .map_err(|e| JsValue::from_str(&e))
    }

    /// Uncompressed size of an entry, for progress reporting and cache budgets.
    #[wasm_bindgen(js_name = entrySize)]
    pub fn entry_size(&self, index: usize) -> Option<u64> {
        self.entries.get(index).map(|e| e.uncompressed_size)
    }

    /// A stable identifier for this game build.
    ///
    /// The catalogue is cached against it, so what it must do is change when a
    /// patch changes the archive and *not* change otherwise. The entry index
    /// answers that exactly: a patch rewrites entries, and copying the file to
    /// another drive does not.
    ///
    /// `lastModified` is deliberately not part of it. WEB.md suggested size
    /// plus `lastModified` plus a hash of the central directory, but the
    /// timestamp is a property of the copy rather than the build -- moving the
    /// archive, restoring it from a backup, or a launcher touching it would all
    /// throw the cache away and force a re-index for no reason. Size and the
    /// entry list are properties of the build itself.
    ///
    /// Free, because the index is already in memory: no extra range read.
    pub fn fingerprint(&self) -> String {
        // FNV-1a over name, size and offset of every entry. Not a security
        // hash; it identifies a build, and a collision would only mean a stale
        // catalogue, which the version check below still catches.
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        let mut feed = |bytes: &[u8]| {
            for &b in bytes {
                hash ^= u64::from(b);
                hash = hash.wrapping_mul(0x1000_0000_01b3);
            }
        };
        feed(&(self.entries.len() as u64).to_le_bytes());
        for entry in &self.entries {
            feed(entry.name.as_bytes());
            feed(&entry.uncompressed_size.to_le_bytes());
        }
        format!("{hash:016x}")
    }

    /// Whether an entry exists, by exact path. Paths use backslashes.
    #[wasm_bindgen(js_name = hasEntry)]
    pub fn has_entry(&self, path: &str) -> bool {
        self.find(path).is_some()
    }

    /// How many entries sit under a path prefix, matched case-insensitively.
    ///
    /// Validation uses this rather than one exact name: the DataCore spells the
    /// same directory both `Objects/...` and `objects/...`, and a
    /// case-sensitive check on this archive is how four items once failed
    /// conversion silently.
    #[wasm_bindgen(js_name = countUnder)]
    pub fn count_under(&self, prefix: &str) -> usize {
        let wanted = prefix.to_ascii_lowercase().replace('/', "\\");
        self.entries
            .iter()
            .filter(|e| e.name.to_ascii_lowercase().replace('/', "\\").starts_with(&wanted))
            .count()
    }
}

/// Parse a DataCore blob and report what it holds.
///
/// `Database::from_bytes` is zero-copy over the slice, so the only cost beyond
/// the DCB itself is the index it builds. This exists to prove the DataCore
/// crate runs under wasm at all -- WEB.md Phase 0 lists parsing `Game2.dcb` as
/// an exit criterion, and `starbreaker-datacore` pulls in `memmap2` and
/// `rayon`, neither of which was known to survive the wasm32 target.
#[wasm_bindgen(js_name = datacoreSummary)]
pub fn datacore_summary(bytes: &[u8]) -> Result<JsValue, JsValue> {
    let db = starbreaker_datacore::Database::from_bytes(bytes)
        .map_err(|e| JsValue::from_str(&format!("parsing DataCore: {e}")))?;
    let records = db.records();
    let out = js_sys::Object::new();
    js_sys::Reflect::set(&out, &"records".into(), &(records.len() as f64).into())?;
    js_sys::Reflect::set(&out, &"bytes".into(), &(bytes.len() as f64).into())?;
    Ok(out.into())
}

/// Decode one DDS to RGBA8, returning `[width, height, ...pixels]`.
///
/// Armour control maps are DXT1/BC4/BC5 and the layer library is DXT1, so this
/// is the path every texture takes. `bcdec_rs` is pure Rust, which is why this
/// was expected to port cleanly.
///
/// Takes a *complete* DDS. In the archive they rarely are -- see
/// [`Archive::decode_dds_entry`].
#[wasm_bindgen(js_name = decodeDds)]
pub fn decode_dds(bytes: &[u8], mip: usize) -> Result<js_sys::Array, JsValue> {
    let dds = starbreaker_dds::DdsFile::from_bytes(bytes)
        .map_err(|e| JsValue::from_str(&format!("reading DDS: {e}")))?;
    decoded_to_js(&dds, mip)
}

fn decoded_to_js(dds: &starbreaker_dds::DdsFile, mip: usize) -> Result<js_sys::Array, JsValue> {
    let (w, h) = dds.dimensions(mip);
    let rgba = dds
        .decode_rgba(mip)
        .map_err(|e| JsValue::from_str(&format!("decoding DDS mip {mip}: {e}")))?;
    let out = js_sys::Array::new();
    out.push(&(w as f64).into());
    out.push(&(h as f64).into());
    out.push(&js_sys::Uint8Array::from(&rgba[..]).into());
    Ok(out)
}

/// Pulls a DDS's `.1`, `.2`, ... mip streams out of the archive.
///
/// CIG splits every real texture: the named `.dds` carries headers and the
/// smallest mip, and the larger ones live in sibling entries. Decoding the base
/// file alone fails with "mip level 0 out of range", which is what happens if
/// you assume a DDS in this archive is a whole DDS. Upstream ships
/// `FsSiblingReader` for a directory on disk; the browser has no directory, so
/// siblings are resolved against the entry index instead.
struct ArchiveSiblings<'a> {
    archive: &'a Archive,
    base: String,
}

impl starbreaker_dds::ReadSibling for ArchiveSiblings<'_> {
    fn read_sibling(&self, suffix: &str) -> Option<Vec<u8>> {
        // Through the index, not a scan. A texture resolves about eighteen of
        // these -- one per mip stream -- and a piece wants a dozen textures, so
        // scanning 1.37 M entries each time is hundreds of millions of
        // comparisons for one armour piece.
        let name = format!("{}{}", self.base, suffix);
        let index = self.archive.find_asset(&name)?;
        let entry = self.archive.entries.get(index)?;
        p4k::read_entry(self.archive.reader.source(), entry)
            .ok()
            .map(|e| e.bytes)
    }
}

#[wasm_bindgen]
impl Archive {
    /// Decode a DDS entry, gathering its split mip streams from the archive.
    ///
    /// This is the call the renderer wants; [`decode_dds`] is only useful for a
    /// DDS that is already whole.
    #[wasm_bindgen(js_name = decodeDdsEntry)]
    pub fn decode_dds_entry(&self, index: usize, mip: usize) -> Result<js_sys::Array, JsValue> {
        let entry = self
            .entries
            .get(index)
            .ok_or_else(|| JsValue::from_str("entry index out of range"))?;
        let base = p4k::read_entry(self.reader.source(), entry)
            .map_err(|e| JsValue::from_str(&e))?;
        let siblings = ArchiveSiblings {
            archive: self,
            base: entry.name.clone(),
        };
        let dds = starbreaker_dds::DdsFile::from_split(&base.bytes, &siblings)
            .map_err(|e| JsValue::from_str(&format!("reading split DDS: {e}")))?;
        decoded_to_js(&dds, mip)
    }

    /// How many mip levels the entry resolves to once its siblings are joined.
    #[wasm_bindgen(js_name = ddsMipCount)]
    pub fn dds_mip_count(&self, index: usize) -> Result<usize, JsValue> {
        let entry = self
            .entries
            .get(index)
            .ok_or_else(|| JsValue::from_str("entry index out of range"))?;
        let base = p4k::read_entry(self.reader.source(), entry)
            .map_err(|e| JsValue::from_str(&e))?;
        let siblings = ArchiveSiblings {
            archive: self,
            base: entry.name.clone(),
        };
        let dds = starbreaker_dds::DdsFile::from_split(&base.bytes, &siblings)
            .map_err(|e| JsValue::from_str(&format!("reading split DDS: {e}")))?;
        Ok(dds.mip_count())
    }
}

#[wasm_bindgen]
impl Archive {
    /// A lighting probe as linear float RGBA: `[size, Float32Array]`, six
    /// faces of `size`² in DDS order. RENDERING.md Phase 1.
    #[wasm_bindgen(js_name = cubeHdr)]
    pub fn cube_hdr(&self, path: &str, max_size: u32) -> Result<js_sys::Array, JsValue> {
        let index = self
            .find_asset(path)
            .ok_or_else(|| JsValue::from_str(&format!("no probe at {path}")))?;
        let entry = &self.entries[index];
        let base = p4k::read_entry(self.reader.source(), entry).map_err(|e| JsValue::from_str(&e))?;
        let siblings = ArchiveSiblings { archive: self, base: entry.name.clone() };
        let dds = starbreaker_dds::DdsFile::from_split(&base.bytes, &siblings)
            .map_err(|e| JsValue::from_str(&format!("reading {path}: {e}")))?;
        let cube = lighting::hdr_cube(&dds, max_size).map_err(|e| JsValue::from_str(&format!("{path}: {e}")))?;
        let out = js_sys::Array::new();
        out.push(&(cube.size as f64).into());
        out.push(&js_sys::Float32Array::from(&cube.rgba[..]).into());
        Ok(out)
    }

    /// The lights of one group in an object container, as JSON. Positions and
    /// directions stay in the archive's Z-up frame; the renderer converts.
    #[wasm_bindgen(js_name = lightRig)]
    pub fn light_rig(&self, socpak: &str, group: &str) -> Result<String, JsValue> {
        let bytes = self.read_asset(socpak)?;
        let lights = lighting::light_rig(&bytes, group).map_err(|e| JsValue::from_str(&e))?;
        Ok(serde_json::Value::Array(lights.iter().map(lighting::RigLight::to_json).collect()).to_string())
    }
}

/// Build the whole armour catalogue from a DataCore and a localization file.
///
/// This is the browser's `scx catalog`, and it is the step that turns an opened
/// archive into something a visitor can look at. Both inputs come straight out
/// of the archive: `Data\Game2.dcb` and
/// `Data\Localization\english\global.ini`.
///
/// Returns JSON rather than a `JsValue` tree. The catalogue is 2,426 items and
/// building a JS object graph that size across the wasm boundary costs far more
/// than serialising once and letting the worker's `postMessage` move a string --
/// which it can transfer, where it would have to structurally clone the graph.
///
/// `skeleton` is "male" or "female". Female is WEB.md phase 6 and nothing has
/// been run through it; the argument exists because `select_wearables` takes it
/// and threading it now is free.
#[wasm_bindgen(js_name = buildCatalogue)]
pub fn build_catalogue(dcb: &[u8], ini: &str, skeleton: &str) -> Result<String, JsValue> {
    use catalog::{build, db, tint, Localization};

    let database = db::open(dcb).map_err(|e| JsValue::from_str(&format!("parsing DataCore: {e}")))?;
    let loc = Localization::parse(ini);
    let palettes = tint::PaletteIndex::build(&database);
    let makers = db::index_by_name(&database, "SCItemManufacturer");

    let records = db::armor_records(&database);
    let mut items: Vec<serde_json::Value> = records
        .iter()
        .filter_map(|r| build::build_item(&r.value, &palettes, &makers, &loc, skeleton, &r.source_path))
        // NPC-only records are in the DataCore and are not wearable, so they
        // never reach the listing.
        .filter(|i| {
            !i["flags"]
                .as_array()
                .map(|f| f.iter().any(|x| x == "npc"))
                .unwrap_or(false)
        })
        .collect();

    // Sorted before sets are assigned, because `assign_sets` keys on the order
    // it sees and the pipeline sorts here too. A catalogue built in a different
    // order is not the same catalogue.
    items.sort_by(|a, b| {
        let key = |v: &serde_json::Value| {
            (
                v["slot"].as_str().unwrap_or("").to_string(),
                v["name"].as_str().unwrap_or("").to_ascii_lowercase(),
                v["class_name"].as_str().unwrap_or("").to_string(),
            )
        };
        key(a).cmp(&key(b))
    });
    build::assign_sets(&mut items);
    build::link_variants(&mut items);
    let gear = build_gear(&database, &palettes, &makers, &loc);

    serde_json::to_string(&serde_json::json!({
        "skeleton": skeleton,
        "localization_keys": loc.len(),
        "palettes": palettes.len(),
        "items": items,
        "gear": gear,
    }))
    .map_err(|e| JsValue::from_str(&format!("serialising the catalogue: {e}")))
}

/// Every gear item, sorted and linked into colourway families. Body-agnostic:
/// a rifle is the same rifle whoever carries it.
pub fn build_gear(
    database: &starbreaker_datacore::Database,
    palettes: &catalog::PaletteIndex,
    makers: &std::collections::HashMap<String, serde_json::Value>,
    loc: &catalog::Localization,
) -> Vec<serde_json::Value> {
    let mut gear: Vec<serde_json::Value> = catalog::db::gear_records(database)
        .iter()
        .filter_map(|r| catalog::gear::build_gear_item(&r.value, palettes, makers, loc))
        .filter(|g| g["geometry"].as_array().is_some_and(|a| !a.is_empty()))
        .collect();
    gear.sort_by(|a, b| {
        let key = |v: &serde_json::Value| {
            (
                v["slot"].as_str().unwrap_or("").to_string(),
                v["name"].as_str().unwrap_or("").to_ascii_lowercase(),
                v["class_name"].as_str().unwrap_or("").to_string(),
            )
        };
        key(a).cmp(&key(b))
    });
    catalog::gear::link_gear_variants(&mut gear);
    gear
}

#[wasm_bindgen]
impl Archive {
    /// Load one armour mesh into buffers a renderer can bind.
    ///
    /// `path` is the catalogue's geometry path, e.g.
    /// `Objects/Characters/Human/male_v7/armor/cds/m_cds_light_helmet_01.skin`.
    /// Slashes and case are normalised, and the `.skinm` half is found and read
    /// alongside -- a caller that passes only what the catalogue gave it gets a
    /// complete mesh, rather than geometry with no skeleton.
    ///
    /// Returns an object of typed arrays. They are plain copies rather than
    /// views into wasm memory, because wasm memory moves when it grows and a
    /// view taken before a later allocation can silently point at the wrong
    /// bytes.
    #[wasm_bindgen(js_name = loadMesh)]
    pub fn load_mesh(&self, path: &str) -> Result<JsValue, JsValue> {
        let skin_index = self
            .find_asset(path)
            .ok_or_else(|| JsValue::from_str(&format!("not in this archive: {path}")))?;
        let skin = p4k::read_entry(self.reader.source(), &self.entries[skin_index])
            .map_err(|e| JsValue::from_str(&e))?
            .bytes;

        // The vertex half sits beside the header half under the same name.
        let skinm = self
            .find_asset(&format!("{path}m"))
            .and_then(|i| p4k::read_entry(self.reader.source(), &self.entries[i]).ok())
            .map(|e| e.bytes)
            .unwrap_or_default();

        // Eight influences where the mesh uses them: RENDERING.md Phase 7. The
        // renderer takes the second four as a second pair of attributes.
        let mut loaded = mesh::load_wide(&skin, &skinm, mesh::WIDE_INFLUENCES).map_err(|e| JsValue::from_str(&e))?;

        // With a rig, the mesh's own joint indices are rewritten to address the
        // armature and stray weight is redistributed. Without one the piece's
        // own bone list is returned as-is, which is what the geometry check
        // wants and what a renderer cannot use.
        let report = self.rig.as_ref().map(|rig| {
            let width = loaded.influences;
            let report = armature::rebind_wide(
                rig,
                &loaded.bones,
                &loaded.bone_parents,
                &mut loaded.joints,
                &mut loaded.weights,
                width,
            );
            loaded.bones = rig.bones.iter().map(|b| b.name.clone()).collect();
            loaded.narrow_if_unused();
            report
        });
        let out = mesh_to_js(&loaded, report.as_ref())?;
        js_sys::Reflect::set(&out, &"overrides".into(), &overrides_to_js(&skin)?.into())?;
        Ok(out)
    }

    /// A material for an item whose record names none. See [`discover`].
    ///
    /// `class_name` is tried first, then the mesh: `mesh_material` is the file
    /// the mesh's own `MTL_NAME` chunk names, when the caller has it. `None`
    /// when nothing plausible exists, which is rare and honest -- Artimex Arms
    /// Wildwood has no material anywhere in the archive.
    #[wasm_bindgen(js_name = discoverMaterial)]
    pub fn discover_material(
        &self,
        class_name: &str,
        mesh_path: &str,
        mesh_material: Option<String>,
    ) -> Option<String> {
        let index = self.mtls.get_or_init(|| {
            let names: Vec<String> = self.entries.iter().map(|e| normalise_asset(&e.name)).collect();
            discover::MtlIndex::build(names.iter().map(String::as_str))
        });
        if let Some(found) = index.by_class(class_name) {
            return Some(found.to_string());
        }
        if mesh_path.is_empty() {
            return None;
        }
        index.by_mesh(&normalise_asset(mesh_path), mesh_material.as_deref())
    }

    /// An entry index for an asset path, however it is spelled.
    ///
    /// The DataCore spells the same directory both `Objects/...` and
    /// `objects/...`, and archive paths use backslashes. A case-sensitive
    /// lookup matches nothing and fails silently -- which is how four items
    /// once reached conversion with "no converted geometry" long after the
    /// extraction that reported success.
    fn find_asset(&self, path: &str) -> Option<usize> {
        let index = self.path_index();
        let wanted = normalise_asset(path);
        if let Some(found) = index.get(&wanted) {
            return Some(*found);
        }
        // **A material references the artist's source texture, and the archive
        // ships the built one.** Every layer in the detail library names a
        // `.tif`; what is actually in the P4K is a `.dds`. Looking up the path
        // as written finds nothing, silently, and the composite then runs with
        // no layer textures at all -- which renders as flat tinted plates that
        // look plausible and carry none of the surface detail.
        let swapped = swap_extension(&wanted, "dds")?;
        index.get(&swapped).copied()
    }

    /// The path index, built once.
    ///
    /// A `OnceCell` rather than `&mut self`, because every caller has only a
    /// shared borrow and the index is derived state: building it changes
    /// nothing an observer can see except how long the call took.
    fn path_index(&self) -> &std::collections::HashMap<String, usize> {
        self.by_path.get_or_init(|| {
            let mut map = std::collections::HashMap::with_capacity(self.entries.len());
            for (i, entry) in self.entries.iter().enumerate() {
                // First wins: the archive can name the same asset twice, and a
                // later duplicate must not displace the first.
                map.entry(normalise_asset(&entry.name)).or_insert(i);
            }
            map
        })
    }
}

/// The attachment points a piece declares for itself, from its own skeleton.
///
/// **An `_override` bone is the armour moving an attachment point**, which is
/// what the name says. The canonical armature takes its 35 from one undersuit
/// donor, and every torso then re-declares them where *its* shell puts them:
/// the ADP-mk4 core carries `backpack_attach_1_override` at y -0.233, ten
/// centimetres behind the donor's -0.130, and its rifle holsters wider and
/// higher. Hanging a Warden pack on the donor's point buried it in that shell.
///
/// Parent-relative, and the parent is named rather than indexed: the piece's
/// skeleton is its own 50-odd bones, not the armature's 255, so only a name
/// means the same thing on both sides.
fn overrides_to_js(skin: &[u8]) -> Result<js_sys::Array, JsValue> {
    let out = js_sys::Array::new();
    let Some(bones) = starbreaker_3d::skeleton::parse_skeleton(skin) else {
        return Ok(out);
    };
    for bone in &bones {
        if !bone.name.to_ascii_lowercase().ends_with(armature::ATTACHMENT_SUFFIX) {
            continue;
        }
        let parent = bone
            .parent_index
            .and_then(|p| bones.get(p as usize))
            .map(|p| p.name.clone());
        let entry = js_sys::Object::new();
        js_sys::Reflect::set(&entry, &"name".into(), &JsValue::from_str(&bone.name))?;
        js_sys::Reflect::set(
            &entry,
            &"parent".into(),
            &parent.map_or(JsValue::NULL, |p| JsValue::from_str(&p)),
        )?;
        js_sys::Reflect::set(
            &entry,
            &"position".into(),
            &js_sys::Float32Array::from(&bone.local_position[..]).into(),
        )?;
        js_sys::Reflect::set(
            &entry,
            &"rotation".into(),
            &js_sys::Float32Array::from(&bone.local_rotation[..]).into(),
        )?;
        js_sys::Reflect::set(
            &entry,
            &"world".into(),
            &js_sys::Float32Array::from(&bone.world_position[..]).into(),
        )?;
        out.push(&entry);
    }
    Ok(out)
}

/// Replace a path's final extension. `None` when it has none.
fn swap_extension(path: &str, extension: &str) -> Option<String> {
    let dot = path.rfind('.')?;
    // Only the last component, so a directory with a dot in it is left alone.
    if path[dot..].contains('/') {
        return None;
    }
    Some(format!("{}.{extension}", &path[..dot]))
}

/// `Data\Objects\...` and `objects/...` compare equal.
fn normalise_asset(path: &str) -> String {
    let lowered = path.replace('\\', "/").to_ascii_lowercase();
    let trimmed = lowered.trim_start_matches('/');
    trimmed.strip_prefix("data/").unwrap_or(trimmed).to_string()
}

fn mesh_to_js(
    loaded: &mesh::LoadedMesh,
    report: Option<&armature::RebindReport>,
) -> Result<JsValue, JsValue> {
    let out = js_sys::Object::new();
    let set = |key: &str, value: &JsValue| js_sys::Reflect::set(&out, &key.into(), value);

    set("positions", &js_sys::Float32Array::from(&loaded.positions[..]).into())?;
    set("normals", &js_sys::Float32Array::from(&loaded.normals[..]).into())?;
    set("uvs", &js_sys::Float32Array::from(&loaded.uvs[..]).into())?;
    set("indices", &js_sys::Uint32Array::from(&loaded.indices[..]).into())?;
    if loaded.influences == mesh::WIDE_INFLUENCES {
        // Split eight-wide into two four-wide pairs: `joints`/`weights` the
        // heaviest four, `joints1`/`weights1` the rest, as the shader reads them.
        let vertices = loaded.vertex_count();
        let (mut j0, mut j1) = (Vec::with_capacity(vertices * 4), Vec::with_capacity(vertices * 4));
        let (mut w0, mut w1) = (Vec::with_capacity(vertices * 4), Vec::with_capacity(vertices * 4));
        for v in 0..vertices {
            j0.extend_from_slice(&loaded.joints[v * 8..v * 8 + 4]);
            j1.extend_from_slice(&loaded.joints[v * 8 + 4..v * 8 + 8]);
            w0.extend_from_slice(&loaded.weights[v * 8..v * 8 + 4]);
            w1.extend_from_slice(&loaded.weights[v * 8 + 4..v * 8 + 8]);
        }
        set("joints", &js_sys::Uint16Array::from(&j0[..]).into())?;
        set("weights", &js_sys::Float32Array::from(&w0[..]).into())?;
        set("joints1", &js_sys::Uint16Array::from(&j1[..]).into())?;
        set("weights1", &js_sys::Float32Array::from(&w1[..]).into())?;
    } else {
        set("joints", &js_sys::Uint16Array::from(&loaded.joints[..]).into())?;
        set("weights", &js_sys::Float32Array::from(&loaded.weights[..]).into())?;
    }

    if !loaded.decal_uvs.is_empty() {
        set("decalUvs", &js_sys::Float32Array::from(&loaded.decal_uvs[..]).into())?;
    }

    let bones = js_sys::Array::new();
    for name in &loaded.bones {
        bones.push(&JsValue::from_str(name));
    }
    set("bones", &bones.into())?;

    let submeshes = js_sys::Array::new();
    for sub in &loaded.submeshes {
        let entry = js_sys::Object::new();
        js_sys::Reflect::set(&entry, &"materialId".into(), &(sub.material_id as f64).into())?;
        js_sys::Reflect::set(&entry, &"start".into(), &(sub.first_index as f64).into())?;
        js_sys::Reflect::set(&entry, &"count".into(), &(sub.index_count as f64).into())?;
        submeshes.push(&entry);
    }
    set("submeshes", &submeshes.into())?;

    set(
        "materialFile",
        &loaded.material_file.as_deref().map_or(JsValue::NULL, JsValue::from_str),
    )?;
    set("min", &js_sys::Float32Array::from(&loaded.min[..]).into())?;
    set("max", &js_sys::Float32Array::from(&loaded.max[..]).into())?;
    set("unweighted", &(loaded.unweighted() as f64).into())?;

    if let Some(report) = report {
        let rebind = js_sys::Object::new();
        js_sys::Reflect::set(&rebind, &"mapped".into(), &(report.mapped as f64).into())?;
        js_sys::Reflect::set(&rebind, &"stray".into(), &(report.stray as f64).into())?;
        js_sys::Reflect::set(
            &rebind,
            &"redistributed".into(),
            &(report.redistributed as f64).into(),
        )?;
        js_sys::Reflect::set(&rebind, &"inherited".into(), &(report.inherited as f64).into())?;
        js_sys::Reflect::set(&rebind, &"guessed".into(), &(report.guessed as f64).into())?;
        set("rebind", &rebind.into())?;
    } else {
        set("rebind", &JsValue::NULL)?;
    }
    Ok(out.into())
}

#[wasm_bindgen]
impl Archive {
    /// Build the canonical armature: a base skeleton plus donors' attachment points.
    ///
    /// `donors` are `.skin` paths whose `*_override` bones are grafted on. The
    /// base skeleton has **none of its own**, which is why a backpack first
    /// rendered at the body origin, so at least one donor is needed before
    /// anything can hang off a socket.
    ///
    /// The armature is kept on the archive because that is its real lifetime:
    /// one per session, built once, used by every piece loaded afterwards.
    #[wasm_bindgen(js_name = buildRig)]
    pub fn build_rig(&mut self, base: &str, donors: Vec<String>) -> Result<JsValue, JsValue> {
        let index = self
            .find_asset(base)
            .ok_or_else(|| JsValue::from_str(&format!("no skeleton at {base}")))?;
        let bytes = p4k::read_entry(self.reader.source(), &self.entries[index])
            .map_err(|e| JsValue::from_str(&e))?
            .bytes;
        let mut armature = armature::Armature::from_chr(&bytes)
            .ok_or_else(|| JsValue::from_str("no CompiledBones in that skeleton"))?;

        let base_bones = armature.len();
        let mut grafted = 0usize;
        for donor in &donors {
            let Some(index) = self.find_asset(donor) else { continue };
            let Ok(entry) = p4k::read_entry(self.reader.source(), &self.entries[index]) else {
                continue;
            };
            if let Some(bones) = starbreaker_3d::skeleton::parse_skeleton(&entry.bytes) {
                grafted += armature.graft(&bones);
            }
        }

        let out = js_sys::Object::new();
        js_sys::Reflect::set(&out, &"bones".into(), &(armature.len() as f64).into())?;
        js_sys::Reflect::set(&out, &"base".into(), &(base_bones as f64).into())?;
        js_sys::Reflect::set(&out, &"grafted".into(), &(grafted as f64).into())?;
        js_sys::Reflect::set(&out, &"attachments".into(), &(armature.attachments() as f64).into())?;
        self.rig = Some(armature);
        Ok(out.into())
    }

    /// The armature's bones, in order, as the renderer needs to build them.
    #[wasm_bindgen(js_name = rigBones)]
    pub fn rig_bones(&self) -> Result<JsValue, JsValue> {
        let rig = self
            .rig
            .as_ref()
            .ok_or_else(|| JsValue::from_str("no rig; call buildRig first"))?;
        let out = js_sys::Array::new();
        for bone in &rig.bones {
            let entry = js_sys::Object::new();
            js_sys::Reflect::set(&entry, &"name".into(), &JsValue::from_str(&bone.name))?;
            js_sys::Reflect::set(
                &entry,
                &"parent".into(),
                &bone.parent.map_or(JsValue::from_f64(-1.0), |p| JsValue::from_f64(p as f64)),
            )?;
            js_sys::Reflect::set(
                &entry,
                &"position".into(),
                &js_sys::Float32Array::from(&bone.local_position[..]).into(),
            )?;
            js_sys::Reflect::set(
                &entry,
                &"rotation".into(),
                &js_sys::Float32Array::from(&bone.local_rotation[..]).into(),
            )?;
            js_sys::Reflect::set(
                &entry,
                &"world".into(),
                &js_sys::Float32Array::from(&bone.world_position[..]).into(),
            )?;
            js_sys::Reflect::set(&entry, &"attachment".into(), &bone.attachment.into())?;
            out.push(&entry);
        }
        Ok(out.into())
    }
}

#[wasm_bindgen]
impl Archive {
    /// Load an armour `.mtl` and every detail-library layer it references.
    ///
    /// One call rather than one per layer: a submaterial names up to eight
    /// layers, a piece has eight submaterials, and each layer is its own small
    /// `.mtl` in the archive. Resolving them here keeps that to a single trip
    /// across the wasm boundary and lets the library be deduplicated -- the 495
    /// layer materials are shared across the whole catalogue, so a piece
    /// typically resolves a few dozen distinct ones.
    #[wasm_bindgen(js_name = loadMaterial)]
    pub fn load_material(&self, path: &str) -> Result<JsValue, JsValue> {
        let index = self
            .find_asset(path)
            .ok_or_else(|| JsValue::from_str(&format!("no material at {path}")))?;
        let bytes = p4k::read_entry(self.reader.source(), &self.entries[index])
            .map_err(|e| JsValue::from_str(&e))?
            .bytes;
        let subs = material::parse(&bytes).map_err(|e| JsValue::from_str(&e))?;

        // Every distinct layer the piece references, resolved once.
        let mut library: std::collections::HashMap<String, material::LayerMaterial> =
            std::collections::HashMap::new();
        for sub in &subs {
            for layer in sub.base_layers.iter().chain(sub.wear_layers.iter()) {
                let key = layer.path.to_ascii_lowercase();
                if library.contains_key(&key) {
                    continue;
                }
                let Some(index) = self.find_asset(&layer.path) else { continue };
                let Ok(entry) = p4k::read_entry(self.reader.source(), &self.entries[index]) else {
                    continue;
                };
                if let Some(resolved) = material::parse_layer(&layer.path, &entry.bytes) {
                    library.insert(key, resolved);
                }
            }
        }

        let out = js_sys::Object::new();
        let submaterials = js_sys::Array::new();
        for sub in &subs {
            let entry = js_sys::Object::new();
            js_sys::Reflect::set(&entry, &"name".into(), &JsValue::from_str(&sub.name))?;
            js_sys::Reflect::set(&entry, &"shader".into(), &JsValue::from_str(&sub.shader))?;
            js_sys::Reflect::set(&entry, &"tintable".into(), &sub.tintable().into())?;
            for (key, value) in [
                ("diffuse", &sub.diffuse),
                ("specular", &sub.specular),
                ("emissive", &sub.emissive),
            ] {
                js_sys::Reflect::set(&entry, &key.into(), &js_sys::Float32Array::from(&value[..]).into())?;
            }
            js_sys::Reflect::set(&entry, &"glow".into(), &sub.glow.into())?;
            js_sys::Reflect::set(&entry, &"opacity".into(), &sub.opacity.into())?;
            js_sys::Reflect::set(&entry, &"alphaTest".into(), &sub.alpha_test.into())?;
            js_sys::Reflect::set(&entry, &"shininess".into(), &sub.shininess.into())?;
            let params = js_sys::Object::new();
            for (name, values) in &sub.params {
                let value: JsValue = if values.len() == 1 {
                    values[0].into()
                } else {
                    js_sys::Float32Array::from(&values[..]).into()
                };
                js_sys::Reflect::set(&params, &name.as_str().into(), &value)?;
            }
            js_sys::Reflect::set(&entry, &"params".into(), &params.into())?;
            js_sys::Reflect::set(
                &entry,
                &"decalSheet".into(),
                &sub.decal_sheet.as_deref().map_or(JsValue::NULL, JsValue::from_str),
            )?;

            let textures = js_sys::Object::new();
            for (role, texture) in &sub.textures {
                js_sys::Reflect::set(&textures, &role.as_str().into(), &JsValue::from_str(texture))?;
            }
            js_sys::Reflect::set(&entry, &"textures".into(), &textures.into())?;

            let pairs = sub.wear_pairs();
            let layers = js_sys::Array::new();
            for (i, layer) in sub.base_layers.iter().enumerate() {
                let value = layer_to_js(layer)?;
                let worn = pairs
                    .get(i)
                    .copied()
                    .flatten()
                    .map(layer_to_js)
                    .transpose()?;
                js_sys::Reflect::set(&value, &"worn".into(), &worn.map_or(JsValue::NULL, Into::into))?;
                layers.push(&value);
            }
            js_sys::Reflect::set(&entry, &"layers".into(), &layers.into())?;
            submaterials.push(&entry);
        }
        js_sys::Reflect::set(&out, &"submaterials".into(), &submaterials.into())?;

        let lib = js_sys::Object::new();
        for (key, resolved) in &library {
            let value = js_sys::Object::new();
            js_sys::Reflect::set(&value, &"path".into(), &JsValue::from_str(&resolved.path))?;
            js_sys::Reflect::set(
                &value,
                &"diffuse".into(),
                &js_sys::Float32Array::from(&resolved.diffuse[..]).into(),
            )?;
            js_sys::Reflect::set(
                &value,
                &"specular".into(),
                &js_sys::Float32Array::from(&resolved.specular[..]).into(),
            )?;
            js_sys::Reflect::set(&value, &"shininess".into(), &resolved.shininess.into())?;
            js_sys::Reflect::set(&value, &"metal".into(), &resolved.metal.into())?;
            js_sys::Reflect::set(
                &value,
                &"diffuseTex".into(),
                &resolved.diffuse_tex.as_deref().map_or(JsValue::NULL, JsValue::from_str),
            )?;
            js_sys::Reflect::set(
                &value,
                &"normalTex".into(),
                &resolved.normal_tex.as_deref().map_or(JsValue::NULL, JsValue::from_str),
            )?;
            js_sys::Reflect::set(&value, &"tileU".into(), &resolved.tile_u.into())?;
            js_sys::Reflect::set(&lib, &key.as_str().into(), &value.into())?;
        }
        js_sys::Reflect::set(&out, &"library".into(), &lib.into())?;
        Ok(out.into())
    }

    /// Decode one texture to RGBA, gathering its split mip streams.
    ///
    /// **A `.dds` in this archive is not a whole DDS.** Every real texture is
    /// split: the named entry holds headers and the smallest mip, and the
    /// larger ones live in sibling entries. Decoding the base file alone fails
    /// with "mip level 0 out of range".
    ///
    /// `mip` counts from 0, the largest. Passing a higher number is how the
    /// 512-pixel layer cap is met without decoding a 2048 first.
    #[wasm_bindgen(js_name = loadTexture)]
    pub fn load_texture(&self, path: &str, mip: usize) -> Result<js_sys::Array, JsValue> {
        let index = self
            .find_asset(path)
            .ok_or_else(|| JsValue::from_str(&format!("no texture at {path}")))?;
        self.decode_dds_entry(index, mip)
    }

    /// A texture's mip sizes, without decoding any of them.
    ///
    /// Returns `[w0, h0, w1, h1, ...]`. Picking a mip by decoding candidates
    /// and measuring them costs a full BC decode per try, and mip 0 of a
    /// control map is routinely 2048x2048 -- which made choosing a 512 cost
    /// more than using the 2048 would have. Dimensions come out of the header.
    /// A texture with its gloss: RGBA8 at `mip`, the alpha channel taken from
    /// the `.dds.Na` smoothness stream where the texture ships one.
    ///
    /// A `_ddna` decodes to its normal with a constant alpha; the per-pixel
    /// gloss is a separate BC4 stream that the RGBA decode never reads. The
    /// live LayerBlend shader wants both from one fetch. RENDERING.md Phase 3.
    #[wasm_bindgen(js_name = loadTextureAlpha)]
    pub fn load_texture_alpha(&self, path: &str, mip: usize) -> Result<js_sys::Array, JsValue> {
        let dds = self.split_dds(path)?;
        let (w, h) = dds.dimensions(mip);
        let mut rgba = dds
            .decode_rgba(mip)
            .map_err(|e| JsValue::from_str(&format!("decoding {path} mip {mip}: {e}")))?;
        if dds.has_alpha_mips() {
            if let Ok(alpha) = dds.decode_alpha_mip(mip) {
                if alpha.len() * 4 == rgba.len() {
                    for (i, a) in alpha.iter().enumerate() {
                        rgba[i * 4 + 3] = *a;
                    }
                }
            }
        }
        let out = js_sys::Array::new();
        out.push(&(w as f64).into());
        out.push(&(h as f64).into());
        out.push(&js_sys::Uint8Array::from(&rgba[..]).into());
        Ok(out)
    }

    /// A BC1 texture as its raw blocks: `[width, height, ...mips]` from the
    /// largest mip no wider than `max_size` down to 4x4, for a GPU that takes
    /// S3TC directly -- a 512 layer is 171 KB like that against 1.4 MB decoded.
    /// Anything that is not BC1 is an error; the caller decodes instead.
    #[wasm_bindgen(js_name = textureBlocks)]
    pub fn texture_blocks(&self, path: &str, max_size: u32) -> Result<js_sys::Array, JsValue> {
        let dds = self.split_dds(path)?;
        let format = starbreaker_dds::resolve_format(&dds.header.pixel_format, dds.dxt10_header.as_ref())
            .map_err(|e| JsValue::from_str(&format!("{path}: {e}")))?;
        if !matches!(format, starbreaker_dds::DxgiFormat::BC1Unorm | starbreaker_dds::DxgiFormat::BC1UnormSrgb) {
            return Err(JsValue::from_str(&format!("{path} is {format:?}, not BC1")));
        }
        let mut first = 0;
        while first + 1 < dds.mip_count() && dds.dimensions(first).0 > max_size {
            first += 1;
        }
        let (w, h) = dds.dimensions(first);
        let out = js_sys::Array::new();
        out.push(&(w as f64).into());
        out.push(&(h as f64).into());
        for mip in first..dds.mip_count() {
            let (mw, mh) = dds.dimensions(mip);
            if mw < 4 || mh < 4 {
                break;
            }
            let expected = (mw as usize).div_ceil(4) * (mh as usize).div_ceil(4) * 8;
            let data = &dds.mip_data[mip];
            if data.len() < expected {
                break;
            }
            out.push(&js_sys::Uint8Array::from(&data[..expected]).into());
        }
        Ok(out)
    }

    /// An entry's DDS with its split mips joined.
    fn split_dds(&self, path: &str) -> Result<starbreaker_dds::DdsFile, JsValue> {
        let index = self
            .find_asset(path)
            .ok_or_else(|| JsValue::from_str(&format!("no texture at {path}")))?;
        let entry = &self.entries[index];
        let base = p4k::read_entry(self.reader.source(), entry).map_err(|e| JsValue::from_str(&e))?;
        let siblings = ArchiveSiblings { archive: self, base: entry.name.clone() };
        starbreaker_dds::DdsFile::from_split(&base.bytes, &siblings)
            .map_err(|e| JsValue::from_str(&format!("reading split DDS {path}: {e}")))
    }

    #[wasm_bindgen(js_name = textureSizes)]
    pub fn texture_sizes(&self, path: &str) -> Result<Vec<u32>, JsValue> {
        let index = self
            .find_asset(path)
            .ok_or_else(|| JsValue::from_str(&format!("no texture at {path}")))?;
        let entry = self
            .entries
            .get(index)
            .ok_or_else(|| JsValue::from_str("entry index out of range"))?;
        let base = p4k::read_entry(self.reader.source(), entry)
            .map_err(|e| JsValue::from_str(&e))?;
        let siblings = ArchiveSiblings { archive: self, base: entry.name.clone() };
        let dds = starbreaker_dds::DdsFile::from_split(&base.bytes, &siblings)
            .map_err(|e| JsValue::from_str(&format!("reading split DDS: {e}")))?;
        let mut out = Vec::new();
        for mip in 0..dds.mip_count() {
            let (w, h) = dds.dimensions(mip);
            out.push(w as u32);
            out.push(h as u32);
        }
        Ok(out)
    }
}

fn layer_to_js(layer: &material::LayerRef) -> Result<js_sys::Object, JsValue> {
    let out = js_sys::Object::new();
    js_sys::Reflect::set(&out, &"name".into(), &JsValue::from_str(&layer.name))?;
    js_sys::Reflect::set(&out, &"path".into(), &JsValue::from_str(&layer.path))?;
    js_sys::Reflect::set(
        &out,
        &"tintColor".into(),
        &js_sys::Float32Array::from(&layer.tint_color[..]).into(),
    )?;
    js_sys::Reflect::set(&out, &"paletteTint".into(), &(layer.palette_tint as f64).into())?;
    js_sys::Reflect::set(&out, &"glossMult".into(), &layer.gloss_mult.into())?;
    js_sys::Reflect::set(&out, &"uvTiling".into(), &layer.uv_tiling.into())?;
    Ok(out)
}

#[wasm_bindgen]
impl Archive {
    /// Load a rigid prop and work out where it mounts.
    ///
    /// Returns the mesh, plus `mount`: the prop's local matrix **relative to
    /// the socket bone**, row-major 3x4 in the archive's frame. A caller
    /// parents the mesh to that bone and applies it, which is what makes posing
    /// move the pack with the body for free.
    ///
    /// Bone-relative, deliberately. Returning the world placement instead and
    /// then parenting to the bone applies the bone twice, which floated a
    /// backpack a metre above the head -- correct grips, correct facing,
    /// nowhere near the body. `grips` below reports the world positions, which
    /// is what they are for.
    ///
    /// `null` mount means no locator was found. The prop still loads -- it will
    /// simply sit at the bone's origin, which is wrong but visible, rather than
    /// vanishing.
    #[wasm_bindgen(js_name = loadProp)]
    pub fn load_prop(&self, path: &str, socket: &str) -> Result<JsValue, JsValue> {
        let cga_index = self
            .find_asset(path)
            .ok_or_else(|| JsValue::from_str(&format!("not in this archive: {path}")))?;
        let cga = p4k::read_entry(self.reader.source(), &self.entries[cga_index])
            .map_err(|e| JsValue::from_str(&e))?
            .bytes;
        // The vertex half, as with `.skin`/`.skinm`.
        let cgam = self
            .find_asset(&format!("{path}m"))
            .and_then(|i| p4k::read_entry(self.reader.source(), &self.entries[i]).ok())
            .map(|e| e.bytes)
            .unwrap_or_default();

        let mut loaded = mesh::load(&cga, &cgam).map_err(|e| JsValue::from_str(&e))?;
        let prop = socket::Prop::parse(&cga);
        if let Some(prop) = &prop {
            gear::place_nodes(&mut loaded, &prop.nodes);
        }
        let out = mesh_to_js(&loaded, None)?;

        let bone = self
            .rig
            .as_ref()
            .and_then(|rig| rig.index_of(socket).map(|i| &rig.bones[i]))
            .map(|b| socket::from_quat(b.world_rotation, b.world_position));

        let locator = prop
            .as_ref()
            .and_then(|prop| socket::mount_for(&prop.nodes, socket))
            .map(|node| node.bone_to_world);
        let mount = locator.as_ref().map(socket::mount);
        // Where things land, for reporting: this one *does* compose the bone.
        let placed = match (&bone, &locator) {
            (Some(bone), Some(locator)) => Some(socket::place(bone, locator)),
            _ => None,
        };

        let object: js_sys::Object = out.clone().into();
        js_sys::Reflect::set(
            &object,
            &"mount".into(),
            &match mount {
                Some(m) => {
                    let flat: Vec<f32> = m.iter().flatten().copied().collect();
                    js_sys::Float32Array::from(&flat[..]).into()
                }
                None => JsValue::NULL,
            },
        )?;

        // The grips, so a caller can check left really is left. A pack's
        // extents look the same whichever way round it is mounted.
        let grips = js_sys::Object::new();
        if let (Some(prop), Some(m)) = (&prop, &placed) {
            for side in ["left", "right"] {
                if let Some(node) = prop.grip(side) {
                    let at = socket::apply(
                        m,
                        [
                            node.bone_to_world[0][3],
                            node.bone_to_world[1][3],
                            node.bone_to_world[2][3],
                        ],
                    );
                    js_sys::Reflect::set(
                        &grips,
                        &side.into(),
                        &js_sys::Float32Array::from(&at[..]).into(),
                    )?;
                }
            }
        }
        js_sys::Reflect::set(&object, &"grips".into(), &grips.into())?;

        let helpers = js_sys::Array::new();
        // And where each one is, in the prop's own space: a backpack carries
        // its own `wep_stocked_attach_2/3_override` and `gadget_attach_1_override`
        // nodes, which is where a pack-wearer's rifles hang.
        let transforms = js_sys::Object::new();
        if let Some(prop) = &prop {
            for node in prop.helpers() {
                helpers.push(&JsValue::from_str(&node.name));
                let values: Vec<f32> = node.bone_to_world.iter().flatten().copied().collect();
                js_sys::Reflect::set(
                    &transforms,
                    &node.name.as_str().into(),
                    &js_sys::Float32Array::from(&values[..]).into(),
                )?;
            }
        }
        js_sys::Reflect::set(&object, &"helpers".into(), &helpers.into())?;
        js_sys::Reflect::set(&object, &"helperTransforms".into(), &transforms.into())?;
        Ok(object.into())
    }
}

#[wasm_bindgen]
impl Archive {
    /// Load a gear item -- a weapon, knife, pen, grenade, magazine -- and work
    /// out where it mounts. See [`gear`].
    ///
    /// `path` is the item's root geometry: a `.cdf` for most weapons, a plain
    /// `.cgf` for knives and magazines. `locator` is the helper on the *item*
    /// that the port names as its side of the mount (`attach_offset_left_01`);
    /// empty for a held item, which sits on the hand bone by its own origin.
    ///
    /// Returns `parts` (each a mesh in the item's own space, with the `.mtl`
    /// the definition names for it), `helpers` (every locator by name, row-major
    /// 3x4 in the archive frame) and `mount` (the item's local matrix when
    /// parented to the port's bone, or null).
    #[wasm_bindgen(js_name = loadGear)]
    pub fn load_gear(&self, path: &str, locator: &str) -> Result<JsValue, JsValue> {
        let bytes = self.read_asset(path)?;
        let mut parts: Vec<gear::Part> = Vec::new();
        let helpers = if path.to_ascii_lowercase().ends_with(".cdf") {
            let cdf = gear::parse_cdf(&bytes).map_err(|e| JsValue::from_str(&e))?;
            // The model is usually a `.chr` -- helpers only -- but some weapons
            // name a `.cga` there, a rigid mesh that *is* the weapon, with its
            // helpers as NMC nodes. The Arlington's definition lists nothing
            // else but an unbound round, so skipping the model drew no rifle.
            let model = cdf.model.as_deref().and_then(|m| self.read_asset(m).ok().map(|b| (m, b)));
            let mut helpers = gear::Helpers::new();
            if let Some((path, model_bytes)) = &model {
                if path.to_ascii_lowercase().ends_with(".chr") {
                    helpers = gear::chr_helpers(model_bytes);
                } else {
                    helpers = gear::nmc_helpers(model_bytes);
                    if let Ok(mesh) = self.load_raw_mesh(path) {
                        parts.push(gear::Part {
                            name: "model".into(),
                            mesh,
                            material: cdf.material.clone().map(with_mtl),
                        });
                    }
                }
            }
            for attachment in cdf.attachments.iter().filter(|a| a.renderable()) {
                let Ok(mut mesh) = self.load_raw_mesh(&attachment.binding) else { continue };
                if attachment.kind == "CA_BONE" {
                    let bone = attachment
                        .bone
                        .as_deref()
                        .and_then(|b| gear::helper(&helpers, b))
                        .copied()
                        .unwrap_or(socket::IDENTITY);
                    let rel = socket::from_quat(attachment.rel_rotation, attachment.rel_position);
                    gear::transform_mesh(&mut mesh, &socket::multiply(&bone, &rel));
                }
                parts.push(gear::Part {
                    name: attachment.name.clone(),
                    mesh,
                    material: attachment.material.clone().or_else(|| cdf.material.clone()).map(with_mtl),
                });
            }
            helpers
        } else {
            let mesh = self.load_raw_mesh(path).map_err(|e| JsValue::from_str(&e))?;
            parts.push(gear::Part { name: String::new(), mesh, material: None });
            gear::nmc_helpers(&bytes)
        };

        let out = js_sys::Object::new();
        let list = js_sys::Array::new();
        for part in &parts {
            let entry = js_sys::Object::new();
            js_sys::Reflect::set(&entry, &"name".into(), &JsValue::from_str(&part.name))?;
            js_sys::Reflect::set(
                &entry,
                &"material".into(),
                &part.material.as_deref().map_or(JsValue::NULL, JsValue::from_str),
            )?;
            js_sys::Reflect::set(&entry, &"mesh".into(), &mesh_to_js(&part.mesh, None)?)?;
            list.push(&entry);
        }
        js_sys::Reflect::set(&out, &"parts".into(), &list.into())?;

        let flat = |m: &socket::Transform| -> JsValue {
            let values: Vec<f32> = m.iter().flatten().copied().collect();
            js_sys::Float32Array::from(&values[..]).into()
        };
        let named = js_sys::Object::new();
        for (name, m) in &helpers {
            js_sys::Reflect::set(&named, &name.as_str().into(), &flat(m))?;
        }
        js_sys::Reflect::set(&out, &"helpers".into(), &named.into())?;
        let mount = if locator.is_empty() { None } else { gear::mount(&helpers, locator) };
        js_sys::Reflect::set(&out, &"mount".into(), &mount.as_ref().map_or(JsValue::NULL, flat))?;
        Ok(out.into())
    }

    /// An asset's bytes, however its path is spelled.
    fn read_asset(&self, path: &str) -> Result<Vec<u8>, JsValue> {
        let index = self
            .find_asset(path)
            .ok_or_else(|| JsValue::from_str(&format!("not in this archive: {path}")))?;
        Ok(p4k::read_entry(self.reader.source(), &self.entries[index])
            .map_err(|e| JsValue::from_str(&e))?
            .bytes)
    }

    /// A mesh and its vertex half (`.skinm`, `.cgfm`, `.cgam`), unrigged, with
    /// a rigid mesh's node-space groups put where their nodes say.
    fn load_raw_mesh(&self, path: &str) -> Result<mesh::LoadedMesh, String> {
        let index = self.find_asset(path).ok_or_else(|| format!("not in this archive: {path}"))?;
        let head = p4k::read_entry(self.reader.source(), &self.entries[index])?.bytes;
        let body = self
            .find_asset(&format!("{path}m"))
            .and_then(|i| p4k::read_entry(self.reader.source(), &self.entries[i]).ok())
            .map(|e| e.bytes)
            .unwrap_or_default();
        let mut loaded = mesh::load(&head, &body)?;
        if !path.to_ascii_lowercase().ends_with(".skin") {
            if let Some(prop) = socket::Prop::parse(&head) {
                gear::place_nodes(&mut loaded, &prop.nodes);
            }
        }
        Ok(loaded)
    }
}

/// A material path as the definitions write it -- sometimes with `.mtl`,
/// sometimes without -- as the archive names the file.
fn with_mtl(path: String) -> String {
    if path.to_ascii_lowercase().ends_with(".mtl") {
        path
    } else {
        format!("{path}.mtl")
    }
}

#[wasm_bindgen]
impl Archive {
    /// List the clips in an animation database.
    #[wasm_bindgen(js_name = listClips)]
    pub fn list_clips(&self, path: &str) -> Result<js_sys::Array, JsValue> {
        let index = self
            .find_asset(path)
            .ok_or_else(|| JsValue::from_str(&format!("no animation at {path}")))?;
        let bytes = p4k::read_entry(self.reader.source(), &self.entries[index])
            .map_err(|e| JsValue::from_str(&e))?
            .bytes;
        let db = starbreaker_3d::animation::parse_dba(&bytes)
            .map_err(|e| JsValue::from_str(&format!("parsing .dba: {e}")))?;
        let out = js_sys::Array::new();
        for clip in &db.clips {
            out.push(&JsValue::from_str(&clip.name));
        }
        Ok(out)
    }

    /// Every frame of one clip, for a looping player. RENDERING.md Phase 5.
    ///
    /// `{ fps, frames, bones, rotations }`: the rig bones the clip animates,
    /// without the root -- which carries the clip's own
    /// placement, and in a turn-in-place is the whole turn -- and their local
    /// rotations as `frames x bones x [w, x, y, z]` in the archive's frame,
    /// the same frame `retargetPose`'s `locals` use, so one conversion serves
    /// both. A `.caf` holds one clip and `clip` may be empty; in a `.dba` it
    /// matches as `retargetPose` matches.
    #[wasm_bindgen(js_name = sampleClip)]
    pub fn sample_clip(&self, path: &str, clip_name: &str) -> Result<JsValue, JsValue> {
        use starbreaker_3d::animation::{bone_name_hash, parse_caf, parse_dba};

        let rig = self
            .rig
            .as_ref()
            .ok_or_else(|| JsValue::from_str("no rig; call buildRig first"))?;
        let index = self
            .find_asset(path)
            .ok_or_else(|| JsValue::from_str(&format!("no animation at {path}")))?;
        let bytes = p4k::read_entry(self.reader.source(), &self.entries[index])
            .map_err(|e| JsValue::from_str(&e))?
            .bytes;
        let db = if path.to_ascii_lowercase().ends_with(".caf") {
            parse_caf(&bytes).map_err(|e| JsValue::from_str(&format!("parsing .caf: {e}")))?
        } else {
            parse_dba(&bytes).map_err(|e| JsValue::from_str(&format!("parsing .dba: {e}")))?
        };
        let needle = clip_name.to_ascii_lowercase();
        let clip = db
            .clips
            .iter()
            .find(|c| needle.is_empty() || c.name.to_ascii_lowercase().contains(&needle))
            .ok_or_else(|| JsValue::from_str(&format!("no clip matching {clip_name}")))?;

        let wanted: std::collections::HashMap<u32, usize> = rig
            .bones
            .iter()
            .enumerate()
            .filter(|(_, bone)| bone.parent.is_some())
            .map(|(i, bone)| (bone_name_hash(&bone.name), i))
            .collect();
        let sampled = clips::sample(clip, |c| wanted.contains_key(&c.bone_hash))
            .ok_or_else(|| JsValue::from_str(&format!("{clip_name}: no keyframes")))?;

        let bones = js_sys::Array::new();
        for hash in &sampled.bones {
            bones.push(&JsValue::from_str(&rig.bones[wanted[hash]].name));
        }
        let out = js_sys::Object::new();
        js_sys::Reflect::set(&out, &"fps".into(), &sampled.fps.into())?;
        js_sys::Reflect::set(&out, &"frames".into(), &(sampled.frames as u32).into())?;
        js_sys::Reflect::set(&out, &"bones".into(), &bones.into())?;
        js_sys::Reflect::set(
            &out,
            &"rotations".into(),
            &js_sys::Float32Array::from(&sampled.rotations[..]).into(),
        )?;
        Ok(out.into())
    }

    /// Retarget one animation clip onto the canonical armature.
    ///
    /// Returns a rotation **delta** per bone in the archive's own frame, as
    /// `[w, x, y, z]`, to be applied on top of the bone's rest orientation.
    ///
    /// The archive's frame, not glTF's, because a rotation delta is
    /// basis-dependent -- `d' = B d B⁻¹` -- and the caller's skeleton decides
    /// which `B`. The pipeline's is a 180-degree rotation about X, because that
    /// is where Blender's export lands; the web rig's is -90, because it
    /// converts Z-up to Y-up directly. Handing out the pipeline's conversion
    /// folded the character up: head below the hips, feet in the air.
    ///
    /// A delta, not an absolute orientation, and that is the whole design.
    /// Three approaches were tried in the pipeline and two fail:
    ///
    /// * *Copy the clip's local rotations.* The clip stores absolute local
    ///   rotations in the **animation rig's** bone frames, which ours no longer
    ///   match after conversion. The character ends up on its back, and no axis
    ///   permutation fixes it -- seven were tried.
    /// * *Copy world orientations.* Spine and legs land; the arms point at the
    ///   ceiling. Absolute orientation only transfers where the two rigs' bone
    ///   axes agree, and for arms they do not.
    /// * *Transfer each bone's delta from its own bind pose.* This works,
    ///   because "rotate this bone by however far the animation moves it" needs
    ///   no agreement about axes at all. Bone lengths stay ours, so the pose
    ///   adapts to our proportions.
    ///
    /// Bones the clip does not animate come back as identity, which is what
    /// lets a clip touching 145 of 255 leave the rest alone rather than
    /// resetting them.
    #[wasm_bindgen(js_name = retargetPose)]
    pub fn retarget_pose(&self, path: &str, clip_name: &str) -> Result<JsValue, JsValue> {
        use starbreaker_3d::animation::{bone_name_hash, clip_final_pose, parse_dba};

        let rig = self
            .rig
            .as_ref()
            .ok_or_else(|| JsValue::from_str("no rig; call buildRig first"))?;

        let index = self
            .find_asset(path)
            .ok_or_else(|| JsValue::from_str(&format!("no animation at {path}")))?;
        let bytes = p4k::read_entry(self.reader.source(), &self.entries[index])
            .map_err(|e| JsValue::from_str(&e))?
            .bytes;
        let db = parse_dba(&bytes).map_err(|e| JsValue::from_str(&format!("parsing .dba: {e}")))?;

        let needle = clip_name.to_ascii_lowercase();
        let clip = db
            .clips
            .iter()
            .find(|c| c.name.to_ascii_lowercase().contains(&needle))
            .ok_or_else(|| JsValue::from_str(&format!("no clip matching {clip_name}")))?;

        // Clip bones are keyed by CRC32 of their name; our armature has the
        // names, so hashing ours recovers the mapping.
        let sampled: std::collections::HashMap<u32, _> = clip_final_pose(clip).into_iter().collect();

        let bind: Vec<poses::BindBone> = rig
            .bones
            .iter()
            .map(|bone| poses::BindBone {
                name: bone.name.clone(),
                parent: bone.parent,
                local_rotation: bone.local_rotation,
                local_position: bone.local_position,
                world_rotation: bone.world_rotation,
            })
            .collect();

        // `forward_kinematics` takes an `Fn`, so the count goes in a Cell
        // rather than making the sampler stateful.
        let animated = std::cell::Cell::new(0usize);
        let posed = poses::forward_kinematics(&bind, |name| {
            let bone = sampled.get(&bone_name_hash(name))?;
            animated.set(animated.get() + 1);
            Some(poses::Sample {
                rotation: Some(bone.rotation),
                position: bone.position,
            })
        });
        let animated = animated.get();

        // The clip's own local rotations, per bone.
        //
        // **The pipeline cannot use these and this port can**, which is worth
        // being explicit about because `CLAUDE.md` records "copy the local
        // rotations" as a refuted approach. It is refuted *for the pipeline*:
        // its rig has been through Collada, Blender and the glTF exporter, so
        // its bone frames no longer match the ones the clip was authored
        // against, and the character ends up on its back.
        //
        // This rig is built straight from the same `.chr` the clip targets, so
        // the frames do match and a local rotation applies directly. The delta
        // is still returned alongside, for a consumer whose rig has been
        // through a conversion.
        let locals = js_sys::Array::new();
        for bone in &rig.bones {
            let entry = js_sys::Object::new();
            js_sys::Reflect::set(&entry, &"name".into(), &JsValue::from_str(&bone.name))?;
            match sampled.get(&bone_name_hash(&bone.name)) {
                Some(sample) => {
                    js_sys::Reflect::set(
                        &entry,
                        &"rotation".into(),
                        &js_sys::Float32Array::from(&sample.rotation[..]).into(),
                    )?;
                    js_sys::Reflect::set(
                        &entry,
                        &"position".into(),
                        &match sample.position {
                            Some(p) => js_sys::Float32Array::from(&p[..]).into(),
                            None => JsValue::NULL,
                        },
                    )?;
                }
                None => {
                    js_sys::Reflect::set(&entry, &"rotation".into(), &JsValue::NULL)?;
                    js_sys::Reflect::set(&entry, &"position".into(), &JsValue::NULL)?;
                }
            }
            locals.push(&entry);
        }

        let out = js_sys::Object::new();
        let deltas = js_sys::Array::new();
        // The armature **root is skipped**: it carries the clip's own world
        // placement, which otherwise drags the whole body a metre sideways.
        for (i, (name, pose)) in posed.iter().enumerate() {
            let entry = js_sys::Object::new();
            js_sys::Reflect::set(&entry, &"name".into(), &JsValue::from_str(name))?;
            js_sys::Reflect::set(&entry, &"root".into(), &(rig.bones[i].parent.is_none()).into())?;
            js_sys::Reflect::set(
                &entry,
                &"delta".into(),
                &js_sys::Float32Array::from(&pose.raw[..]).into(),
            )?;
            deltas.push(&entry);
        }
        js_sys::Reflect::set(&out, &"clip".into(), &JsValue::from_str(&clip.name))?;
        js_sys::Reflect::set(&out, &"bones".into(), &deltas.into())?;
        js_sys::Reflect::set(&out, &"locals".into(), &locals.into())?;
        js_sys::Reflect::set(&out, &"animated".into(), &(animated as f64).into())?;
        js_sys::Reflect::set(&out, &"clipBones".into(), &(sampled.len() as f64).into())?;
        Ok(out.into())
    }
}
