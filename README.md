# SC Armor Kitbasher

Extract Star Citizen FPS armor from `Data.p4k`, normalize it onto one canonical
skeleton, and mix and match pieces in a browser.

```
Data.p4k -> catalog -> geometry/textures -> Blender -> .glb + manifest.json -> React/Three.js viewer
```

`PLAN.md` is the design. `CLAUDE.md` is the operational reference: decisions,
verified facts, and the commands for each stage.

## Status

The pipeline and the viewer are built and tested, and both extraction tools are
built from source and working on macOS. The only thing still missing is a
`Data.p4k`, so the extraction stages are **not yet verified against real game
data**. Everything downstream of extraction is proven against synthetic
placeholder assets.

| Stage | State |
| --- | --- |
| Scaffold, config, `scx` CLI | done |
| Extraction tools built from source | done, `starbreaker` and `cgf-converter` resolve |
| Catalog (`scx catalog`) | written, unit-tested against fixtures, unrun on real data |
| Extract / convert | written, batch path proven with stand-in inputs |
| Base rig + normalization | done, verified |
| Viewer core, tints, export, share links | done, verified |
| Thumbnails, web build | not started |

Run `scx doctor` to see which stages the current host can execute.

## Try it without game data

```bash
python3.11 -m venv extract/.venv
extract/.venv/bin/pip install -e "extract[dev]"
npm --prefix viewer install

extract/.venv/bin/scx synth --items 30      # placeholder rig, items, manifest
npm --prefix viewer run link-assets
npm --prefix viewer run dev                 # http://localhost:5173
```

The generated meshes are primitives, not game assets. They exercise the real
manifest schema, joint ordering, skinned and socket binding, and the viewer's
rebinding path, so pipeline and UI work is not blocked on having the game.

## Run it against a real install

1. Build the extraction tools. Neither ships a macOS binary, so this clones
   and compiles both:

   ```bash
   tools/build.sh
   ```

   It needs `cargo` (via rustup) and, for the optional cross-check tool,
   `dotnet`.

2. Point the pipeline at a `Data.p4k`. Any volume works, including an SD card:

   ```bash
   extract/.venv/bin/scx use-p4k /Volumes/<card>/StarCitizen/LIVE
   extract/.venv/bin/scx doctor
   ```

3. Work through the spike before trusting anything general:

   ```bash
   scripts/spike.sh pathfinder
   ```

   It prints what the DataCore actually contained. Record the answers in
   `CLAUDE.md` under "Verified facts", correct
   `extract/sc_extract/fields.py`, then run `scx all`.

## Layout

```
config/     settings.toml — every path in the project
extract/    Python pipeline and the scx CLI
blender/    headless normalization and export scripts
viewer/     Vite + React + react-three-fiber
data/       generated, gitignored
scripts/    spike.sh
```

## Legal

Extracted geometry and textures are CIG copyright and are never committed.
Local use has no distribution component. Publishing asset URLs is gated on a
review of CIG's fan content policy and has not been done.
