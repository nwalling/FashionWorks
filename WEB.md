# FashionWorks on Hangarworks — web front end plan

Plan only, written 2026-09-17. **Nothing here is implemented.** It covers a
public sub-page of <https://www.sc-hangarworks.org/> where anyone with Star
Citizen installed can browse and kitbash FPS armour, under three hard
requirements:

1. **Light on web traffic.** The Hangarworks FAQ already says the site cannot
   absorb a large hosting or bandwidth bill. This page must not change that.
2. **Easy onboarding.** Pointing at `Data.p4k` and every other setup step must
   work for someone who has never opened a terminal.
3. **Inherits the Hangarworks look.** It lives inside the site's layout and
   follows its theme, including theme switches.

## In short

- **The visitor's computer does all the work.** The site ships code, never game
  data. Each visitor points the page at their own `Data.p4k`; the browser reads
  only the byte ranges it needs, and nothing is uploaded. That single decision
  satisfies the traffic limit, sidesteps hosting CIG assets, and always matches
  the build the visitor has installed.
- **The pipeline moves into the browser.** StarBreaker's Rust crates compile to
  WebAssembly; the Blender and Python stages are ported; layer compositing moves
  to the GPU. The existing local pipeline stays as the reference implementation
  and generates the golden outputs the port is tested against.
- **Budget: about 2.5 MB for a first full session, roughly zero on return, and
  zero bytes of game data from the server, ever.**

## Where things stand today

Measured, not assumed:

| thing | today | why it matters |
| --- | --- | --- |
| Hangarworks | Next.js App Router on Vercel, prerendered pages, static chunks served `max-age=31536000, immutable` | the sub-page is a Next route; Vercel bills bandwidth and function use |
| `Data.p4k` | 158,473,977,856 bytes, 1,365,842 entries | never read whole; random access only |
| armour-relevant entries | 48,551 entries, 17.3 GB | a loadout touches a tiny fraction |
| `Data\Game2.dcb` (DataCore) | 316 MB uncompressed | parsed once per game build, then discarded |
| `english\global.ini` | 10 MB | names, once per build |
| extracted output (`data/out`) | 471 GLBs averaging 7.3 MB; 21 GB texture cache | this is what must **not** be hosted |
| viewer JS bundle | 1.2 MB raw, **272 KB brotli** | the app itself is already small |
| `viewer/dist` | **105 GB** | Vite copies the `public/assets` symlink into the build — never deploy this output |

## The decision: bring your own P4K, processed in the browser

| option | verdict |
| --- | --- |
| **Visitor's browser reads their own `Data.p4k`** | **chosen** — server ships code only |
| Host the pre-built GLBs and textures | rejected: gigabytes per active user, and it distributes CIG geometry and textures, which `CLAUDE.md` gates on a fan-content review |
| Server-side extraction | rejected: needs the 158 GB archive on the server and pays compute per visitor |
| Local helper app + hosted UI | contingency only: users would install Blender, .NET and Python, and Chrome now prompts for local-network access — the opposite of easy onboarding |
| Separate app in an iframe | rejected: a cross-origin iframe cannot read the site's theme tokens, and it loads a second copy of the page chrome |

## What has to be built

None of today's tools run in a browser. Each stage has a web equivalent:

| stage today | in the browser |
| --- | --- |
| StarBreaker `p4k`, `datacore`, `dds` crates (Rust CLI) | the same crates compiled to WebAssembly. Feasible as they stand: zstd is pure-Rust `ruzstd`, AES is pure Rust, BC texture decoding is `bcdec_rs`. Two things need a feature flag: `memmap2` (use byte slices) and `rayon` (single-threaded per worker, see threads below). Drop `exr` and `gltf-json`, which the web build does not need. |
| cgf-converter `.skin` → Collada | not needed. `starbreaker-3d` already parses `.skin` streams directly: positions, UVs, QTangents, bone maps. |
| Blender normalise: canonical armature, stray-weight redistribution, material slots by name, socket placement, auto-smooth | ported to Rust in the WebAssembly core. Several steps simplify: `binding.ts` already remaps bones by name at runtime, so no export-time joint reordering is required. |
| Python layer compositing into 1024² PNG bakes (about 30 min, 21 GB cache) | **a LayerBlend shader on the GPU**, composited live per pixel. No bake step, instant recolour, and user tints become a uniform. |
| `scx poses` via `tools/anim-dump` | `starbreaker-3d` animation parsing, same WebAssembly core |
| `catalog.py` | ported; runs once per game build and is cached |

**The expensive part is not the port, it is the knowledge.** The verified facts in
`CLAUDE.md` — the geometry tree trap, record-type collisions, slot matching by
name, per-vertex stray weights, the 180° socket yaw, `TintMode`, metal-texture
normalisation, and a blend table that took four attempts — each cost real
debugging. Carry them over by test, not by memory:

- **Golden outputs.** The Python pipeline dumps, for a fixed item list covering
  Bokto, Sunchaser, Corbel, Beacon, Venture and Deadhead: catalogue records, set
  keys, bone lists, bounding boxes, and per-submaterial mean albedo. The web
  port must match within tolerance.
- **The audit invariants** (`sc_extract/audit.py`) are ported to run against the
  web port's output as well.
- **The reference comparisons are re-run**, not trusted: Sunchaser torso 36.0%
  and upper back 33.0% gold against CIG's store renders; Corbel Halcyon against
  its in-game capture.

Two GPU constraints to design for from the start:

- **Texture units.** A LayerBlend submaterial samples up to 8 layers × (diffuse
  + `_ddna`) plus blend, wear, hal and normal: 20 textures. WebGL2 only
  guarantees 16 per fragment shader. Pack the layer library into
  `DataArrayTexture`s by resolution, which brings it down to about six
  samplers. WebGPU lifts the limit but stays an enhancement, not a requirement.
- **VRAM.** Cap layer textures at 512² on the web, and keep the byte-budget
  eviction idea from `three/gltfCache.ts`.

## Traffic budget

These are limits, enforced in CI, not aspirations.

