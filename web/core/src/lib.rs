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

mod p4k;
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
        Ok(Archive { reader, entries })
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
        let name = format!("{}{}", self.base, suffix);
        let entry = self.archive.entries.iter().find(|e| e.name == name)?;
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
