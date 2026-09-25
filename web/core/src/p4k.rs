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

/// The first `want` bytes of an entry, inflating only as much of it as that
/// takes.
///
/// The head's DNA library is 76 MB inflated and 63 MB in the archive, and the
/// blend wants its first 22 MB (CHARACTER.md). zstd streams, so the payload is
/// fetched a megabyte at a time and decoding stops once there is enough. An
/// entry that is encrypted or not zstd falls back to a whole read.
pub fn read_entry_prefix(source: &RangeSource, entry: &P4kEntry, want: usize) -> Result<Vec<u8>, String> {
    if entry.is_encrypted || entry.compression_method != ZSTD {
        let mut bytes = read_entry(source, entry)?.bytes;
        bytes.truncate(want);
        return Ok(bytes);
    }
    let header = source
        .read(entry.offset, LOCAL_HEADER_LEN)
        .map_err(|e| format!("range read failed: {e:?}"))?;
    if header.len() < LOCAL_HEADER_LEN {
        return Err(format!("{}: truncated local header", entry.name));
    }
    let name_len = u64::from(u16::from_le_bytes([header[26], header[27]]));
    let extra_len = u64::from(u16::from_le_bytes([header[28], header[29]]));
    let start = entry.offset + LOCAL_HEADER_LEN as u64 + name_len + extra_len;
    let chunks = Chunked {
        source,
        pos: start,
        end: start + entry.compressed_size,
        buffer: Vec::new(),
        at: 0,
    };
    inflate_prefix(chunks, want).map_err(|e| format!("{}: {e}", entry.name))
}

const ZSTD: u16 = 100;
const LOCAL_HEADER_LEN: usize = 30;
const CHUNK: usize = 1 << 20;

/// The first `want` bytes of a zstd stream, or all of it if it is shorter.
pub fn inflate_prefix<R: Read>(compressed: R, want: usize) -> Result<Vec<u8>, String> {
    let mut decoder = ruzstd::decoding::StreamingDecoder::new(compressed).map_err(|e| e.to_string())?;
    let mut out = vec![0u8; want];
    let mut filled = 0;
    while filled < want {
        let got = decoder.read(&mut out[filled..]).map_err(|e| e.to_string())?;
        if got == 0 {
            break;
        }
        filled += got;
    }
    out.truncate(filled);
    Ok(out)
}

/// An entry's compressed bytes, fetched a chunk at a time as a decoder asks.
/// A decoder reads in small pieces, and one range request per piece would be
/// thousands of them.
struct Chunked<'a> {
    source: &'a RangeSource,
    pos: u64,
    end: u64,
    buffer: Vec<u8>,
    at: usize,
}

impl Read for Chunked<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.at == self.buffer.len() {
            if self.pos >= self.end {
                return Ok(0);
            }
            let len = CHUNK.min((self.end - self.pos) as usize);
            self.buffer = self
                .source
                .read(self.pos, len)
                .map_err(|e| io::Error::other(format!("{e:?}")))?;
            self.pos += self.buffer.len() as u64;
            self.at = 0;
            if self.buffer.is_empty() {
                return Ok(0);
            }
        }
        let n = buf.len().min(self.buffer.len() - self.at);
        buf[..n].copy_from_slice(&self.buffer[self.at..self.at + n]);
        self.at += n;
        Ok(n)
    }
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