| what | budget | how |
| --- | --- | --- |
| landing and onboarding page | **≤ 60 KB** transferred beyond what the site already caches | prerendered; reuses the site's CSS, fonts and icons; loads no app code |
| app JavaScript | **≤ 400 KB brotli** | today's viewer is 272 KB; loaded only after "Get started" |
| WebAssembly core | **≤ 2 MB brotli** | measured in the spike; strip unused crates and features |
| first full session | **≤ 2.5 MB** total | the three lines above |
| return visit | **≈ 0** | content-hashed filenames with `immutable` caching (as the site already does) plus a service-worker precache |
| game data from the server | **0 bytes, ever** | CI fails the build if any `.p4k`, `.dcb`, `.dds`, `.glb`, `.skin` or bake PNG, or any file over 5 MB, lands in the output |

Things that cost money on Vercel and must stay off this route:

- **No server compute.** No API routes, no server actions, no ISR revalidation,
  and exclude the route from any middleware matcher.
- **No `next/image` optimisation.** Use SVG or `unoptimized` images.
- **No hosted environment maps.** Use three.js `RoomEnvironment`, which is
  procedural and costs 0 bytes. The vendored-HDR idea in `LIGHTING.md` applies to
  the local build.
- **No bundled backdrops.** `data/out/backgrounds` is local and gitignored;
  visitors pick their own image from disk, which the viewer already supports.
- **Share links in the URL fragment** (`#…`), not the query string. A fragment
  never reaches the server, so every shared loadout is served from one cached
  HTML file. `loadout.ts` currently reads `location.search`; change it.
- **No analytics beyond what the site already runs.**

Rough scale: 10,000 visitors a month, 30% of whom complete onboarding, is about
7,000 × 60 KB + 3,000 × 2.5 MB ≈ **8 GB a month**, most of it one-off per
visitor. Set a Vercel usage alert or spend cap anyway.

If traffic ever grows enough to matter, move the WebAssembly file and large
immutable chunks to a zero-egress origin (a Cloudflare R2 public bucket, or
jsDelivr from a GitHub release). That adds an origin and CORS headers, so only do
it when the numbers say so.

## Onboarding

Designed around three facts about the platform, each verified or measured:

1. **Star Citizen installs to `C:\Program Files\Roberts Space Industries\StarCitizen\LIVE\`
   by default, and Chrome's File System Access pickers refuse everything under
   Program Files.** Chromium's blocklist lists `DIR_PROGRAM_FILES`,
   `DIR_PROGRAM_FILESX86` and `DIR_PROGRAM_FILES6432` with `kBlockAllChildren`
   (`chrome/browser/file_system_access/chrome_file_system_access_permission_context.cc`).
   So `showOpenFilePicker()` **fails on the default install**. A plain
   `<input type="file">` and drag-and-drop are not subject to that list and work
   for any path, in every desktop browser.
2. **Choosing a 158 GB file does not upload or load it.** `File.slice()` reads
   byte ranges on demand. Visitors will assume an upload, so say so before they
   are asked to pick anything.
3. **A web page cannot open a folder on the visitor's disk or pre-fill a path.**
   The best it can do is hand them the path to paste.

### First visit

**0. Landing** (inside the Hangarworks layout)
- What it is, one screenshot rendered from the tool itself, and the promise:
  *"Runs entirely on your PC. Your game files are never uploaded."*
- Requirements: Star Citizen installed; a desktop browser (Chrome or Edge
  recommended, Firefox supported); a few GB of free disk space.
- The site's existing "not affiliated with or endorsed by Cloud Imperium Games"
  wording.
- One button: **Get started**. Nothing heavy loads before it is pressed.

**1. Check your computer** (automatic, about a second)
- WebGL2 and WebAssembly are required. Everything else only warns.
- Report free storage via `navigator.storage.estimate()` and request
  `navigator.storage.persist()` so the browser does not evict the cache.
- Phones and tablets get a friendly "desktop only" explanation instead of a
  broken experience.
- Show green ticks. Block only on the two hard requirements, and say how to fix
  each.

**2. Point to `Data.p4k`**
- **A large drop zone: "Drag Data.p4k here."** This is the primary path because
  it works everywhere, for any install location.
- **"Help me find it":** a channel picker (LIVE, PTU, EPTU, TECH-PREVIEW) that
  shows the default path with a **Copy** button. *"Paste this into the File
  Explorer address bar, then drag `Data.p4k` onto this page."*
- **Choose file** fallback (`<input type="file" accept=".p4k">`), with the tip
  that the path can be pasted into the dialog's *File name* box.
- **"Installed somewhere else?"** → the RSI Launcher's settings show the library
  folder.
- Reassurance under the drop zone: *"Your browser reads only the parts it needs.
  Nothing is uploaded, which is why a 158 GB file opens instantly."*

**3. Validate** (seconds)
- Read the archive's end records to confirm it is a P4K, then confirm
  `Data\Game2.dcb` and the English `global.ini` are present.
- Fingerprint the build from file size, `lastModified` and a hash of the central
  directory. Show a version string where the archive exposes one; the spike
  determines whether it does.
- Plain-language failures, each with a next step and a Discord link: *not a Star
  Citizen archive*, *incomplete or still downloading*, *this game build isn't
  supported yet*.

**4. First-time indexing** (once per game build)
- Staged progress with an ETA: reading archive index → reading item database →
  item names → skeleton and poses.
- Runs in workers; the page stays responsive, a mannequin appears as soon as the
  skeleton is ready, and cancelling keeps partial work.
- Target: **under two minutes on a mid-range PC.** Natively the catalogue takes
  about 17 seconds; the spike measures WebAssembly.

**5. Ready**
- Open the viewer on a complete starter set, with three dismissible tips: pick a
  slot, try a colourway swatch, "equip full set".

### Return visits

- **The catalogue loads from cache instantly**, and pieces already viewed render
  without the P4K at all.
- **Chrome or Edge, installed outside Program Files:** a persistent file handle
  stored in IndexedDB, so reconnecting is one *Allow* click.
- **Default install, or Firefox:** a slim banner, *"Drop Data.p4k again to load
  new pieces"*, shown only when a piece that is not cached yet is requested.
- **Game updated** (fingerprint changed): *"Star Citizen was updated. Rebuild the
  catalogue (about N min)?"* The old cache stays usable until the visitor
  chooses.

### Settings
- Body: male or female skeleton.
- Cache: size cap (default 2 GB), current usage, **Clear cache**.
- Game channel label, for visitors who switch between LIVE and PTU.

**No installs, ever:** no Blender, no .NET, no Python, no command line. The local
pipeline in this repo remains the developer and reference tool.

## Look and feel: inherit Hangarworks

Measured from the live site, not the August redesign mockup:

| aspect | live Hangarworks |
| --- | --- |
| framework | Next.js App Router on Vercel |
| theme switch | `<html data-theme="hangarworks">`, persisted as `localStorage.sc_theme`; alternates `dolomite`, `keystone`, `navy` (some are paid) |
| colour tokens | `--sc-dark #0a1219`, `--sc-card #16292f`, `--sc-surface`, `--sc-surface-2` / `--sc-field #1e3a44`, `--sc-border #2c4e5d`, `--sc-text #eaf2f6`, `--sc-subtle #9fb6c2`, `--sc-accent #ff8a34`, `--sc-badge #5ad1e6`, plus `-rgb`, `-soft`, `-line` and `-ink` variants |
| type | Chakra Petch display face (`--font-display`), system UI body, `ui-monospace` for data |
| icons | Tabler Icons webfont, already loaded by the site |
| layout | header with logo, nav, *Sign in* and an orange *Create account* button; content in cards with accent-coloured headings; radii 8, 12 and 18 px; Tailwind-standard breakpoints 640/768/1024/1280/1536 |

