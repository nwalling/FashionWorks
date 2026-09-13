# StarFashion

A Star Citizen armor kitbasher. It reads the game's own data, converts every
wearable piece onto one shared skeleton, and lets you mix and match them in the
browser.

```
Data.p4k → catalog → geometry + textures → Blender → .glb + manifest.json → viewer
```

## What works

Verified against build **1.0.191.55227** (`sc-alpha-4.10.0-hotfix`):

| | |
| --- | --- |
| Items catalogued | 2615 |
| Selectable in the viewer | 2431 |
| Meshes converted | 491 |
| Catalog run | ~17 seconds |

Every piece binds to a single 255-bone skeleton, so armor deforms with the body
and you can pose the whole outfit at once. Colours come from the game's tint
palettes, surface detail from its normal maps.

Slots: helmet, torso, arms, legs, backpack, undersuit. Filter by weight class,
manufacturer or set, swap colour variants from a swatch row, equip a whole set
in one click, tint individual pieces, and export the result as JSON, a combined
`.glb`, a screenshot, or a shareable URL that needs no backend.

## Quick start

```bash
./starfashion setup     # dependencies, and build the extraction tools
./starfashion demo      # placeholder assets — no game install needed
./starfashion run       # http://localhost:5173
```

`demo` generates a synthetic rig and armor set so the viewer is usable
immediately. The meshes are primitives, not game assets, but they exercise the
same manifest, skeleton and binding path as the real thing.

## With a real install

```bash
./starfashion use-p4k /path/to/StarCitizen/LIVE   # or the Data.p4k itself
./starfashion doctor                              # what this machine can run
./starfashion build                               # catalog, rig, convert
./starfashion run
```

`use-p4k` accepts any volume, including an external drive or SD card, and writes
the path to `config/settings.local.toml`. The archive is read in place and never
copied.

Conversion is incremental and keyed on a hash of the inputs, so re-running only
redoes what changed. A full first pass takes a while: the archive is around
158 GB and every mesh goes through Blender.

## Commands

| | |
| --- | --- |
| `./starfashion setup` | install dependencies, build the extraction tools |
| `./starfashion doctor` | report what this machine can run, and what is blocking |
| `./starfashion use-p4k <path>` | point the pipeline at a Star Citizen install |
| `./starfashion demo` | generate placeholder assets, no game data needed |
| `./starfashion build` | catalog + base rig + convert everything |
| `./starfashion run` | start the viewer |
| `./starfashion check` | tests, lint, typecheck and a production build |
| `./starfashion scx …` | pass anything through to the pipeline CLI |

Useful pipeline commands: `scx sets` lists armor sets and how much of each is
converted, `scx convert --set <key>` does one set, `scx refresh` re-points the
manifest at whatever is on disk.

## Requirements

Python 3.11+, Node, and Blender 3.3 or newer. The two extraction tools,
[StarBreaker](https://github.com/diogotr7/StarBreaker) and
[Cryengine-Converter](https://github.com/Markemp/Cryengine-Converter), ship no
macOS binaries, so `tools/build.sh` compiles them from source; that needs
`cargo` via rustup, and `dotnet` for the optional second one. `doctor` tells you
exactly what is missing.

## Layout

```
starfashion         one entry point for everything below
config/             settings.toml — every path in the project
extract/            Python pipeline and the scx CLI
blender/            headless normalization and export scripts
viewer/             Vite + React + react-three-fiber
tools/build.sh      builds the extraction tools from source
data/               generated, gitignored
```

`CLAUDE.md` is the working reference: tool decisions, verified facts about the
game data, and the traps found along the way. `PLAN.md` is the original design,
annotated where reality disagreed with it.

## Legal

Extracted geometry, textures and screenshots are CIG copyright. **None of it is
in this repository** — everything under `data/` is gitignored, and only code,
configuration and documentation are tracked. Local use has no distribution
component. Publishing asset URLs would depend on CIG's fan content policy and
has not been done.

This is an unofficial fan project, not affiliated with or endorsed by Cloud
Imperium Games.
