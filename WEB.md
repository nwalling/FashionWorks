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

**Phase 2 — Geometry, skeleton and poses**
`.skin` → three.js geometry; canonical skeleton with grafted attachment bones;
per-vertex stray-weight redistribution; socket placement with its 180° yaw;
retargeted poses.
**Exit:** the reference sets — Bokto, Sunchaser, Corbel, Beacon, Deadhead —
render and pose correctly, and bone lists and bounds match the golden outputs.

**Phase 3 — Materials on the GPU**
The LayerBlend shader: the settled blend table, `PaletteTint`, `TintMode`, metal
texture normalisation, wear pairs, `_hal` occlusion and palette multiply, all on
texture arrays.
**Exit:** per-submaterial mean albedo within tolerance of the Python bakes; the
store-render comparisons re-run and pass; the audit invariants hold.

**Phase 4 — Onboarding and caching**
The flow above: storage, update detection, every error state.
**Exit:** a first-time tester on a default install gets from landing to a
rendered set without help.

**Phase 5 — Hangarworks integration and theming**
Package, Next route, tokens, all four themes, accessibility.
**Exit:** switching theme on the site restyles the page and the 3D view with no
reload, and AA contrast passes in every theme.

**Phase 6 — Launch hardening**
Bundle-size and no-game-data checks in CI, a Vercel usage alert, a Discord beta,
and an FAQ entry on the site.
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
