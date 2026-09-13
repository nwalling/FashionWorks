# CLAUDE.md — working instructions

## What this is

A Star Citizen FPS-armor kitbasher. Pipeline:

```
Data.p4k -> catalog (JSON) -> geometry/textures -> Blender normalize -> .glb + manifest.json -> React/Three.js viewer
```

`PLAN.md` is the design document. This file is the operational one: what is
decided, what is verified, and what to run. When the two disagree, this file wins
and `PLAN.md` gets corrected.

## Rules

1. **No hardcoded paths outside `config/settings.toml`.** Machine-specific values
   go in `config/settings.local.toml` (gitignored) or `SCX_<SECTION>_<KEY>` env vars.
2. **StarBreaker output is the source of truth.** Every DataCore field name in
   `extract/sc_extract/fields.py` is a hypothesis. When real data disagrees, fix
   `fields.py`, then update the "Verified facts" section below and `PLAN.md`.
3. **Never commit extracted assets.** Everything under `data/` is CIG copyright
   and gitignored. See "Legal" below.
4. **Do not mark a stage done without running it.** `scx doctor` says what this
   host can actually run.

## Tool decisions

| Role | Tool | Note |
| --- | --- | --- |
| P4K + DataCore + DDS | **StarBreaker** (diogotr7/StarBreaker) | v0.3.2, May 2026. One binary covers all three. |
| Geometry -> glTF | **Cgf-Converter** | Repo is now **Markemp/Cryengine-Converter**, C#, v2.0.0. `Markemp/Cgf-Converter` in PLAN.md §0 is a dead name. |
| Normalization + export | **Blender** | Scripts run on 3.3+ and 4.x; version differences are behind capability checks in `blender/_common.py`, not version numbers. |
| Fallback | scdatatools devel via the Deltawerks/starfab fork | Only if StarBreaker cannot expose a record type. Needs Python 3.10 + Blender 3.6 side by side. |

### Platform reality (checked 2026-09-13 on this host, macOS arm64)

Neither extraction tool ships a macOS build:

- StarBreaker v0.3.2 releases **linux-x86_64** and **windows-x86_64** CLI only.
  It is Rust, so `cargo build --release` from source is the macOS route. No
  `cargo` on this host.
- Cryengine-Converter releases a Windows `.exe` only. It is .NET, so
  `dotnet build` is the macOS route. No `dotnet` on this host.
- Star Citizen is Windows-only, so there is **no `Data.p4k` on this machine**.

Consequence: `scx catalog`, `scx extract` and `scx convert` cannot run here.
They are written and unit-tested, but unverified against real data. Run them on
a Windows host with the game installed, or point `paths.sc_root` at a copied
`Data.p4k` and build the two tools from source.

## Commands

Setup:

```bash
python3.11 -m venv extract/.venv && extract/.venv/bin/pip install -e "extract[dev]"
npm --prefix viewer install
```

Pipeline:

```bash
extract/.venv/bin/scx doctor                 # what this host can run
extract/.venv/bin/scx catalog                # Data.p4k -> data/out/manifest.json
extract/.venv/bin/scx extract --slot helmet  # manifest -> data/raw
extract/.venv/bin/scx rig --skeleton male    # canonical armature -> data/out/base
extract/.venv/bin/scx convert --slot helmet  # data/raw -> data/out/items/<id>/item.glb
extract/.venv/bin/scx all                    # everything, in order
```

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

Two lists. The first is verified. The second is what the Task 1 spike must fill
in and **must not be guessed at** — `fields.py` holds the current guesses, and
they are marked as such.

### Verified on this host (2026-09-13)

- **Joint order is stable across exports.** Every item GLB exported against the
  cached canonical armature carries an identical joint list to `base/male.glb`
  (23 joints, same order, 30/30 items). This is what makes PLAN.md §5.3
  Option A a pointer swap rather than a buffer rewrite.
- **Rebinding shares one skeleton at runtime.** With a full set equipped, the
  scene holds 1 distinct `THREE.Skeleton` and 23 bone objects total; posing a
  bone deforms the base mesh and every equipped piece together.
- **Socket pieces export unskinned.** Backpacks come out with no `skins` array
  and their origin baked to the socket rest transform, so
  `bone.add(mesh)` is all the viewer needs.
- **Swapping does not leak.** Renderer geometry count rises while the
  `useGLTF` cache fills, then holds flat across hundreds of swaps, with tint
  changes interleaved. Only the handful of geometries actually in the scene are
  live; the rest is the cache, which is what makes swaps instant. Median swap
  latency is ~17 ms (one frame). Re-measure with `window.__kitbasher.gl.info`.
- **Tinting has to work from the bound mesh list, not the loaded scene.**
  Binding reparents meshes out of the cloned item scene and under the base
  character, so traversing the clone afterwards finds nothing. This was a real
  bug; `ArmorPiece` now tints the list `bindSkinned`/`bindSocket` returns.
- **The batch normalizer isolates failures.** A batch containing a broken item
  writes the other items and records the failure in `errors.json`.
- **Blender on this host is 3.3.1**, not the 4.x PLAN.md §0 assumes. The export
  helper drops unsupported keyword arguments and logs which, so the same script
  runs on both.

Caveat: all of the above was proven with **synthetic placeholder geometry**
(`blender/make_synthetic.py`), not game assets. It validates the mechanism, not
the data.

### Unverified — fill these in during the Task 1 spike

- Exact DataCore field names and geometry nesting depth. Current guesses:
  `extract/sc_extract/fields.py`. Every candidate list there is ordered; delete
  the ones that turn out wrong rather than leaving them.
- Whether `AttachDef.Type` really uses the `Char_Armor_*` family, and its exact
  member spellings.
- Whether Cgf-Converter's glTF output preserves skin weights, or whether DAE is
  required.
- Whether a `.skin` bone list is the full skeleton or a subset. Decides whether
  the Option B remap in `viewer/src/three/binding.ts` ever fires.
- Unit scale and up-axis of converted geometry. `build_base_rig.py` has
  `--scale` and `--up-axis` flags defaulting to no-op.
- `_ddna` gloss encoding and `_spec` semantics. Current mapping in
  `blender/mtl_to_pbr.py` is the PLAN.md §4.3 guess.
- Real bone names. `blender/make_synthetic.py` uses placeholders
  (`spine_01`, `upperarm_l`, ...) that are certainly not CIG's.
- Female armor: separate meshes or shared meshes on a different skeleton.
- Items that use attachment records rather than direct geometry (helmet visors).

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
viewer/src/
  manifest.ts               zod schema, mirrors manifest.py
  three/binding.ts          §5.3 Option A + Option B fallback
  store.ts                  zustand: loadout, history, filters
  loadout.ts                share-URL encode/decode
```

## Gotchas

- `manifest.py` and `viewer/src/manifest.ts` are the same schema twice. Change
  both, and bump `SCHEMA_VERSION` on both; the viewer refuses a mismatch.
- `viewer/public/assets` is a symlink to `data/out`, created by
  `npm run link-assets`. It is gitignored and does not survive a fresh clone.
- In dev the viewer exposes `window.__kitbasher` (renderer, scene, camera) and
  `window.__store`. That is how the swap-leak and latency numbers above were
  measured. Both are stripped from production builds.
- Geometry and materials are shared with the `useGLTF` cache. Only geometry that
  `binding.ts` cloned for a skin-index remap may be disposed.

## Legal

Extracted geometry and textures are CIG copyright. Local use has no distribution
component. **Public deployment of asset URLs is gated on a review of CIG's fan
content policy** (PLAN.md §0, §6) and has not been done.
