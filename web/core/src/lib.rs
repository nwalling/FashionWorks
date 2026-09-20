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