Rules:

1. **Render inside the site's own layout** as a Next route, so header, nav and
   footer are the site's, not copies.
2. **Every colour, font and radius comes from `--sc-*` and `--font-display`.** No
   hex values in the FashionWorks package, enforced with stylelint
   `color-no-hex`.
3. **Theme changes apply live, including inside the 3D view.** Canvas background,
   grid, selection outline and shadow tint read the tokens through
   `getComputedStyle`, and re-read them when a `MutationObserver` sees
   `data-theme` change. All four themes are tested, including light-leaning
   variants.
4. **Reuse the site's primitives** — buttons, cards, chips, inputs — from the
   Hangarworks repo. Where they are not exported, the package exposes
   `className` slots for the host to fill rather than re-creating them.
5. **Tabler Icons only.** No second icon library.
6. **Accessible in every theme:** WCAG AA contrast, keyboard navigation through
   slot lists and swatches, and `prefers-reduced-motion` respected.
7. **The redesign mockup is not the target.** `hangarworks-redesign-mockup.html`
   uses different `--hw-*` tokens and a blueprint grid. If that redesign ships,
   token-driven styling follows it automatically, provided the new tokens keep
   the `--sc-*` names or a small alias map is added.

The viewer's current panels use their own dark styling and all need restyling
onto these tokens.

## Architecture

**Two repos, one boundary.**

- **This repo publishes `@fashionworks/web`:** a `<FashionWorks />` React
  component, its workers and the WebAssembly core, built with the existing Vite
  toolchain in library mode. It contains no page chrome and no `public/assets`.
- **The Hangarworks repo adds a route** (for example `app/fashionworks/page.tsx`).
  The landing and onboarding copy render statically; the app loads with
  `next/dynamic(..., { ssr: false })` only after *Get started*.

**Threads without `SharedArrayBuffer`.** Multithreaded WebAssembly needs
cross-origin isolation (COOP/COEP headers), which would break the site's
reCAPTCHA and other cross-origin embeds. Instead, use separate workers that pass
transferable `ArrayBuffer`s:

- **archive worker** — owns the `File` or handle, the P4K index, byte-range reads
  and decompression
- **build worker** — DataCore → catalogue, geometry, skeleton, poses
- **main thread** — three.js rendering and UI only

**Storage, keyed by the P4K fingerprint.**

- IndexedDB: catalogue, settings, the persistent file handle.
- Origin Private File System: large binary caches such as decoded textures and
  geometry buffers, under a least-recently-used cap the visitor can see.
- Not `localStorage`: its 5 MB limit is shared with the site, which already
  stores its blueprint cache (`sc_scmdb_cache_v2`) there.

**Content Security Policy:** if the site sets one, this route needs
`'wasm-unsafe-eval'` in `script-src`.

**No accounts required.** Saving loadouts to a Hangarworks account is a
possible later addition; it is a few kilobytes of JSON and cheap.

## Phases

Each phase ends on an exit criterion, not a date.

**Phase 0 — Gates**
- *Legal:* review CIG's fan-content policy and terms for a public tool that reads
  the visitor's own game files and hosts none of them. Add the non-affiliation
  notice. StarBreaker is MIT, so redistributing a WebAssembly build needs only
  its notice. cgf-converter is not shipped.
  **Exit:** a written go/no-go. **Status: not started, and it blocks everything
  else.**
- *Feasibility spike:* compile `starbreaker-p4k`, `-datacore` and `-dds` to
  `wasm32`. In a bare page on Windows, in both Chrome and Firefox, open the real
  158 GB `Data.p4k` through `<input>` and drag-and-drop, read the central
  directory, extract and parse `Game2.dcb`, decode one DDS and parse one
  `.skinm`. Confirm drag-and-drop from the default Program Files location.
  **Exit:** indexing plus DataCore under 2 minutes, peak memory under 2 GB,
  WebAssembly ≤ 2 MB brotli. If this fails, reassess before building anything
  else; the local helper is the fallback.

  **Status: the headless half passes on the real archive; the Windows/browser
  half is outstanding.** `web/spike/` holds both, with the numbers in its
  README. Against a 147.59 GB `Data.p4k`: 1,365,842 entries indexed in 8.3s from
  **two range reads totalling 0.29% of the file**, `Game2.dcb` read in 1.2s and
  parsed to 116,921 records in 0.1s, a 2048² DDS decoded in 383ms, peak RSS
  1.45 GB, wasm **0.07 MB brotli**. A file extracted through the core is
  byte-identical to the native StarBreaker CLI's output. In a browser the page,
  worker, `FileReaderSync` and wasm all run and reject a fake archive correctly;
  what is untested is the real file, Firefox, and Program Files drag-and-drop.

  Three assumptions in this plan turned out to be wrong, all in our favour
  except the last:
  - `memmap2` and `rayon` **compile to wasm32 unchanged**. The table above says
    both need a feature flag. They do not, on the paths the browser build calls.
  - `.skinm` parsing is not needed for the spike to be meaningful; DataCore and
    DDS were the real risks and both cleared.
  - **A `.dds` in this archive is not a whole DDS.** Every real texture is split:
    the named entry holds headers and the smallest mip, the rest live in sibling
    entries. `FsSiblingReader` assumes a directory, which a browser has not, so
    the core resolves siblings against the entry index. Anything that decodes a
    texture has to do this, so it belongs in Phase 3's design, not as a surprise.

