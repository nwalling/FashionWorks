# Phase 0 spike

`WEB.md` Phase 0 asks whether a browser can open the real 158 GB `Data.p4k` at
all. If the answer is no, the whole "bring your own P4K" design collapses and
the local-helper fallback is the plan instead. So this gets answered before
anything else is built.

The spike is in two halves because one of them cannot run on a Mac.

## Headless half — runs anywhere with Node (done)

```bash
./build.sh
node node-open-p4k.mjs "/Volumes/SC Data/Data.p4k"
```

Node's `fs.readSync` is a synchronous byte-range read, which is the same
contract `range.rs` expects from `FileReaderSync` in a worker. Same `.wasm`,
same range protocol, same archive — only the host differs.

**Measured on build 1.0.191.55227, a 147.59 GB archive:**

| | result | Phase 0 bar |
| --- | --- | --- |
| index | 1,365,842 entries in 8.3–13.8s | < 120s |
| range reads to index | **2 reads, 442.7 MB — 0.29% of the file** | — |
| `Game2.dcb` | 316.1 MB read in 1.2s, **116,921 records parsed in 0.1s** | parses |
| DDS | 2048×2048, 10 mips, decoded in 383ms | decodes |
| peak RSS | 1.45 GB worst observed | < 2 GB |
| wasm | 245 KB raw, **0.07 MB brotli** | ≤ 2 MB |

`global.ini` extracted through the wasm core is **byte-identical** (sha256) to
the same file extracted by the native StarBreaker CLI, so the range-based read
path is verified rather than merely plausible.

Two things this half settled that `WEB.md` had flagged as unknowns:

- **`memmap2` and `rayon` compile to `wasm32` as they stand.** The plan assumed
  both would need feature flags. They do not, at least on the code paths the
  browser build calls.
- **A `.dds` in this archive is not a whole DDS.** CIG splits every real texture:
  the named entry holds headers and the smallest mip, and the larger mips live
  in sibling entries (`.dds.1`, `.dds.2`, …). Decoding the base file alone fails
  with `mip level 0 out of range`. Upstream ships `FsSiblingReader` for a
  directory on disk; the browser has no directory, so `Archive::decode_dds_entry`
  resolves siblings against the entry index instead.

## Browser half — needs Windows and the game (not done)

Serve this folder and open it. It must be http, not `file://` — workers and
WebAssembly need an origin.

```bash
python3 -m http.server 8799      # or: py -m http.server 8799
```

Then drag `Data.p4k` onto the page from `…\StarCitizen\LIVE\`.

**Drag-and-drop is the case that matters.** Chromium's File System Access
blocklist covers `Program Files` and everything under it, so the modern picker
fails on a default install. Drag-and-drop and a plain `<input type=file>` are
not subject to that blocklist. If that turns out to be wrong, onboarding has to
change, which is why it is an exit criterion rather than an assumption.

Still to confirm, and only on a Windows machine with the game installed:

- [ ] Chrome, from a default `C:\Program Files\...` install, by drag-and-drop
- [ ] Chrome, same file, via the file input
- [ ] Firefox, both paths
- [ ] Peak memory under 2 GB in a real tab, where the limit is ~4 GB and the
      headless 1.45 GB figure leaves less headroom than it looks

Verified so far on macOS: the page loads, the worker starts, `FileReaderSync`
works, the wasm initialises, and a deliberately fake archive is rejected with
`end of central directory record not found` — so the whole chain is live and
only the real file and the two browsers remain.

## Files

| | |
| --- | --- |
| `build.sh` | builds the core and both sets of bindings |
| `node-open-p4k.mjs` | the headless half, with the exit criteria as assertions |
| `index.html` / `worker.js` | the browser half |
| `pkg/`, `pkg-web/` | generated, gitignored; `build.sh` makes them |

`pkg-web/` is self-contained, so the folder can be copied to the Windows box
without needing Rust there.
