# SC Armor Kitbasher — Implementation Plan for Claude Code

Pipeline: `Data.p4k` → catalog (JSON) → geometry/texture extraction → Blender normalization → `.glb` + `manifest.json` → React/Three.js viewer.

Target: run fully locally first; viewer must be deployable later as a static web build with assets served from a CDN/bucket.

---

## 0. Ground truth on the tooling (read before Task 1)

The original plan assumes `scdatatools` is a drop-in. Its state as of September 2026:

- **scdatatools (upstream, GitLab scmodding)** — last PyPI release 1.0.4 (April 2022). Upstream does not parse current `Data.p4k` / `.dcb` without patches.
- **Deltawerks/starfab fork (GitHub)** — packages the fixes to run StarFab against current live data; validated against live data March 2026. Installs the scdatatools `devel` branch plus patches for current chunk/loadout behavior, downloads the external converter tools, and targets **Blender 3.6** for its `.scbp` assembly importer. Python 3.10.x required.
- **diogotr7/StarBreaker (GitHub)** — actively maintained Rust toolkit (release within the last ~4 months). Single binary + crates: `starbreaker-p4k`, `starbreaker-datacore`, `starbreaker-cryxml`. Handles P4K extraction with glob filters, DCB → JSON/XML export (bulk or filtered), CryEngine asset handling, character files, and DDS split-mip merging + PNG conversion. Auto-detects the SC install (Windows and Linux Wine/Proton roots).
- **dolkensp/unp4k** — reference C# tools (`unp4k.exe`, `unforge.exe`); `unp4k.fs` mounts a `.p4k` or `.dcb` as a Dokan virtual drive on Windows.
- **StarCitizenToolBox/unp4k_rs** — Rust unp4k with DCB → XML, full-text DCB search, and an optional **MCP server** exposing DataForge queries. Useful for letting Claude Code query records directly during development.
- **Markemp/Cgf-Converter** — converts `.cgf/.cga/.chr/.skin` to Collada/glTF, including skeletons and vertex weights. Still the standard path for StarEngine geometry. **CORRECTION (2026-09-13):** this repo name is dead; it is now **Markemp/Cryengine-Converter** (C#, v2.0.0 March 2026, Windows `.exe` releases only).

**Decision for this project:**
- Extraction engine = **StarBreaker CLI** driven by Python (`subprocess`). Reason: current, one binary, does P4K + DCB + DDS in one tool.
- Fallback / cross-check = scdatatools devel branch via the Deltawerks fork if a record type or blueprint StarBreaker doesn't expose is needed (character loadout assembly in particular).
- Geometry = **Cgf-Converter → glTF** first; if skin weights or bone hierarchies come out wrong, fall back to StarFab `.scbp` → Blender 3.6 importer.
- Blender: **4.x** for the normalization/export script (better glTF exporter). Keep a 3.6 install only if the StarFab importer fallback is used; write the batch script so it runs on both (avoid 4.x-only bpy calls or guard them).

**CORRECTION (2026-09-13) — platform availability.** Neither extraction tool ships a macOS build:

- StarBreaker v0.3.2 releases `linux-x86_64` and `windows-x86_64` CLI only, plus an AppImage and a Windows installer. It is Rust, so building from source is the macOS route.
- Cryengine-Converter releases a Windows `.exe` only. It is .NET, so `dotnet build` is the macOS route.
- Star Citizen itself is Windows-only, so a macOS host has no `Data.p4k` unless one is copied over.

Phases 1-2 therefore run on Windows (or Linux via Proton) unless both tools are built from source. Phase 0's exit criteria cannot be met on a Mac without that work. `scx doctor` reports which stages the current host can run.

Legal note (factual, not a recommendation): all extracted geometry/textures are CIG copyright. CIG publishes a fan content policy; the public web deployment in Phase 4 depends on what that policy permits for redistributing extracted assets. Local use has no distribution component.

---

## 1. Repository layout (monorepo)

```
sc-armor-kitbasher/
├── CLAUDE.md                     # working instructions for Claude Code (see §7)
├── PLAN.md                       # this file
├── config/
│   └── settings.toml             # SC install path, output dirs, tool paths, gender/skeleton choice
├── extract/                      # Python 3.11+ (uv or venv)
│   ├── pyproject.toml
│   ├── sc_extract/
│   │   ├── __init__.py
│   │   ├── tools.py              # wrappers: starbreaker, cgf-converter, blender (subprocess + path resolution)
│   │   ├── dcb.py                # DCB export + record loading/indexing
│   │   ├── localization.py       # global.ini → dict (@item_Name_* → English)
│   │   ├── catalog.py            # armor record filtering, slot mapping, manifest build
│   │   ├── geometry.py           # resolve geometry/material/texture paths per item; extract from p4k
│   │   ├── textures.py           # DDS merge → PNG (and optional KTX2 via toktx)
│   │   └── cli.py                # `scx catalog`, `scx extract`, `scx convert`, `scx all`
│   └── tests/
├── blender/
│   ├── normalize_armor.py        # headless batch: import glTF/DAE → canonical armature → export .glb
│   ├── build_base_rig.py         # one-off: export canonical skeleton + undersuit as base.glb
│   └── mtl_to_pbr.py             # StarEngine .mtl → Principled BSDF mapping helpers
├── data/                         # gitignored
│   ├── raw/                      # extracted p4k files (.skin/.chr/.cgf/.mtl/.dds)
│   ├── dcb/                      # exported DCB JSON
│   ├── interim/                  # Cgf-Converter output (.gltf/.dae), merged DDS, PNG
│   └── out/
│       ├── manifest.json
│       ├── base/                 # base.glb (skeleton + undersuit), skeleton.json
│       └── items/<item_id>/      # item.glb, thumb.png (later), materials.json
├── viewer/                       # Vite + React + TypeScript + R3F
│   ├── package.json
│   ├── public/assets -> ../data/out  (symlink locally; env var ASSET_BASE_URL for web)
│   └── src/
└── scripts/
    └── spike.ps1 / spike.sh      # one-item end-to-end smoke test
```

---

## 2. Phase 0 — Environment and single-item spike

Goal: prove the full pipeline on **one** armor set before writing anything general. Everything in Phases 1–3 is built by widening what the spike does.

Tasks:
1. `config/settings.toml`: `sc_root` (e.g. `.../StarCitizen/LIVE`), `starbreaker_bin`, `cgf_converter_bin`, `blender_bin`, `out_dir`, `skeleton = "male"|"female"`.
2. `sc_extract/tools.py`: locate binaries, run with logging, raise on non-zero exit.
3. Manual spike (documented in `scripts/spike.*`):
   - `starbreaker dcb extract --format json -o data/dcb --filter '**/*armor*'`
   - Pick one full set (e.g. any Light armor with helmet/core/arms/legs/backpack).
   - `starbreaker p4k extract -o data/raw --filter 'Data/Objects/Characters/Human/**/<set>/**' --convert all`
   - Extract the canonical skeleton: `human_male.chr` / `human_female.chr` (path under `Data/Objects/Characters/Human/`).
   - Cgf-Converter on the `.skin` files and the `.chr` → glTF/DAE into `data/interim`.
   - Open in Blender manually: confirm bone names on the armor `.skin` match the `.chr` skeleton, confirm vertex groups exist, confirm scale (StarEngine units are meters; check for 100x or Y-up/Z-up issues).
   - Export one `.glb`, load in a throwaway R3F page with `useGLTF`, confirm it renders and the skeleton is present.
4. Write down every discovered fact (actual record type names, actual paths, unit scale, bone naming, texture suffixes) into `CLAUDE.md` → "Verified facts". Do not proceed until this section is populated.

Exit criteria: one helmet and one torso from the same set render on the base skeleton in the browser.

---

## 3. Phase 1 — Catalog extraction (`scx catalog`)

### 3.1 DCB records
- Bulk-export DCB to JSON once (`starbreaker dcb extract --format json`); cache by `Data.p4k` mtime + size so re-runs skip it.
- Load records into an in-memory index keyed by record `__ref`/GUID and by filename path.
- Armor entities are `EntityClassDefinition` records. Filter on the attachable component params — expected fields to verify in the spike:
  - `SAttachableComponentParams.AttachDef.Type` — expected values in the family `Char_Armor_*` (`Char_Armor_Helmet`, `Char_Armor_Torso`, `Char_Armor_Arms`, `Char_Armor_Legs`, `Char_Armor_Backpack`, `Char_Armor_Undersuit`). Treat these names as hypotheses until confirmed against the export.
  - `AttachDef.SubType`, `Size`, `Manufacturer` (ref → manufacturer record → `Code`/`Name`).
  - `AttachDef.Localization.Name` / `.Description` → keys like `@item_Name_<id>`.
  - `SGeometryResourceParams.Geometry.Geometry.Geometry.path` (nested; exact nesting to confirm) → `.skin` / `.cgf` path.
  - `SGeometryResourceParams.Geometry.Geometry.Geometry.Tint` / material override refs for skin variants.
  - `SCItemClothingParams` / `SCItemArmorParams` (or equivalent) → weight class, damage resistance, `TemperatureResistance`, etc.
  - `tags` → refs to `Tag` records (`weapon_style`, manufacturer/faction tags, "Light/Medium/Heavy" often appears here or in SubType).
- Exclude: PU-unavailable test items, `_pu_`-suffix variants with no geometry, NPC-only pieces (flag rather than drop; store `flags: ["npc", "test", "no_geometry"]`).

### 3.2 Localization
- Extract `Data/Localization/english/global.ini` from the p4k; parse `key=value` into a dict. Resolve every `@` key in the catalog. Store both the key and the resolved string.

### 3.3 Slot normalization
Map every record to exactly one of:

```
helmet | torso | arms | legs | backpack | undersuit
```

Sub-slots to keep in metadata but not in the slot enum: `shoulders`, `chest_plate`, `arm_left/arm_right`, `leg_left/leg_right` — some sets ship arms/legs as a single mesh, others as L/R pairs. Record `geometry: [{path, side}]` as a list so the viewer can handle both.

### 3.4 Manifest schema (`data/out/manifest.json`)

```json
{
  "schema_version": 1,
  "game_version": "4.x.x (from Data.p4k or build manifest)",
  "generated_at": "ISO8601",
  "skeletons": {
    "male":   { "chr": "Data/Objects/Characters/Human/male_v7/...human_male.chr",   "glb": "base/male.glb" },
    "female": { "chr": "...", "glb": "base/female.glb" }
  },
  "sockets": ["head_socket", "back_socket", "..."],
  "items": [
    {
      "id": "guid-from-dcb",
      "class_name": "cds_helmet_light_01_black",
      "name": "CDS Explorer Helmet",
      "name_key": "@item_Name_...",
      "description": "...",
      "slot": "helmet",
      "sub_slot": null,
      "weight_class": "light",
      "manufacturer": { "code": "CDS", "name": "Clark Defense Systems" },
      "set": "cds_explorer_light",
      "variant_of": null,
      "variants": ["guid", "guid"],
      "tint": { "palette_ref": "...", "colors": ["#..."] },
      "stats": { "damage_reduction": {...}, "temperature": {...}, "carry_capacity": 0 },
      "bind_mode": "skinned | socket",
      "socket": null,
      "geometry": [
        { "source": "Data/Objects/Characters/Human/.../helmet.skin", "side": null }
      ],
      "materials": ["Data/Objects/.../helmet.mtl"],
      "assets": { "glb": "items/<id>/item.glb", "thumb": null },
      "flags": []
    }
  ]
}
```

`set` is derived: group items by shared path prefix + manufacturer + weight class; expose the grouping rule in code so it can be tuned. `variant_of` links color/skin variants to a canonical item so the viewer can show one entry with a swatch list.

### 3.5 CLI
- `scx catalog [--filter <glob>] [--include-npc]` → writes manifest with `assets.glb = null` for every item.
- Unit tests: fixture of 3–4 hand-trimmed DCB JSON records → expected manifest entries.

---

## 4. Phase 2 — Geometry, textures, rig normalization (`scx extract`, `scx convert`)

### 4.1 Raw extraction
For each manifest item: extract every `geometry.source`, its `.mtl`, and all textures the `.mtl` references (`--convert dds-merge` for split `.dds.N` mips, plus PNG). Textures are shared across items heavily; dedupe by path into `data/raw/textures`.

### 4.2 Geometry conversion
- Run Cgf-Converter per `.skin` → glTF (or DAE if glTF output loses weights; verify in spike). Also convert the chosen `.chr` once.
- StarEngine `.skin` files carry their own bone list referencing the shared human skeleton by name. Confirm in the spike whether the exported bone set is the full skeleton or a subset — this decides the binding strategy in §5.3.

### 4.3 Blender batch (`blender/normalize_armor.py`, run `blender -b -P ... -- --item <id> --manifest ...`)
Per item:
1. Fresh scene; import canonical armature from `build_base_rig.py` output (a `.blend` cached on disk) so **bone order is identical across every export**.
2. Import the converted geometry.
3. Apply scale/rotation fix from the verified facts (expect Z-up → Y-up handled by glTF exporter; scale may need ×0.01 or ×1 — verify).
4. For skinned pieces: delete the imported armature, parent the mesh to the canonical armature with *no* automatic weights (keep existing vertex groups; they match by bone name). Verify every vertex group name exists in the canonical armature; log any that don't.
5. For rigid pieces (some helmets/backpacks): if the `.skin` has one bone or the DCB record specifies a socket, mark `bind_mode = socket` and leave the mesh unparented but with its origin at the socket's rest transform.
6. Materials: parse `.mtl` (CryXML → XML via StarBreaker). Map StarEngine texture channels to Principled BSDF:
   - `_diff` → Base Color
   - `_ddna` → Normal (RGB, DirectX Y-flip → invert green) and Gloss in alpha → Roughness = 1 − gloss
   - `_spec` → treat as F0/specular tint; approximate with Specular + optional metallic mask
   - `_disp`/`_blend` → ignore for v1
   - Tint/decal layers: leave as separate material slots named `tint_<n>` so the viewer can recolor them.
7. Strip unused UV maps, limit vertex groups to 4 influences (`Limit Total`), triangulate.
8. Export `item.glb`: `export_apply=True`, `export_skins=True`, `export_animations=False`, `export_image_format='AUTO'`, `export_texture_dir` unused (embed), optional Draco (`export_draco_mesh_compression_enable=True`) behind a flag — off for local, on for web builds.
9. Write `data/out/items/<id>/materials.json` listing material slots and which are tintable.

`build_base_rig.py` (run once per skeleton):
- Import `human_male.chr` (converted), rename/keep bone names verbatim, add the undersuit mesh, export `base/male.glb` and `base/skeleton.json` (ordered bone name list + parent indices + rest pose). Same for female.

### 4.4 Orchestration
- `scx convert [--item <id>|--slot helmet|--all] [--jobs N]` runs Cgf-Converter and Blender in parallel worker processes; each Blender invocation handles a batch of ~20 items to amortize startup.
- Incremental: skip an item if `item.glb` exists and inputs' hashes match (store `.hash` sidecar).
- Update `manifest.json` `assets.glb` after each success; write `errors.json` with per-item failure reasons.

---

## 5. Phase 3 — Viewer / kitbasher (`viewer/`)

### 5.1 Stack
- Vite + React 18 + TypeScript
- `three`, `@react-three/fiber`, `@react-three/drei` (`useGLTF`, `OrbitControls`, `Environment`, `Stage`, `useKTX2` later)
- `zustand` for loadout state, `zod` for manifest validation
- Assets served from `ASSET_BASE_URL` (defaults to `/assets` → symlink to `data/out` in dev)

### 5.2 State
```ts
type Slot = 'helmet'|'torso'|'arms'|'legs'|'backpack'|'undersuit';
interface Loadout { skeleton: 'male'|'female'; slots: Record<Slot, string|null>; tints: Record<string, string> }
```
Store: manifest (loaded once), loadout, history stack (undo/redo), filter state (slot, weight class, manufacturer, set, search).

### 5.3 Binding strategy (the critical piece)
`SkinnedMesh.bind(masterSkeleton)` only works if the mesh's `skinIndex` attribute indexes the same bone order as the master skeleton. Two options; Phase 2 is designed to make Option A true:

- **Option A (preferred):** every `item.glb` was exported against the identical canonical armature, so bone order matches `base.glb`. On load: take each `SkinnedMesh` from the item scene, `mesh.bind(baseSkeleton, mesh.bindMatrix)`, add to the base scene under the skeleton root. Dispose the item's own skeleton/bones.
- **Option B (fallback):** on load, build a bone-name → index map for both skeletons and remap the item's `skinIndex` buffer, then bind. Implement B anyway as a runtime check: if any item bone name is missing in the master, log and skip the item.

Socket items (`bind_mode = "socket"`): `baseSkeleton.getBoneByName(item.socket).add(mesh)`.

### 5.4 Components
- `<Scene>`: canvas, `Stage`/`Environment` with 2–3 HDR presets, `OrbitControls`, ground shadow.
- `<BaseCharacter>`: loads `base/<skeleton>.glb`, exposes skeleton via context.
- `<ArmorPiece slot item>`: `useGLTF(item.assets.glb)`, binds per §5.3, cleans up on unmount.
- `<SlotPanel>`: tabs per slot, filter chips (weight class, manufacturer, set), search, "equip full set" action.
- `<TintPanel>`: per tintable material slot, color picker → sets `material.color` (and later a tint mask shader).
- `<LoadoutBar>`: undo/redo, randomize, clear, save/load (localStorage), export.

### 5.5 Export
- JSON: `Loadout` + manifest `game_version`.
- Combined `.glb`: `GLTFExporter` on the base scene with current pieces; bake tints into material colors; optional `binary: true`.
- Screenshot: `gl.domElement.toDataURL()` at 2× DPR.
- Shareable URL: `?l=<base64url(JSON)>` — this is what makes the web version useful without a backend.

### 5.6 Performance
- Lazy-load items per slot; preload the rest of the equipped set.
- Web build: Draco + KTX2 (`toktx` step in `scx convert --web`), `useGLTF.preload`.
- Thumbnails: Phase 3.5 — headless render each item on the base rig via a Node/Puppeteer script or Blender, write `thumb.png`, populate `assets.thumb`.

---

## 6. Phase 4 — Web deployment (later)

- `vite build` → static bundle; assets to S3/R2/Cloudflare with `Cache-Control: immutable` and content-hashed paths (`items/<id>/item.<hash>.glb`).
- Manifest served with a short cache; viewer version-gates on `schema_version`.
- No backend required for v1 (URL-encoded loadouts). If accounts/saved loadouts are wanted later, reuse the Hangarworks auth stack.
- Gate on the CIG fan content policy review noted in §0 before making asset URLs public.

---

## 7. Claude Code task sequence

Each task is one session or PR. Acceptance criteria are what Claude Code should verify before declaring done.

**Task 0 — Scaffold + CLAUDE.md**
- Create repo layout from §1, `settings.toml`, `tools.py`, pre-commit (ruff, prettier).
- `CLAUDE.md` contents: project purpose, tool decisions from §0, "Verified facts" (empty section to fill), commands to run each stage, rule: *never hardcode paths outside settings.toml*, rule: *StarBreaker output is the source of truth; if a record field guess in PLAN.md conflicts with real data, update PLAN.md and CLAUDE.md*.
- Accept: `scx --help` runs; `starbreaker`, `cgf-converter`, `blender` resolve from config.

**Task 1 — Spike (§2)**
- Script the one-set extraction end to end; fill "Verified facts".
- Accept: one helmet `.glb` and `base/male.glb` in `data/out`; a `viewer/` placeholder page renders the helmet on the skeleton.

**Task 2 — Catalog (§3)**
- `dcb.py`, `localization.py`, `catalog.py`, `scx catalog`, tests.
- Accept: `manifest.json` lists all FPS armor with slot, weight class, manufacturer, resolved names, geometry paths; counts per slot printed; zero items with unresolved `@` names (or listed in `errors.json`).

**Task 3 — Extraction + conversion (§4)**
- `geometry.py`, `textures.py`, `build_base_rig.py`, `normalize_armor.py`, `scx extract`, `scx convert`, parallelism, incremental hashing.
- Accept: `scx convert --slot helmet` completes; every helmet `.glb` loads in the viewer and binds without bone-name errors; `errors.json` explains any failures.

**Task 4 — Viewer core (§5.1–5.4)**
- Scaffold, manifest loading, base character, slot swapping, filters, HDR presets.
- Accept: can equip a full set from the UI; swapping is under ~200 ms for cached items; no leaked geometries (check `renderer.info.memory` stable after 50 swaps).

**Task 5 — Tints + export + persistence (§5.5)**
- Accept: tint changes persist through export; combined `.glb` reopens in Blender with the skeleton; URL loadout round-trips.

**Task 6 — Full run + thumbnails + web build (§5.6, §6)**
- `scx all`, thumbnail renderer, `scx convert --web` (Draco/KTX2), `vite build` with `ASSET_BASE_URL`.
- Accept: full catalog converted; web build loads a set from a remote asset URL.

---

## 8. Known risks and unknowns (resolve in Task 1)

- Exact DCB field names for armor records and geometry nesting.
- Whether Cgf-Converter's glTF output preserves skin weights for `.skin` files or only DAE does.
- Whether the `.skin` bone list is a full skeleton or subset (affects Option A vs B in §5.3).
- Unit scale and up-axis of converted geometry.
- StarEngine `_ddna` gloss encoding and `_spec` semantics → PBR mapping fidelity.
- Female armor: separate meshes vs. shared meshes with different skeleton; may double the asset count.
- Items that use "attachment" records rather than direct geometry (e.g. some helmets with visors as sub-items).
- scdatatools/StarFab fallback requires Python 3.10 and Blender 3.6 side-by-side with the main 3.11/4.x toolchain.