**Phase 1 — Catalogue in the browser**
Port `catalog.py`, including product-name set keys and variant linking.
**Exit:** ≥ 99.5% field agreement with the Python manifest on the full build,
with every remaining difference explained.

**Status: met, and the first version of this claim was measured the wrong way
round.** 100.000% on all 20 fields across **2475 items**, with the manifest and
the port now producing the same 2475 — checked in *both* directions.

The original read "100.000% across 2426 items, none unmatched", and it was
true and misleading. `full_diff` only ever compared port to manifest: an item
the port never built could not appear as a disagreement, because there was
nothing to disagree with. **189 of the manifest's 2615 items, 7.2%, were simply
absent**, and the harness reported a perfect score over the port's own output.
A rate needs the reference as its denominator, not the thing being tested.

Reported in both directions, the gap split into two real faults, one on each
side:

- **The port was missing the class-name slot fallback**, which the Python keeps
  *"so a renamed attach type cannot silently empty the catalog"*. That cost 23
  wearable items: the Ready-Up Helmet's twenty colourways and three ThermoWeave
  pieces are filed under `clothing/pu_clothing/clothing_hats/` with an attach
  type outside the `Char_Armor_*` family, and nothing but their name says what
  they are.
- **The pipeline was cataloguing 140 phantom items.** `catalog.build` iterated
  *every* record in the export, and the export includes `**/tintpalettes/**`
  because the palette lookup needs it. A palette is named after the piece it
  colours, so the same class-name fallback matched
  `ccc_combat_medium_armor_01_02_01` and even
  `Tint_LootContainer_Generic_Legendary` and turned them into items with no
  geometry, no materials and no name. 75 of them duplicated the class name of
  the real item they colour. The viewer never showed them, because it also
  requires a GLB, which is why this survived until the port was diffed the
  other way.

Both are fixed. A third fault surfaced with them: the port resolved
`@LOC_EMPTY`, a real CIG sentinel that `global.ini` maps to the empty string, to
`Some("")`, where the Python's `name or class_name` folds `""` in with `None`.
Three helmets came out with a blank name and no `unnamed` flag — a distinction
Python's truthiness never had to make and Rust's `unwrap_or` does.

`data/out/manifest.json` still holds the 140 phantoms until `scx catalog`,
`scx refresh` and `scx variants` are re-run in that order.
`cargo run --example full_diff` builds a whole manifest from the real
`Game2.dcb` and diffs it field by field; `catalog_diff` scores individual rules
in isolation. Both run natively, because the DataCore layer takes bytes and does
not care where they came from, and the same code compiles to `wasm32`.

Four differences had to be chased, and none of them was visible from reading
the code:

- **Palette references resolve case-insensitively.** The record is
  `TintPaletteTree.IAE_2022`; the reference is `.../iae_2022.json`. 124 items
  came back with a palette name and no colours over one letter.
- **The Python's scope is narrower than the DataCore's.** Its DCB export filters
  on `**/entities/scitem/characters/human/**`, so eleven Vanduul pieces it never
  sees looked like a porting bug. Matching the filter also cut the run from
  16.6s to 3.8s.
- **A rigid piece hangs its colourway off the record's `Material` sibling**, not
  its geometry tree, so every backpack resolved no palette at all until
  `material_palette` was passed as the override.
- **The weight class is in the record's own directory** for 13 items that say it
  nowhere else, which is why the source path is carried through to `build_item`.

What this does *not* cover: the male skeleton only (female is phase 6), and the
port has been run natively rather than in a browser. The wasm build is clean but
has not been exercised against a DataCore extracted in-page.

**Phase 2 — Geometry, skeleton and poses**

**Status: complete. Armour from the visitor's own archive renders, skinned, on
the canonical armature, in a browser.**

Two Sunchaser pieces read out of the real 147.59 GB `Data.p4k` and put on
screen, against what the pipeline made of the same files:

| | helmet | core |
| --- | --- | --- |
| triangles | 27,938 = **27,938** | 34,738 = **34,738** |
| material groups | 7 (pipeline 6, see below) | 8 = **8** |
| bounds | y 1.578–1.872, **exact** | y 1.000–1.727, **exact** |
| joints | 255 | 255 |
| unweighted vertices | 0 | 0 |

Vertex counts differ -- 16,930 against 28,223 on the helmet -- and should:
Blender splits a vertex wherever two faces disagree about a normal or a UV.
Triangles are the invariant, since nothing in that chain adds or removes one.

**The canonical armature is reproduced bone for bone.** The base `.chr` carries
220; a CDS undersuit grafts 34 and the slaver core the one more
(`gadget_attach_1_override`) that reaches **255 bones with 35 attachment
points** -- against the pipeline's golden, *0 missing and 0 extra*. Positions
agree on 251 of 255 within a millimetre; the four that do not are covered
below. `cargo run --example rig_union` is the check.

**Binding verified rather than assumed**, because a mesh bound to a skeleton it
ignores looks identical until something moves. At rest, skinning reproduces the
mesh **exactly** -- error 0.000000, so the bind matrices and inverse binds are
right. Rotating `Head` moves helmet vertices; reversing it restores exactly;
rotating `LeftFoot` moves the helmet by 0. And one `Spine1` rotation moves the
helmet *and* the core, which is the whole point of the shared armature: **2
pieces, 1 `THREE.Skeleton`, 1 bone array, 255 bone objects.**

**Sockets and poses are wired in too, so a loadout assembles.** A backpack is a
rigid `.cga` with no bone weights at all: it parents to
`backpack_attach_1_override` with `locator⁻¹` as its local matrix, and posing
the spine carries it while posing a foot does not. Its own
`grip_left_1`/`grip_right_1` land at x **-0.206** and **+0.202**, which is the
only check that catches a backwards mount -- a pack's extents look much the same
either way round. **No yaw**: the pipeline's `SOCKET_YAW` is a Blender-frame
correction and applying it here mounts the pack backwards.

The idle pose retargets from `stand.dba` at **145 clip bones, all 145 resolved**
by CRC32, and lands on the pipeline's own figures: head **1.704** against 1.70,
hips **1.001** against 1.00, hands at **-0.307** and **+0.302** against ±0.31 at
hip height, feet at **0.103**.

Two things that cost real time, both recorded in `CLAUDE.md`:

