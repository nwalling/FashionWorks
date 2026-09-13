# SC Armor Kitbasher

Extract Star Citizen FPS armor from `Data.p4k`, normalize it onto one canonical
skeleton, and mix and match pieces in a browser.

```
Data.p4k -> catalog -> geometry/textures -> Blender -> .glb + manifest.json -> React/Three.js viewer
```

`PLAN.md` is the design. `CLAUDE.md` is the operational reference: decisions,
verified facts, and the commands for each stage.

## Status

The pipeline and the viewer are built and tested. The extraction stages are
**not verified against real game data** — Star Citizen is Windows-only and there
is no `Data.p4k` on the development host. Everything downstream of extraction is
proven against synthetic placeholder assets.

| Stage | State |
| --- | --- |
| Scaffold, config, `scx` CLI | done |
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

1. Install [StarBreaker](https://github.com/diogotr7/StarBreaker) and
   [Cryengine-Converter](https://github.com/Markemp/Cryengine-Converter). On
   macOS both need building from source; see `CLAUDE.md`.
2. Point the config at your install:

   ```toml
   # config/settings.local.toml  (gitignored)
   [paths]
   sc_root = "C:/Program Files/Roberts Space Industries/StarCitizen/LIVE"

   [tools]
   starbreaker = "C:/tools/starbreaker.exe"
   cgf_converter = "C:/tools/cgf-converter.exe"
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
