//! Reading byte ranges out of a file the browser owns.
//!
//! The archive is 158 GB, so nothing here may ever hold more than a window of
//! it. Everything above this module asks for `(offset, length)` and gets bytes.
//!
//! **The reads are synchronous, and that is only possible in a worker.** The
//! browser's async `Blob.arrayBuffer()` cannot be awaited from inside a
//! WebAssembly call without unwinding the Rust stack, so the JS side uses
//! `FileReaderSync`, which exists *only* in workers. That single fact decides
//! the threading model in WEB.md: the archive lives in a dedicated worker and
//! the main thread never touches it.

use wasm_bindgen::prelude::*;

/// A synchronous byte-range reader implemented in JavaScript.
///
/// The JS side is expected to be, in a worker:
///
/// ```js
/// const sync = new FileReaderSync();
/// const readRange = (offset, length) =>
///   new Uint8Array(sync.readAsArrayBuffer(file.slice(offset, offset + length)));
/// ```
///
/// `file.slice()` does no I/O by itself; the read happens on demand and costs
/// only the bytes asked for.
pub struct RangeSource {
    read: js_sys::Function,
    len: u64,
}

impl RangeSource {
    pub fn new(read: js_sys::Function, len: u64) -> Self {
        Self { read, len }
    }

    /// Total size of the archive in bytes.
    pub fn len(&self) -> u64 {
        self.len
    }

    /// Fetch `[offset, offset + length)`, clamped to the end of the file.
    ///
    /// Returns fewer bytes than asked for only at the end of the file, which is
    /// what the EOCD search at the tail relies on.
    pub fn read(&self, offset: u64, length: usize) -> Result<Vec<u8>, JsValue> {
        if offset >= self.len {
            return Ok(Vec::new());
        }
        let available = (self.len - offset) as usize;
        let want = length.min(available);
        if want == 0 {
            return Ok(Vec::new());
        }
        let got = self.read.call2(
            &JsValue::NULL,
            &JsValue::from_f64(offset as f64),
            &JsValue::from_f64(want as f64),
        )?;
        let array = js_sys::Uint8Array::new(&got);
        if array.length() as usize != want {
            return Err(JsValue::from_str(&format!(
                "range read returned {} bytes, expected {want} at offset {offset}",
                array.length()
            )));
        }
        Ok(array.to_vec())
    }
}