- **There are three up-axes, not two.** The `.chr` is +Z up, an animation clip's
  world space is **-Y** up, three.js is +Y. Archive-to-scene is -90 degrees
  about X; clip-to-scene is **180**. Using the skeleton's conversion on a clip
  rotation lays the character on its back at a right angle with every joint
  otherwise correct; using it on a clip *position* stands the body up along the
  wrong axis with every distance anatomically perfect.
- **A clip's local rotations apply directly here, and the pipeline's refutation
  of that does not transfer.** "Copy the local rotations" fails for a rig that
  has been through Collada and Blender, because its bone frames no longer match
  the clip's. This armature is built straight from the same `.chr` the clip
  targets, so they do match. Rotations only -- the clip's positions would import
  the animation rig's proportions, and leaving them alone is what keeps bone
  lengths ours.

*How it went.* The first question was the same one phase 0 asked of the DataCore:
does the parser run on wasm32 at all? `starbreaker-3d` as shipped does **not**,
and the reason is worth recording because this plan's dependency table missed
it. Two C-backed or filesystem-bound things reach into it:

- **`starbreaker-blend` pulls in `zstd`**, a C library with no wasm32 target.
  The table above says zstd is the pure-Rust `ruzstd`, and it is *in the P4K
  crate*; the `.blend` writer uses the other one.
- **The export pipeline needs `MappedP4k`**, which `web/patches/0001` gates away
  from wasm32 by design.

The parsers themselves are clean: `ivo`, `skeleton`, `types`, `dequant`,
`chrparams` contain no reference to either. So `web/patches/0002` splits the
crate along that line with two default-on features, `blend` and `pipeline`,
and the web build takes neither. The native CLI is unaffected. Result:
**0.57 MB raw, 0.12 MB brotli**, still far inside the 2 MB budget even with the
mesh and skeleton parsers linked in.

`tools/build.sh` now applies every patch in `web/patches/` rather than a named
one, so the next of these does not need a code change.

*The mesh pair is split by role, and the skeleton is in the small half.* This
is the same shape of trap as a `.dds` holding only its smallest mip, and it
matters because StarBreaker's own CLI takes the `.skinm`:

| file | chunks |
| --- | --- |
| `.skin` (2,888 bytes) | `EXPORT_FLAGS`, **`COMPILED_BONES_IVO320`**, `MTL_NAME_IVO320`, `MESH_IVO320` |
| `.skinm` (544,016 bytes) | `IVO_SKIN2` only -- the vertex streams |

So a port that reads only the file the CLI wants gets geometry with **no
skeleton**. Both halves have to be read, and the bones come from the 2.8 KB one.

Measured on `m_outlaw_legacy_light_arms_01`: 8,903 vertices, 13,446 triangles,
3 submeshes, bounds z 1.224-1.568 on a 1.745 m body, and 30 bones beginning
`World, Hips, Spine, Spine1` with 2 `*_override` attachment bones -- which is
the hierarchy and the attachment-bone behaviour this repo already records.

Two API shapes to keep straight, having had both backwards once:
`SkinMesh::read` takes **one chunk's data**, and `skeleton::parse_skeleton`
takes the **whole file** and finds its chunk itself.

*Dequantisation is verified against the pipeline's own GLB.* Positions are
SNorm `i16` scaled to the **scaling** bounding box, not the model one -- the
header carries both, and `build_mesh` picks correctly. Dequantised vertices fill
the declared box exactly, and the box matches what the existing pipeline
produced for the same mesh, once the Z-up to Y-up conversion is applied as
`(x, y, z) -> (x, z, -y)`:

| axis | from `.skin` | in the GLB |
| --- | --- | --- |
| x | -0.634 … 0.634 | -0.634 … 0.634 |
| y_gltf = z_skin | 1.224 … 1.568 | 1.224 … 1.568 |
| z_gltf = -y_skin | -0.246 … 0.088 | -0.246 … 0.088 |

Submesh count agrees too: 3 in the `.skin`, 3 primitives in the GLB. **Vertex
counts do not, and should not** -- 8,903 against 12,172, because Blender splits
vertices at UV and normal seams on export. A port that expects them to match
will chase a difference that is not there.

*Armour skinning is in a stream upstream does not decode, and this explains a
fact already in CLAUDE.md.* `starbreaker-3d` parses `IVOBONEMAP` at 12 bytes and
falls through on **`IVOBONEMAP32`**, which is what armour actually ships. That
is why "StarBreaker's `skin export` writes a rigid mesh" and why the Python
pipeline has to route through cgf-converter for anything skinned.

The layout was worked out from the bytes: **24 bytes, eight `u16` joint indices
followed by eight `u8` weights, summing to 255**. The sum is what confirms the
split -- no other reading of 24 bytes makes consecutive records total exactly
255. Verified on **136,092 vertices across six meshes**, every one summing to
255, with three further meshes using the older 12-byte form.

**Up to eight influences are really used.** One core mesh has 305 vertices at
8 and 323 at 7, so the four-influence `BoneMap12` path would silently truncate
them. glTF's `JOINTS_0`/`WEIGHTS_0` carry four, so anything past that needs
`JOINTS_1`/`WEIGHTS_1` -- a constraint for phases 2 and 3, not a detail.

*The skeleton reconciles exactly against the canonical armature.* The base
`.chr` parses to **220 bones**, every one of them present in
`data/out/base/male.skeleton.json`, with nothing extra. Of the armature's 36
attachment points, **35 are absent from the base and 1 is not**:
`mobiglas_attach` ships in the skeleton itself and, unlike the grafted 35,
carries no `_override` suffix. So 220 + 35 = 255, and `skeleton_diff` checks
that arithmetic rather than assuming it.

*Stray-weight redistribution is smaller than expected, and the reason is the
graft.* Once the 35 attachment bones are on the armature, **most armour meshes
have no stray weight at all** -- measured across eighteen, all but one came out
at 0.00%. CLAUDE.md's "41 joints of which only 16 exist" is against the *base*
220, not the canonical 255.

What is left is simulation geometry. The worst mesh measured,
`m_clda_utility_heavy_suit_04`, carries 3.48% of its weight on bones like
`au_shoulder_pad_Left` and `ac_flap_x03_y02`, and **759 of 31,413 vertices have
no surviving bone at all** -- those are the ones that get pinned to the origin
if the weight is dropped.

