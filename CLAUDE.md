# CLAUDE.md — working instructions

## What this is

A Star Citizen FPS-armor kitbasher. Pipeline:

```
Data.p4k -> catalog (JSON) -> geometry/textures -> Blender normalize -> .glb + manifest.json -> React/Three.js viewer
```

`WEB-LEGAL.md` holds the Phase 0 legal research: what CIG's EULA and
Fandom FAQ actually say, the options, and **the go/no-go, which is decided and
is go** — with the conditions recorded under "Legal" at the foot of this file.
The other root docs are described in the index under "Verified facts".

`PLAN.md` is the design document. This file is the operational one: what is
decided and what to run, with an index of the verified facts. When `PLAN.md`
disagrees with this file or with `docs/verified-facts/`, they win and `PLAN.md`
gets corrected.

## Rules

1. **No hardcoded paths outside `config/settings.toml`.** Machine-specific values
   go in `config/settings.local.toml` (gitignored) or `SCX_<SECTION>_<KEY>` env vars.
2. **StarBreaker output is the source of truth.** Every DataCore field name in
   `extract/sc_extract/fields.py` is a hypothesis. When real data disagrees, fix
   `fields.py`, then record the fact in the matching file under
   `docs/verified-facts/` (see "Verified facts" below) and correct `PLAN.md`.
3. **Never commit extracted assets.** Everything under `data/` is CIG copyright
   and gitignored. See "Legal" below.
4. **Do not mark a stage done without running it.** `scx doctor` says what this
   host can actually run.

## Tool decisions

