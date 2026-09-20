//! A P4K archive read over byte ranges instead of a file handle.
//!
//! Two things make this possible without re-deriving the format:
//!
//! 1. **The central directory is at the end.** ZIP64 puts an EOCD locator in the
//!    last 64 KB, which points at the directory. So indexing costs one tail read
//!    plus one directory read, not 158 GB.
//! 2. **`P4kArchive::read_from_data` works on any slice**, using
//!    `entry.offset` as an index into it. Rebase a copy of the entry to 0 and
//!    hand it a window fetched around that offset, and their local-header
//!    parse, AES decrypt and zstd/deflate paths run unchanged.
//!
//! What is *not* re-implemented here is central-directory entry parsing. CIG
//! put custom extra-field tags (0x5000, 0x5002 encryption, 0x5003) in a strict
//! order inside otherwise standard ZIP64 records, and `starbreaker_p4k`'s
//! `read_entry` already handles them. Copying those 80 lines into this crate
//! would fork format knowledge that is expensive to rediscover, so instead we
//! need one small addition upstream -- see `entries_from_reader` below.

use starbreaker_p4k::{P4kArchive, P4kEntry};
use std::io::{self, Read, Seek, SeekFrom};

use crate::range::RangeSource;

/// Largest local header + name + extra we expect to precede an entry's data.
/// The local header is 30 bytes and names run to a few hundred; 4 KB is a safe
/// window so a single range read covers header and payload together.
const LOCAL_HEADER_SLACK: usize = 4096;

/// Adapts the browser's range reader to the `Read + Seek` pair that
/// `starbreaker_p4k`'s directory parser wants.
///
/// Reads are synchronous because the JS side uses `FileReaderSync`; see
/// `range.rs` for why that confines all of this to a worker.
pub struct RangeReader {
    source: RangeSource,
    pos: u64,
}

impl RangeReader {
    pub fn new(source: RangeSource) -> Self {
        Self { source, pos: 0 }
    }

    pub fn source(&self) -> &RangeSource {
        &self.source
    }
}

impl Read for RangeReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let got = self
            .source
            .read(self.pos, buf.len())
            .map_err(|e| io::Error::other(format!("{e:?}")))?;
        buf[..got.len()].copy_from_slice(&got);
        self.pos += got.len() as u64;
        Ok(got.len())
    }
}

impl Seek for RangeReader {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let len = self.source.len();
        self.pos = match from {
            SeekFrom::Start(n) => n,
            SeekFrom::End(n) => len.saturating_add_signed(n),
            SeekFrom::Current(n) => self.pos.saturating_add_signed(n),
        };
        Ok(self.pos)
    }
}

/// One decompressed entry, plus where it came from.
pub struct Extracted {
    pub bytes: Vec<u8>,
}

/// Read and decompress one entry, fetching only the bytes it occupies.
///
/// `entry` comes from the index and carries an absolute `offset`; the window is
/// fetched around it and the offset rebased to 0 so the upstream reader lines
/// up with the slice it is given.
pub fn read_entry(source: &RangeSource, entry: &P4kEntry) -> Result<Extracted, String> {
    let window_len = entry.compressed_size as usize + LOCAL_HEADER_SLACK;
    let window = source
        .read(entry.offset, window_len)
        .map_err(|e| format!("range read failed: {e:?}"))?;

    let mut rebased = entry.clone();
    rebased.offset = 0;

    let bytes = P4kArchive::read_from_data(&window, &rebased)
        .map_err(|e| format!("{}: {e}", entry.name))?;
    Ok(Extracted { bytes })
}

/// Build the entry index from the archive's central directory.
///
/// Reads only the EOCD tail and the directory itself -- about 200 MB of range
/// reads against a 158 GB file -- via `entries_from_reader`, which exists
/// upstream as of `web/patches/0001-starbreaker-p4k-browser-support.patch`.
/// Entry parsing stays upstream because CIG's extra-field tags (0x5000, 0x5002
/// encryption, 0x5003) are handled there and should not be forked.
pub fn index(reader: &mut RangeReader) -> Result<Vec<P4kEntry>, String> {
    P4kArchive::entries_from_reader(reader).map_err(|e| format!("reading central directory: {e}"))
}