`core/src/rebind.rs` handles both cases and is verified on that mesh: 759
guessed, **0 left unweighted, 0 failing to sum to 255**. The guess keeps side:
380 left-pad vertices landed on left bones and 379 right-pad on right ones,
**none crossed over**. That matters because the mesh's dominant bone is `Spine3`,
which has no side -- a one-bone-per-mesh fallback would have collapsed all 759
onto the spine, which is the shape of the Antium shoulderpad failure.

*The animation path parses and its bones resolve.* `parse_dba` is not gated by
the pipeline feature, so the `.dba` databases read in a web build directly.
Channels are keyed by **CRC32 of the bone name**, which the armature's name list
resolves. Four figures come back matching what this repo already records, each
arrived at independently: `stand.dba` **189 clips**, `crouch.dba` **43**, and
**145 channels in each of the two useful clips, all 145 resolving**.
`nw_stand_idle_turn360_planted` and `nw_neutral_crouch_idle` are both present.

Clip names are full paths ending `.caf`, not the bare names the pipeline refers
to, so a lookup has to match on the stem. The `_add` clips -- 11 in stand, 3 in
crouch -- are additive deltas layered at runtime and are no use alone, so they
are counted separately rather than silently included.

*The retarget reproduces the pipeline exactly.* `core/src/poses.rs` runs forward
kinematics over the bind hierarchy and takes each bone's delta from its own bind
pose, `world_clip · inverse(world_bind)`, which is the third of three approaches
and the only one that works -- copying local rotations puts the character on its
back and copying world orientations points the arms at the ceiling.
`pose_diff` scores it against `data/out/poses.json`: **220 of 220 bones on both
the idle and the crouch**, within 1e-4.

It read 16.8% first. `parse_dba` hands back raw keyframes in CryEngine axes, and
the crate's own `clip_final_pose` is what applies the conversion --
`cry_xyzw_to_blender_wxyz` on the quaternion and `[x, -z, y]` on the
translation. Reading `kf.value` directly and reshuffling it by hand looked
plausible and was wrong. The signature was visible in the diff: x and w matched
while y and z were swapped and negated, which is a missing axis conversion
rather than a wrong algorithm.

*The socket yaw does not port.* `normalize_armor.SOCKET_YAW` rotates a rigid
prop 180 degrees before mounting it, and copying that into the port would mount
every backpack backwards. The yaw corrects for **Blender's bone-axis
convention**: `place_at_socket` composes against `bone.matrix_local`, where a
bone's local Y runs along the bone. Composed in the archive's own frame, with
the bone's `world_rotation` from the `.skin`, `grip_left_1` already lands at
x=-0.156 -- the character's left -- and the yaw would move it to +0.156. The
bone rest position agrees with the Python exactly at (0.000, -0.130, 1.440), so
this is a frame difference and not a data one.

*The graft reconciles too, bar one bone where the golden file is wrong.* Of the
donor's 35 attachment bones, **34 match the canonical armature on both parent
and world position**, to within a millimetre. The 35th,
`wep_sidearm_attach_override`, parents to `RightUpLeg` in the raw `.skin`, the
`.dae` and the `.gltf` alike, while the armature says `RightUpLeg_Start_sIk1`
and places it 27 mm away -- a divergence Blender's import introduced. The port
follows the archive, so `graft_diff` lists it as expected rather than failing
on it, and `CLAUDE.md` records it against the Python pipeline.

`.skin` → three.js geometry; canonical skeleton with grafted attachment bones;
per-vertex stray-weight redistribution; socket placement with its 180° yaw;
retargeted poses.
**Exit:** the reference sets — Bokto, Sunchaser, Corbel, Beacon, Deadhead —
render and pose correctly, and bone lists and bounds match the golden outputs.

**Phase 3 — Materials on the GPU**

*Started, and the ground is better than expected.* `starbreaker-3d`'s `mtl`
module already parses the `MatLayers` block this phase depends on, exposing
per-layer `path`, `tint_color`, `palette_tint`, `gloss_mult` and `uv_tiling`
plus a snapshot of the referenced layer material's `diffuse`, `specular` and
`shininess`. That is most of what `tint.py` reads, so the phase is a port of the
*rules* rather than of the parsing.

**`parse_mtl` wants binary CryXML, and that suits the browser better than the
Python.** Our `data/raw` copies are plain XML because extraction runs
`--convert cryxml`, and `parse_mtl` rejects those with "invalid magic: expected
CryXmlB". Read straight from the archive the same file parses first time. So the
browser path is *shorter* than the pipeline's: P4K bytes to `parse_mtl`, with no
conversion step in between. A harness that reads `data/raw` is testing the wrong
input.

*The rules port.* Three harnesses score three levels, each against the Python:

| harness | what it checks | result |
| --- | --- | --- |
| `layer_diff` | one layer's linear colour, and its metalness | **1944 of 1944, 100%** |
| `blend.rs` tests | the eight-entry blend table | matches the Python's dict exactly |
| `composite_diff` | per-submaterial mean albedo against the baked PNGs | **40 of 40** within 3 sRGB units, 35 within 1 |

The 5 outside a single unit were attributed to tiling quantisation, on the
evidence that they had a median effective tiling of 144 against 60 for the rest.
**That attribution was wrong**, and the enlarged golden refutes it: across 357
submaterials the rows *within* a unit have the higher median tiling. The real
cause is the bake's own output truncation, measured under Phase 3's status
below. The figure of 40 rows here also predates `scx golden`, which is what
made the larger set reproducible.

One thing worth contradicting in advance, because the opposite sounds more
sensible: **the blend mask is sampled bilinearly, not nearest.** It is a
selector, so interpolating it seems to invent layer indices between two
saturated colours -- but the pipeline resizes the mask bilinearly *then*
thresholds each channel at half, so the interpolation precedes the selection,
and a port that samples nearest disagrees along every boundary between layers.

**A note on instrumentation.** The first version of that harness collapsed
"file not found", "unreadable" and "parse failed" into one counter, reported
1944 of 1944 unresolved, and sent me looking at path handling while the files
sat exactly where they should. Counting the failure modes apart named the real
cause in one run.
The LayerBlend shader: the settled blend table, `PaletteTint`, `TintMode`, metal
texture normalisation, wear pairs, `_hal` occlusion and palette multiply, all on
texture arrays.
**Exit:** per-submaterial mean albedo within tolerance of the Python bakes; the
store-render comparisons re-run and pass; the audit invariants hold.