| Role | Tool | Note |
| --- | --- | --- |
| P4K + DataCore + DDS | **StarBreaker** (diogotr7/StarBreaker) | v0.3.2, May 2026. One binary covers all three. |
| Skinned geometry -> glTF | **Cgf-Converter** (Markemp/**Cryengine-Converter**) | The only tool that keeps `JOINTS_0`/`WEIGHTS_0`. Required, not optional. `Markemp/Cgf-Converter` in PLAN.md §0 is a dead repo name. |
| Skeletons -> Collada | Cgf-Converter with `-dae` | A `.chr` loses its bones in glTF and converts correctly to Collada. |
| Rigid/prop meshes | StarBreaker `skin export` | Fast P4K-to-GLB, but **mesh only, no skin weights**. Fine for backpacks and props. |
| Normalization + export | **Blender** | Scripts run on 3.3+ and 4.x; version differences are behind capability checks in `blender/_common.py`, not version numbers. |
| Fallback | scdatatools devel via the Deltawerks/starfab fork | Only if StarBreaker cannot expose a record type. Needs Python 3.10 + Blender 3.6 side by side. |

### Platform reality (macOS arm64)

Neither extraction tool ships a macOS build, so both are **built from source**
into `tools/bin` by `tools/build.sh`:

| Tool | Language | Built | Note |
| --- | --- | --- | --- |
| StarBreaker | Rust | yes, v0.3.2 | needs `cargo`; installed via rustup, not Homebrew (the `rust` formula did not install cleanly here) |
| Cryengine-Converter | .NET | yes | app host targets net9.0, Homebrew ships the .NET 10 runtime, so `tools/bin/cgf-converter` is a wrapper setting `DOTNET_ROOT` and `DOTNET_ROLL_FORWARD=Major` |

Both resolve through `tools.search_dirs`, so nothing needs to be on `PATH`.

Star Citizen is Windows-only, so there is no `Data.p4k` on this machine. Point
the pipeline at one on any volume, including an SD card or external drive:

```bash
extract/.venv/bin/scx use-p4k /Volumes/<card>/StarCitizen/LIVE
```

That writes `config/settings.local.toml`. With a P4K present, every stage
reports ready.

## Commands

`./fashionworks` wraps all of this; the raw commands are below it for when you
need a single stage.

```bash
./fashionworks setup                          # deps + build the extraction tools
./fashionworks use-p4k /Volumes/<card>/LIVE   # point at an install
./fashionworks build                          # catalog + rig + convert
./fashionworks run                            # viewer
./fashionworks check                          # tests, lint, typecheck, build
```

Pipeline:

```bash
extract/.venv/bin/scx doctor                 # what this host can run
extract/.venv/bin/scx catalog                # Data.p4k -> data/out/manifest.json
extract/.venv/bin/scx sets                   # sets, and how much of each is converted
extract/.venv/bin/scx sets --pending         # only sets with unconverted items
extract/.venv/bin/scx rig --skeleton male    # canonical armature -> data/out/base
extract/.venv/bin/scx convert --set <key>    # extract + convert + normalize one set
extract/.venv/bin/scx convert --all          # every canonical item that has geometry
extract/.venv/bin/scx refresh                # re-point the manifest at GLBs on disk
extract/.venv/bin/scx golden                 # golden outputs the web port is scored against
```

`scx convert` runs the whole chain: it extracts any missing raw assets, converts
meshes to Collada, then normalizes them in Blender. It is incremental, keyed on a
hash of the inputs plus the normalizer's own mtime, so editing
`blender/normalize_armor.py` correctly invalidates everything.

Colour variants are skipped by default (`--canonical-only`): they share geometry
with their canonical item and differ only by tint.

No game data on hand:

```bash
extract/.venv/bin/scx synth --items 30       # placeholder rig + items + manifest
npm --prefix viewer run link-assets
npm --prefix viewer run dev
```

Checks:

```bash
extract/.venv/bin/python -m pytest -q     # from extract/
extract/.venv/bin/ruff check extract
npm --prefix viewer run typecheck
npm --prefix viewer run build
```

## Verified facts

The verified facts live in topic files under `docs/verified-facts/`. They are
not loaded every session. Read the matching file before you change the code it
covers. Each file keeps its sections in the order they were written.

| File | What it covers | Read before touching |
| --- | --- | --- |
| `docs/verified-facts/pipeline.md` | What the pipeline was verified to do on this host and on real armor; what is still unverified | `blender/`, `scx convert`, `scx rig`, normals, material slot assignment |
| `docs/verified-facts/catalog.md` | Record shape, slots, the geometry tree trap, names and localization, asset lookup, extraction filters | `catalog.py`, `fields.py`, `dcb.py`, `localization.*`, `find_asset`, the browser catalog build |
| `docs/verified-facts/layerblend.md` | LayerBlend_V2 inputs: detail layers, wear, metalness, the blend mask table, gloss, wear off by default | `tint.py`, `layers.py`, `composite.rs`, `layerblend.js`, `bake.js` |
| `docs/verified-facts/palette.md` | Tint palette entries, PaletteTint indexing, tint versus specular | any palette or PaletteTint code |
| `docs/verified-facts/variants.md` | Color variants, color families, product lines, editions, the audit checks that guard them | `scx variants`, `link_variants`, `discover_materials`, set matching, listing groups |
| `docs/verified-facts/decals-and-submaterials.md` | Decal UVs in vertex color; mesh groups past the end of a material's list | `decal_uv`, `three/decal.ts`, `three/geometry.ts` |
| `docs/verified-facts/rig.md` | The canonical armature, coordinate conversion, skin weights, attachment points, sockets, the female body | `build_base_rig.py`, `binding.ts`, `armature`/`socket` code, `rig.ts` |
| `docs/verified-facts/animation.md` | Clip frames, the pose retarget, idles, emotes | `scx poses`, `tools/anim-dump`, pose or emote code |
| `docs/verified-facts/measurement.md` | Reference sources and how to compare against them: contrast ratios, accent coverage, the bake's dark offset | any comparison against a reference image |
| `docs/verified-facts/icon-reviews.md` | What the reviews against the game's inventory icons found (2026-10-30 to 2026-11-02) | metal palette entries, `_hal`, POM decals, stencils, ship parts, films |
| `docs/verified-facts/lighting.md` | Scene light, metered exposure, the Neutral curve, the floor shadow, backdrops | `lighting.ts`, `toneCurve.ts`, `three/ground.ts`, `Backdrop.tsx` |
| `docs/verified-facts/local-viewer.md` | The local viewer: binding, the base body, the GLB cache, undo, downloads | `viewer/src/` |
| `docs/verified-facts/web-kitbasher.md` | The web kitbasher's surfaces, glow, stencils, holsters and the held weapon | `web/app/`, `web/core/src/discover.rs`, gear code |
| `docs/verified-facts/clothing-and-character.md` | Clothing in the catalog, the `.chf` character, chunk visibility between pieces | clothing slots, `appearance::Library`, `outfit.offZones` |

The root docs are plans and research. Read the one that matches the work.

| File | What it covers | Read before touching |
| --- | --- | --- |
| `PLAN.md` | The original design document | architecture changes; correct it when this file disagrees |
| `README.md` | The public overview of the repository | anything a visitor reads first |
| `ANIMATION.md` | What the archive offers: the game's emote record and its clips, display poses, idles, sitting, and why faces are not yet playable | new animation or emote work |
| `CHARACTER.md` | Loading a player's `.chf`: the face as a per-region blend of library heads, skin tone, eyes, hair color, head items | character loading |
| `CLOTHING.md` | Clothing as a wearable layer: the body's ports, the undersuit that carries armor and hides clothing, layered body zones | clothing slots and zones |
| `HAIR.md` | Hair and facial hair: three material generations, a card's inputs and vertex streams (the normal stream is the strand, not the card's normal), ranked methods, the build record (§9) | hair shading |
| `LAYOUT.md` | Rearranging the kitbasher's controls: the toolbar folded into the left column and two viewport overlays, layout only | the kitbasher's layout |
| `LIGHTING.md` | The web kitbasher's lighting: the 2026-11-02 review, metered exposure, the presets as the game's own scenes; the local viewer's deferred plan at its end | lighting presets |
| `LOADOUT.md` | Weapons, holsters and the raised pose, with the port survey and clip measurements | gear and holsters |
| `RENDERING.md` | Closing the gap to a studio render: tone mapping, the game's probes as IBL, per-pixel LayerBlend, a body; the archive measurements it rests on and the boundaries it keeps | rendering features |
| `WEB.md` | The plan for the public web front end on sc-hangarworks.org | the web front end |
| `WEB-INTEGRATION.md` | The contract the Hangarworks site builds against | anything Hangarworks consumes |
| `WEB-INTEGRATION-PLAN.md` | The ordered plan handed to the agent that builds that site: the same boundary as steps, not a spec | integration steps |
| `WEB-LEGAL.md` | The Phase 0 legal research and the go decision, with its conditions | anything public: hosting, notices, distribution |

When you verify a new fact, add it as a `###` section to the matching file in
`docs/verified-facts/`, or start a new topic file there. CLAUDE.md gets at most
one index line for it.
## Layout

```
config/settings.toml        every path, one file
extract/sc_extract/
  config.py                 settings loading (toml + local + env)
  tools.py                  binary resolution and subprocess wrappers
  fields.py                 DataCore field-path hypotheses  <- fix here first
  dcb.py                    DCB export cache + record index
  localization.py           global.ini -> resolved names
  catalog.py                records -> manifest (slots, sets, variants)
  manifest.py               manifest schema (mirrored by viewer/src/manifest.ts)
  geometry.py / textures.py raw extraction and DDS handling
  pipeline.py               parallel batching + incremental hashing
  synthetic.py              descriptors -> manifest, for scx synth
  cli.py                    scx
blender/
  _common.py                version-tolerant bpy helpers
  build_base_rig.py         .chr -> canonical armature + base.glb + .blend cache
  normalize_armor.py        batch: converted geometry -> item.glb
  mtl_to_pbr.py             StarEngine .mtl -> Principled BSDF
  make_synthetic.py         placeholder rig and items (no game data needed)
web/core/src/
  composite.rs              LayerBlend rules on the CPU, the port's reference
  gold.rs                   accent coverage and contrast, with the band-edge test
  audit.rs                  the invariants, ported to run on composited surfaces
web/gpu/
  layerblend.js             the LayerBlend fragment shader
  bake.js                   WebGL2 texture arrays, MRT target, read-back
  check.html                scores the shader against the Python's bakes
viewer/src/
  manifest.ts               zod schema, mirrors manifest.py
  three/binding.ts          §5.3 Option A + Option B fallback
  three/gltfCache.ts        byte-budget LRU over the useGLTF cache
  store.ts                  zustand: loadout, history, filters
  loadout.ts                share-URL encode/decode
```

## Gotchas

- `manifest.py` and `viewer/src/manifest.ts` are the same schema twice. Change
  both, and bump `SCHEMA_VERSION` on both; the viewer refuses a mismatch.
- `viewer/public/assets` is a symlink to `data/out`, created by
  `npm run link-assets`. It is gitignored and does not survive a fresh clone.
- In dev the viewer exposes `window.__kitbasher` (renderer, scene, camera) and
  `window.__store`. That is how the swap-leak and latency numbers in
  `docs/verified-facts/pipeline.md` were measured. Both are stripped from
  production builds.
- Geometry and materials are shared with the `useGLTF` cache. Only geometry that
  `binding.ts` cloned for a skin-index remap may be disposed *by the viewer*.
  Everything else is owned by `three/gltfCache.ts`, which disposes a whole GLB
  when its byte budget evicts it, and never one that a mounted `ArmorPiece` has
  pinned.
- **A per-theme CSS rule must be scoped to `html`.** `[data-theme="dolomite"]`
  matches *any* element carrying that attribute, not just the document root, so
  the theme chips in `web/app/try.html` -- which set `data-theme` to name the
  theme they switch to -- each inherited that theme's whole palette and drew a
  light theme's text colour on the dark page. About 1.3:1, which reads as a
  disabled button rather than as a bug. Hangarworks itself never hits this,
  because `ThemeProvider` writes to `document.documentElement` and nothing else.
- **GTAO cannot see a cut-out.** `GTAOPass` draws depth and normals with one
  override material, so an alpha-tested hair card goes in as a solid quad and
  the skin round it takes occlusion from geometry nobody sees -- a brown fringe
  under a beard that no colour, cap or shadow test moves. Hair is kept out of
  the pass by `userData.noAo` (`ui/Viewer.tsx`). Anything else drawn as
  cut-outs needs the same.
- **`ContactShadows` must not be offset upwards.** drei parents its depth camera
  to the component's own group, but the plane it runs the two blur passes
  through is a standalone mesh pinned at world y=0. Give the group a positive y
  and that blur plane falls behind the camera's `near`, both blur passes draw
  nothing, and the second writes that nothing back over the render target. The
  shadow then disappears with no error, no console warning, and a scene graph
  that probes as perfectly healthy: plane present, `visible: true`, opacity
  intact, depth camera correctly framed over the body. Only reading the render
  target's *alpha* shows it empty — sampling its colour shows black either way,
  since "no shadow" and "full shadow" are both black and differ only in alpha.
  Offset downwards to clear the grid instead. Measured: y=0 and y=-0.01 give
  3.89% shadow coverage, y=+0.005 and y=+0.05 give 0%.

## Legal

Extracted geometry and textures are CIG copyright. Local use has no distribution
component. **Public deployment was gated on a review of CIG's fan content
policy** (PLAN.md §0, §6). That review is done and the answer is go, recorded
with its conditions in `WEB-LEGAL.md`: the fan-site notice verbatim and
prominent, a link to the official site, no ads or paywall or accounts, and no
game data served from the host. Advertising or a paid tier would move this into
Commercial use, which CIG prohibits outright, and would be a new decision.