**Status: met, all three, and now running on real geometry from a real
archive.** `web/gpu/` holds the shader; `web/app/src/three/surface.ts` drives it
from the archive, and the Sunchaser renders gold.

The in-browser composite against the pipeline's baked PNGs for the same
submaterials, with no lighting in between:

| submaterial | browser | bake | off |
| --- | --- | --- | --- |
| `core_plate_m` | 111.3 91.5 58.3 | 109.3 89.4 56.3 | 2.1 |
| `core_fabric_m` | 57.0 56.3 55.3 | 56.2 55.6 54.9 | 0.8 |
| `smallplate_m` | 155.7 128.8 87.4 | 154.9 127.4 85.6 | 1.8 |
| `backplate_m` | 114.6 99.3 73.6 | 113.0 97.4 72.3 | 1.9 |
| `bracket_m` | 167.7 150.0 118.2 | 165.8 148.5 116.9 | 1.9 |

Every one brighter, by 0.8 to 2.1 -- the direction and size the bake's own
truncation predicts. Non-LayerBlend submaterials are skipped correctly: the
helmet's `helmet_light_m` is `Illum`, and the core's glass and glow are
`GlassPBR` and `Illum`.

On screen the pair reads **45.5% gold at a contrast of 2.56** over a
silhouette-diffed 101,548 body pixels. That is *not* comparable to the store
render's 36.0%: it pools a helmet (reference 50.1%) with a core (36.0%), and
this page's lighting is a placeholder rather than the tuned scene. The
composite-against-bake table above is the comparison that isolates the shader.

Two faults found by running it:

- **A material references the artist's `.tif` and the archive ships the built
  `.dds`.** Looking the path up as written finds nothing, silently, and the
  composite runs with no layer textures -- flat tinted plates that look
  plausible and carry none of the detail.
- **Asset lookup was a linear scan over 1,365,842 entries**, normalising both
  sides per comparison, and a split DDS resolves about eighteen of them for its
  mip streams. Indexing once took the helmet's five surfaces from 15,162 ms to
  **1,490 ms** and the core's from 19,586 ms to **485 ms**, with the range-read
  count unchanged at 285 -- so none of it was I/O.

| exit criterion | harness | result |
| --- | --- | --- |
| mean albedo within tolerance | `web/gpu/check.html` (GPU) | **356 of 357** within 3 sRGB units, 148 within 1 |
| | `composite_diff` (CPU) | **345 of 345** within 3, 148 within 1 |
| store-render comparison | `gold_fraction` | **313 of 318** surfaces within 1 coverage point; **30 of 31** pieces within 0.25 contrast |
| audit invariants | `audit_port` | **every check holds**; the only findings are one known pipeline gap |

Three things are worth carrying forward, because each cost a wrong answer
first.

**The golden outputs are now regenerable.** They were a throwaway script, so the
numbers here could be quoted but not re-derived. `scx golden` is that script,
kept, and all three harnesses read the same file. Making it re-runnable
immediately mattered: the old selection skipped colour variants on the reasoning
that they share geometry with their sibling, which dropped **Sunchaser and
Halcyon** — the two pieces the store-render comparison is measured against. A
variant names its own `mtl_var/` material, so it is a different layer stack, not
a tint.

**The residual against the bake is the bake's own quantisation, not the port's
rules.** Two plausible explanations were tested and refuted before the real one
turned up:

- *Tiling quantisation* — the explanation this document previously gave, fitted
  to 40 rows. On 357 it does not hold: rows **within** 1 unit have a higher
  median effective tiling (200) than rows beyond it (107), and the worst row has
  the lowest tiling in the set.
- *The 512² layer-library cap* — repacking at 1024² changed the count within 1
  unit not at all.
- *The bake truncates* — confirmed. `compose_layered` writes
  `(linear_to_srgb(rgb) * 255).astype(np.uint8)`, which truncates where a GPU
  RGBA8 target rounds. Measured over two million samples that is **0.575 sRGB
  units** of mean brightness (0.496 truncation, 0.079 LUT). The shader reads
  brighter than the bake on 89% of channels by a mean of 0.80, so this is most
  of it. The remaining ~0.30 is unexplained, grows with brightness, and sits
  well inside tolerance.

So the bake is 0.57 dark — 0.2%, not worth invalidating 21 GB of cache over, but
worth not misreading as a porting fault.

**Two measures had to be taken at the right level, and were not at first.**

- *A piece's contrast is not the mean of its submaterials' contrasts.* A render
  pools every material into one image; a single submaterial compares its gold
  against its own non-gold, which for a mostly-dark bracket with a gold edge is
  a different number. The Sunchaser's eight gold-bearing materials read 0.78 to
  3.50 individually. Pooled, the piece reads 2.49.
- *An albedo atlas is not a lit render, so the 2.95–3.47 reference band does not
  apply to it.* The atlas reads 2.44–2.77 — for the port **and the bake alike**,
  which is the point. A metal's specular response, occlusion, and UV space no
  camera sees all separate the two. Judging the atlas against the band reported
  "0 of 4 in band", which would have been a failure of the renderer read as a
  failure of the port. The pass condition is port against bake.

On the eight pieces the criterion actually names — Sunchaser and Corbel Halcyon,
helmet, core, arms and legs — the port and the bake agree to **0.21 coverage
points and 0.22 contrast** or better. The single piece outside the contrast
tolerance, `Corbel Helmet Mire`, reads a contrast of **0.91**: its "gold" is
darker than its body, which means the band is picking up dark olive rather than
an accent. That is the band being applied to a colourway it was not defined for,
not a rule difference, and it is left visible rather than tuned away.

**Two checks were tightened by running them.** The colourway invariant, swept
across every submaterial rather than the first, called two healthy families
collapsed: the Defiance helmet's `camera_m` agrees to 5.9 across six colourways
while its `coated_metal_m` spreads 44.1. A camera lens being one colour on every
colourway is intent. The invariant now fires only when a family collapses on
*every* submaterial, which is what the Venture regression actually did. And a
surface whose accent sits on the hue band's boundary — the Ana set's is at
exactly 30.0 against a band starting at 30 — has a coverage decided by noise, so
it is reported apart rather than scored.

The one finding the audit does report is `sentinel-red-baked`, on 21 surfaces,
and it is **inherited rather than introduced**: CIG marks where a glow goes with
a pure-red BaseLayer tint, and compositing that as albedo needs an emissive
output plumbed through to fix. The Python's own audit reports 267 of these. On
the items both cover the two agree to the percentage point.

**Phase 4 — Onboarding and caching**
The flow above: storage, update detection, every error state.
**Exit:** a first-time tester on a default install gets from landing to a
rendered set without help.

**Status: the machinery is built and verified; the exit criterion is not met,
and cannot be yet.** `web/app/` holds it: 37 tests, plus a browser check for the
parts a headless test cannot reach.

Done and checked — capability detection split into blocking and warning;
validation with every failure state worded as guidance; the build fingerprint;
the catalogue cache, versioned and keyed per build so LIVE and PTU coexist; the
OPFS piece cache under a byte budget with LRU eviction; the flow as a pure state
machine; and the UI, with all fifteen screens rendered side by side because the
failure screens are rare by definition and so are the ones that ship broken.

**The index step is stubbed, so the flow cannot reach a rendered set.** The
worker that drives the WebAssembly core through indexing, catalogue, geometry
and materials is not wired up. Everything before it is real — the check, the
drop, validation, the caches — and none of it can finish the sentence. That
assembly is the next piece of work, and it is what Phase 2's note meant by
*"what remains for a renderable result is assembly rather than format work."*
The tester on a default install is then a second gate, and a Windows one,
alongside Phase 0's outstanding browser half.

Three things the platform dictated, and one bug worth recording.

- **Drag-and-drop is the primary path, not a nicety.** Chromium's blocklist
  refuses every File System Access picker under Program Files, which is exactly
  where Star Citizen installs, so `showOpenFilePicker()` *fails on the default
  install*. The same fact makes "drop it again" the ordinary return visit for
  most visitors, so it is worded as normal rather than as a failure.
- **The fingerprint is the entry index, not the timestamp.** This plan said size
  plus `lastModified` plus a hash of the central directory. `lastModified` is a
  property of the copy: moving the archive, restoring a backup or a launcher
  touching the file would each throw the catalogue away and force a needless
  re-index. Size and the entry list are properties of the build, and both are
  already in memory once indexed.
- **Say it does not upload before asking for the file.** A visitor asked to hand
  over 158 GB will assume an upload and stop.
- **The browser check found a race the tests could not.** `get()` fired an
  unawaited index write on every read; one landing across a reopen's read left a
  half-written file, and `loadIndex` responds to an unreadable index by
  *clearing the cache*, because it cannot budget entries whose sizes it does not
  know. A visitor clicking through pieces quickly could lose everything cached.
  Writes are now serialised and touch-on-read debounced. A quieter sibling:
  `clear()` removed the pieces directory without replacing the handle, so every
  later write silently cached nothing — a cache that works until "Clear cache"
  is pressed once. Neither is reproducible against a fake; both needed the real
  file system.

**Phase 5 — Hangarworks integration and theming**
Package, Next route, tokens, all four themes, accessibility.
**Exit:** switching theme on the site restyles the page and the 3D view with no
reload, and AA contrast passes in every theme.

**Phase 6 — The female body, and launch hardening**

*Female skeleton.* Deferred here deliberately: it is orthogonal to the web port
and would otherwise block it. The assets exist and are confirmed in the archive
— `female_v2/export/bhf_skeleton_v2.chr` (22,232 bytes) and **5,332 female
armour mesh entries** against 7,004 male — and the pipeline already threads a
`skeleton` argument through `select_wearables`, `geometry_for` and
`scx rig --skeleton female`, with `setSkeleton` already in the viewer store. So
the plumbing is there and nothing has ever run through it.

Three things make this its own phase rather than a flag:

- **Every one of the 2,458 GLBs is a male conversion.** A female catalogue is a
  second full conversion run, and Collada intermediates are large.
- **The binding question is open.** "Whether female meshes bind to the same bone
  names as male ones" is in this repo's own unverified list. If they do not,
  `binding.ts`'s name remap needs a second naming scheme, and that is a
  different change from a build run.
- **5,332 against 7,004 means some items are male-only.** The UI must not offer
  a body type that silently drops pieces from a loadout.

**Do the single-item spike first**: build the female rig, convert one set, and
diff its joint list against the female armature. An hour, and it decides whether
the rest is a build or a rewrite.
**Exit:** a reference set renders and poses on the female skeleton with the same
joint count and order its armature declares, and items with no female mesh are
marked rather than missing.

*Launch hardening.* Bundle-size and no-game-data checks in CI, a Vercel usage
alert, a Discord beta, and an FAQ entry on the site.
**Exit:** the traffic budget holds under beta traffic.

## Risks

1. **The knowledge port, not the code port, is the real cost.** The blend table
   alone took four attempts. Mitigation: Python stays the reference; golden
   outputs and the audit gate every phase.
2. **The default install blocks persistent handles**, so most returning visitors
   re-drop the file to load new pieces. Mitigation: aggressive caching and a
   banner that appears only when needed.
3. **Browser differences.** Firefox and Safari have no persistent handles, and
   `File.slice()` on a 158 GB file must be tested in each. Safari is best-effort
   and mobile is unsupported.
4. **Low-end GPUs:** texture arrays, a 512² layer cap, and eviction.
5. **A game patch can break the catalogue for everyone at once**, and there is no
   server-side fix. Mitigation: version-tolerant field lookups, the
   `fields.py`-as-hypothesis discipline, an "unsupported build" message rather
   than a crash, and a fast release path.
6. **CIG's policy answer** could change the plan.
7. **`viewer/dist` is 105 GB** because Vite copies the `public/assets` symlink. The
   web package must never use `public/assets`, and CI must block that output
   from any deploy.
8. **Theme drift** if the redesign ships with renamed tokens (rule 7 above).

## Non-goals

- Hosting any extracted asset, pre-built catalogue, or CIG screenshot.
- Server-side processing, uploads, or requiring an account.
- Mobile.
- Replacing the local pipeline.

## Open questions

- **URL and name:** `/fashionworks` or `/tools/fashionworks`, and is it called
  FashionWorks on the site?
- **Placement:** in the main nav, or linked from *Features* only?
- **Paid themes:** the page follows `data-theme` automatically, so it would
  honour paid themes for owners. Is that intended?
- **Later:** save loadouts to Hangarworks accounts?
