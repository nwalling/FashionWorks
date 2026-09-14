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

`./starfashion` wraps all of this; the raw commands are below it for when you
need a single stage.

```bash
./starfashion setup                          # deps + build the extraction tools
./starfashion use-p4k /Volumes/<card>/LIVE   # point at an install
./starfashion build                          # catalog + rig + convert
./starfashion run                            # viewer
./starfashion check                          # tests, lint, typecheck, build
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

### Verified against real game data

Build **1.0.191.55227** (`sc-alpha-4.10.0-hotfix`, 3 Sep 2026), a 158 GB
`Data.p4k`. A full catalog run takes about 17 seconds and yields **2615 items**
(739 helmet, 474 torso, 516 arms, 472 legs, 162 backpack, 252 undersuit),
399 canonical plus 2216 colour variants across 165 sets, every one with real
geometry.

**Record shape.** `Components` is a *list* whose members carry their type in
`_Type_`, not a dict keyed by type name. The record body is wrapped in
`_RecordValue_`, with `_RecordName_` (`EntityClassDefinition.<class_name>`) and
`_RecordId_` alongside. Look components up with `fields.component`, never by
dotted path.

**Slots.** `AttachDef.Type` uses exactly the `Char_Armor_*` family PLAN.md
guessed: `Char_Armor_Helmet|Torso|Arms|Legs|Backpack|Undersuit`. CIG calls the
torso slot **`core`** in paths and filenames. Weight class comes from
`AttachDef.SubType` and includes **`superheavy`**, which PLAN.md missed.

**The geometry field is a trap.** `SGeometryResourceParams.Geometry` is a tree,
and the triple-nested `Geometry.Geometry.Geometry.path` PLAN.md §3.1 predicted
does resolve, but at the *root* it is the **dropped-item carry prop**, not the
worn mesh. For torso, arms and legs it is literally a storage crate
(`crate_armor_core_1_005x005x005.cgf`). The worn meshes hang off `SubGeometry`,
one per gender:

```
Geometry                      -> carry prop (.cgf), or a .cdf for some helmets
  SubGeometry[0]              -> carry prop again
  SubGeometry[1]              -> female_v2/... f_*.skin   <- worn, female
    SubGeometry[]             -> prop, or shared visor meshes
  SubGeometry[2]              -> male_v7/...   m_*.skin   <- worn, male
    SubGeometry[]             -> prop, or shared visor meshes
```

`catalog.walk_geometry` flattens the tree and `catalog.select_wearables` picks
per skeleton, dropping LODs, carry props and the shared visors. Taking the root
blindly produces a catalog of crates.

**References** are relative `file://` URLs ending `<record type>.<name>.json`,
e.g. `scitemmanufacturer.cds.json`. `dcb.Index.ref_name` parses them. A
manufacturer record's `Name` is itself a localization key
(`@manufacturer_NameCDS`).

**Tags** are one space-separated string, not a list of refs:
`"Marine_Light Set_02 Color_02 SM_Marine"`. `Set_<n>` and `Color_<n>` give exact
set grouping and variant linking, far better than guessing from class names.

**Localization** resolves cleanly: `@item_Name_<class_name>` and
`@item_Desc_<class_name>` against `Data/Localization/english/global.ini`
(90,363 keys). 93 keys out of 2615 items are unresolved, listed in
`data/out/errors.json`.

**Meshes ship split**: `.skin` + `.skinm` (3450 pairs in the male armor tree),
`.cgf` + `.cgfm`, `.cga` + `.cgam`. The DataCore names the `.skin`, but a few
assets only ship `.cga`. StarBreaker's `skin export` matches on a P4K path
*substring* against **backslash** paths, and accepts only `.skinm`/`.cgfm`, so
pass a bare filename.

**Skinning, and why Option A is dead.** This is the most consequential finding.

* Cgf-Converter's glTF output for a `.skin` **does** carry `JOINTS_0` and
  `WEIGHTS_0`. StarBreaker's `skin export` does **not** — it writes a rigid
  mesh under a `CryEngine_Z_up` node. Only Cgf-Converter can produce skinned
  armor.
* A `.chr` skeleton exports **220 joints to Collada** (`World`, `Hips`,
  `Spine`..`Spine3`, `LeftUpLeg`, ...) but collapses to a single node in glTF.
  Skeletons must go through `-dae`.
* One armor piece exports **41 joints, of which only 16 exist in the base
  skeleton**, in an order that does not match. The other 25 are attachment
  bones the armor itself introduces: `magazine_attach_*_override`,
  `grenade_attach_*_override`, `thruster_*_override`, `backpack_attach_1_override`,
  `militaryMultitool_attach_override`.

  So PLAN.md §5.3 **Option A cannot work**, and Option B is not merely a
  fallback, it is the mechanism. The canonical armature must be the base
  skeleton **plus the union of the `*_override` bones across all armor**, and
  `viewer/src/three/binding.ts` must remap rather than skip. It currently skips
  a mesh whose bones are unknown, which would reject every real piece.

**CDF indirection.** Some helmets point at a `.cdf`, a CryXML character
definition naming the real mesh. Across 640 male armor CDFs the attachment
types are `CA_SKIN` (751, skinned, `Binding` is the mesh), `CA_BONE` (186,
rigid, carries `BoneName` + `RelPosition` + `RelRotation`, which is exactly the
socket transform), `CA_PROX` (173, collision proxies) and `CA_PROW` (302,
simulated strands). Only the first two are renderable. Parser: `sc_extract/cdf.py`.
17 items still resolve to a `.cdf` and are flagged `cdf` in the manifest.

**Backpacks** are rigid: a single `.cga` under `Characters/Human/backpack/`,
no gendered skin, so they bind to a socket. 135 items come out `socket`.

**Base skeletons**: `male_v7/export/bhm_skeleton_v7.chr` and
`female_v2/export/bhf_skeleton_v2.chr`.

**StarBreaker CLI notes.** `dcb query <PATH>` takes the path *positionally*, and
its `--filter` wants `*name*`, while `dcb extract --filter` matches record paths
and wants `**/name*`. `dcb query` is the cheapest way to test a field guess.
`skin inspect --bone-weights` dumps per-vertex influences. `entity export`
resolves loadouts and may cover what PLAN.md expected to need scdatatools for.
There is a `blender_addon` and material/export contract docs under
`tools/src/StarBreaker/docs/` worth reading before extending `mtl_to_pbr.py`.

### Verified by rendering real armor

The QRT "Bokto" heavy set (helmet, core, arms, legs, backpack) plus a CDS
undersuit renders on the shared 220-bone skeleton, with real tint colours and
normal-mapped detail, and deforms correctly when bones are posed. The scene
holds **one** skeleton and 220 bone objects across 10 skinned meshes.

**Use Collada for meshes, not glTF.** cgf-converter's glTF keeps skin weights,
but Blender does not apply its inverse bind matrices: one arms piece imported at
Z 2.60-3.21 on a 1.745 m skeleton, and the pieces stacked end to end instead of
overlapping the body. The same asset through `-dae` imports at Z 1.15-1.76,
which is correct. Collada files are much larger (16 MB versus 3 MB) and that is
the price. `normalize_armor.CONVERTED_SUFFIXES` prefers `.dae`.

**Scale and up-axis need no correction.** The skeleton is 1.745 m tall with hips
at 1.00 and head at 1.71, in metres, Z-up in Blender. `--scale` and `--up-axis`
stay at their no-op defaults.

**Strip vertex colours before export.** CryEngine stores layer-blend masks in
vertex colour. glTF multiplies `COLOR_0` into base colour and three.js honours
it, which rendered the whole character vivid magenta and yellow. `_common.strip_vertex_colors`
removes them in both Blender scripts.

**Option A is restored, but only because Blender does the remap.** Re-exporting
each item against the canonical armature makes every item GLB carry the same
220 joints in the same order, so the viewer binds by pointer swap. The runtime
name-remap in `viewer/src/three/binding.ts` is the safety net it was designed to
be. Two things make that work:

* unknown vertex groups are removed, but their weight is first moved onto the
  piece's dominant bone. Dropping it outright left 1080 of 30901 torso vertices
  unweighted, and Blender's exporter then invented a `neutral_bone`, pinning
  that cloth to the origin.
* the strays are of two kinds: `*_override` equipment attachment points, which
  carry no weight, and simulation chains (`CC_fabric_*`, `*_Skel_Sim`), which do.

**Armor has no albedo texture.** The shader is `LayerBlend_V2` and colour comes
from the item's tint palette. Textures are addressed by numbered slot, not by
role: `TexSlot3` is the normal map (`_ddn`/`_ddna`), `TexSlot9` a decal,
`TexSlot11/12/13` the wear, blend and "hal" layer masks. Filename-suffix
guessing alone misses all of them; `mtl_to_pbr.TEX_SLOTS` maps by slot first.

**Tint palettes give the real colours.** Each geometry node carries
`Geometry.Palette.RootRecord`, a `file://` ref to a `TintPaletteTree` whose
`entryA`/`entryB`/`entryC` each hold a tint colour, a specular colour and a
glossiness (0-255), plus a glass colour. 1183 of 2615 items resolve a palette.

### LayerBlend_V2, properly (2026-09-14)

Suits came out the wrong colour and looked untextured because the pipeline
composited palette colours and nothing else. The shader's real input is the
`<MatLayers>` block, which v2 never parsed.

**Each submaterial names up to eight tiling detail materials.** Four
`BaseLayer` and four `WearLayer` entries, each pointing at a small
`Shader="Layer"` .mtl under `Data/Materials/Layers` (paint, nylon, rubber,
scratched aluminium). Those supply `TexSlot1` diffuse and `TexSlot2` `_ddna`,
tiled at the armour layer's `UVTiling` times the layer's own `TexMod` tiling.
This is the surface detail that was missing; there is no per-piece albedo
anywhere in the archive.

**`PaletteTint` decides where a layer's colour comes from.** `0` means "use my
own baked `TintColor`", `1`/`2`/`3` index palette entry A/B/C. Across the male
armour set 17332 of 19981 layers are `0` - **87%**. Painting every layer with
the palette, as v2 did, repainted surfaces the artist had already coloured.
That was the colour bug.

**The blend mask is a hard-edged layer selector, not a soft gradient.** Blend
the mask channels over base layer 1 in the order **blue, then green, then
red**. On the slaver torso four colours cover 96% of the mask: black 34.8%
(layer 1), blue 32.9% (layer 2), cyan 25.6% (layer 3), magenta 2.7% (layer 4).
The intuitive red-green-blue order collapses cyan and magenta onto layer 4,
handing 60% of the surface to a rubber grip pattern and leaving the
palette-tinted layer on a few scraps. `test_tint.py` asserts this and fails if
the order is flipped.

**Per-pixel gloss is in `.dds.Na` sibling streams, and `--convert dds-png`
drops them.** Converted `_ddna` PNGs come out with a constant-255 alpha, which
looks like "this texture has no gloss". It has to be decoded separately with
`starbreaker dds decode --alpha`; `layers.gloss_for` does that and caches to
`data/interim/gloss`. Real gloss is `layer Shininess x GlossMult x that alpha`,
which replaced a hand-tuned 0.30-0.75 roughness band.

**`.dds` and `.dds.N` are mips; `.dds.Na` are the alpha mips.** A `_ddn` name
has no alpha stream at all and `--alpha` correctly errors on it. Only `_ddna`
carries one.

**Cache keys must name the submaterial.** v2 keyed the composite on the blend
map alone, so all five submaterials of a mesh shared one albedo despite having
different layer stacks.

**Layers under `Materials/Layers/metal` are metallic**, and a metal layer has
no diffuse texture at all - `aluminum_dirty.mtl` carries only a `_ddna`, with
`Diffuse="0.013"` and `Specular="0.84"`. Its base colour is its reflectance.

**.mtl colours are linear; palette hex and diffuse PNGs are sRGB.** Blend in
linear, write sRGB. A `TintColor` of `0.0395` is a dark grey (sRGB 59), not
black.

**The `_hal` map's green channel is used as ambient occlusion — inferred, not
confirmed.** In most of the 354 armour `_hal` maps red and blue sit pinned at
the neutral 123-128 while green varies widely, usually bright with dark
creases, which is what an occlusion map looks like. A minority vary in all
three channels. The composite maps it to the 0.35-1.0 range so that a wrong
reading stays a mild darkening rather than a black suit. Blender's glTF
exporter only writes occlusion when a group node named exactly
`glTF Material Output` with an `Occlusion` input is present, which
`mtl_to_pbr._wire_occlusion` creates.

### Wear layers (2026-09-14)

**`WearLayerN` is what `BaseLayerN` looks like worn through, paired on the slot
number.** The RSI utility heavy suit settles it: `hardsurf_m` has base layers
`painted_metal_11/10/07_chipped/04` and wear layers `aluminum_scratched_02`,
`anodized_metal_01`, `steel_dark_01`, `iron_scratched_dark`. Paint over the bare
metal underneath, index for index. Across the whole male set base layers skew
synthetic (6108 vs 2722 metal) while wear layers skew metal (4567 vs 3144), and
the commonest wear materials are `iron_polished`, `iron_scratched_01`,
`aluminum_polished` and `rusted_metal_01`. 2044 of 2737 submaterials are 4 base
plus 4 wear.

**Artists disable wear by pointing the wear entry at the base material.** 2744
of 9436 pairs (29%) do this, and the cloth submaterials of that same RSI suit
set all four that way. `SubMaterial.wear_pairs` returns `None` for those, so the
composite skips the blend instead of lerping a material with itself.

**The mask is one channel, so it is an amount, not a selector.** `_wear` is
`BC4_UNORM` — genuinely single-channel, which is why R=G=B on every sample. One
scalar cannot choose between four layers; the layer comes from the pairing and
the scalar says how much.

**Dark is worn.** Hard-surface masks average 0.72 to 0.90, and armour is mostly
intact paint with scuffed patches rather than mostly bare metal, so the bright
majority is the unworn side. The one sample that looked inverted (an RSI
jumpsuit at 0.32) belongs to `body_cloth_m`, whose wear layers are all no-ops,
so its direction never mattered. `test_tint.py` fails if the direction is
flipped.

**The wear mask is not aligned with geometry.** Correlation against the `_hal`
occlusion channel is -0.04 and against normal-map edge strength -0.02, measured
at native 2048 with `corr(AO, edge) = -0.32` as a working control. It is a
hand-painted grunge pattern, only mildly darker at blend-region boundaries
(-0.11, about the same as occlusion is). So do not try to derive it from edges.

**LayerBlend_V2 exposes no wear parameters, so the curve is chosen.** Of 2741
armour submaterials only 8 carry any `Wear*` PublicParam and those 8 are
`StencilEdgeWear*`, an unrelated stencil feature. The 192 materials that look
like wear tuning (`WearBlendBase` 0.1, `WearBlendFalloff` 0.75) are **GlassPBR**
canopy scratches, not this shader — an easy misread, since they sit in the same
files. `WearTint` is `1,1,1` and `WearGloss` is `1` on all 19981 layers, so
neither carries anything. `tint.WEAR_THRESHOLD`/`WEAR_FALLOFF` are calibrated so
the median of 30 real maps ends up 13.5% more than a quarter worn.

**`_hal` is Hue / AO / Luminance, now confirmed.** The shader flag
`%HUE_AO_LUMINANCE_MAP` appears on 11 submaterials, and the engine ships
`Engine/EngineAssets/Textures/layerblendHueLUT.dds`. Green is the occlusion
channel, which is the one carrying data; red and blue sit at a neutral 126.

**Texture formats, read off the DDS headers.** `_blend` is DXT1, three real RGB
channels. `_wear` is BC4_UNORM, one channel. `_ddn` is BC5_SNORM, a two-channel
normal with Z reconstructed. `_hal` is DXT1. None of the three control maps has
a `.dds.Na` alpha stream; only `_ddna` layer textures do.

**Meshes have exactly one UV set.** Checked on the imported Collada: one UV
layer and one colour attribute. `normalize_armor.cleanup` trimming extra UV
maps is therefore a no-op, not a cause of lost decals.

**Meshes carry several material slots** (shell, interior, metal, bones, props),
matching the `.mtl` submaterial order.

### Every piece rendered with one submaterial (2026-09-14)

Armour came out chrome instead of matte black because **the whole mesh was
being painted with its first submaterial's texture**. On the Artimex arms that
is `fingerarmor_m`, whose base layer is polished anodized metal at 89% coverage.
195 of 200 sampled items exported exactly **one** material no matter how many
their `.mtl` declared.

**`obj.data.materials.clear()` resets every polygon's `material_index` to 0.**
Blender clears the face assignment along with the slots. `apply_materials`
cleared and appended, so a mesh the Collada importer had loaded with ten
correctly assigned material groups came out with all 39546 polygons pointing at
slot 0. Slots are now replaced in place, matched by name (Collada names them
`<mtl stem>_mtl_<submaterial>`) so a mismatch between .mtl order and Collada
order cannot mis-assign them.

Worth knowing that nothing upstream was wrong: the `.dae` carries all ten
`<triangles>` groups, and Blender imports ten slots with indices 0-9 spread
correctly across the polygons. The damage happened in one line.

**Metalness comes from the layer's own reflectance, not its directory.**
CryEngine's Layer shader says it plainly: a metal carries `Specular` near its
F0 with `Diffuse` at black, a dielectric sits near 0.04. Across the 495-entry
layer library the populations separate cleanly, the `dielectric` category
topping out at 0.156, so `tint.METAL_F0_THRESHOLD` splits at 0.2. The old
directory rule missed the whole `metallic/` category (34 materials, 85% metal
by reflectance, and `/metallic/` does not contain `/metal/`) and promoted the
24% of `/metal/` entries whose own reflectance is dielectric. Measured impact
is small -- blend-weighted metalness over 31 armour submaterials moves from
0.25 to 0.23, with only 2 changing materially -- so this was not the cause of
the chrome look, just a correctness fix found while chasing it.

### Colour variants differ by material, not palette (2026-09-14)

Three symptoms, two causes. Every Odyssey II Undersuit showed the same grey
swatch and rendered identically; the CSP-68H backpack ignored its colourway;
and equipping a set produced mismatched pieces.

**A variant's colour usually lives in its own `.mtl`, not in a palette.** Of
2081 colour variants, **1626 name their own material** under a `mtl_var/`
directory, and **876 of those carry no tint palette at all**. Only 210 differ
by palette alone. `refresh_assets` points a variant at its canonical item's
GLB, and the viewer used to re-apply the variant's palette colour on top; with
no palette there was nothing to apply, so every colourway rendered the
canonical surface.

**Re-converting the mesh per variant is the wrong fix.** The geometry is
identical, so that would cost about 12.5 GB and four hours to produce copies of
meshes that already exist. `scx variants` bakes only the composited textures
and records them on the item as `material_overrides`; `ArmorPiece` swaps them
onto the shared mesh by submaterial name, stripping Blender's `.001` suffix.
1838 variants get their own surface this way in about an hour.

**Textures are served by symlink, not copied.** Bakes are named by a content
hash of their layer stack and palette, so variants that share a surface share a
file. `data/out/tint` is a symlink to `data/interim/tint`; Vite serves through
it, and the 21 GB cache is not duplicated.

**The flat palette-colour multiply is gone.** Tinting the whole albedo by one
palette entry repainted the 87% of layers the artist never palette-tinted. Only
an explicit user tint is a flat colour now.

**Swatches come from the baked albedo.** `paletteColor` returned palette entry
A, which is null for 876 variants (hence the identical `#4a5058` chips) and
wrong wherever the material tints from entry B or C. `pipeline.dominant_colour`
averages the item's own baked albedo instead, which is literally what the piece
looks like. Averaging the `.mtl` layer colours is only the fallback: it
over-weights layers the blend mask barely shows, and mushed every Odyssey
variant to the same grey. Two colourways that genuinely look alike now get
swatches that look alike, which is honest.

**`Manifest.write` restamps `SCHEMA_VERSION`.** Reading an older manifest and
writing it back preserved its number, so a stage that added fields shipped them
under the old version and the viewer, which refuses a mismatch, rejected a
manifest it could read.

**Set matching keys on product line first.** `equipSet` scored palette match
above family, so equipping from Defiance Core (Modified) put **ADP Arms
(Modified)** on the arms, a different product line that happened to share a
colour. Palette cannot be the primary key: `cds_heavy_set01` covers 193 items
across many lines, and the Defiance Modified pieces do not share one palette
among themselves, the helmet and arms carrying a different one from the core
and legs. Order is now family, then edition (the words after the slot, such as
"(Modified)" or "Tactical"), then palette, then canonical.

### Attachment points and sockets

The base skeleton has **no attachment bones**. Names like
`backpack_attach_1_override` are introduced by the worn pieces themselves, which
is why a backpack initially rendered at the body origin.

A CDS undersuit contributes 35 such bones, and **every one parents to a bone the
base skeleton already has** (`Spine3`, `RightHand`, `LeftUpLeg_Start_sIk1`, ...).
So `build_base_rig.graft_attachments` copies them onto the canonical armature,
taking it from 220 to 255 bones with 36 attachment points. Verified positions:

| Bone | Parent | Head |
| --- | --- | --- |
| `backpack_attach_1_override` | `Spine3` | (0.000, -0.130, 1.440) |
| `helmethook_attach_override` | `Spine` | (-0.098, -0.101, 1.055) |

**The prop's locator faces into the body, so the placement needs a 180 degree
yaw.** Without it every backpack is mounted backwards. A bounding box will not
catch this, since a pack's extents look much the same either way; the props'
own `grip_left_1` / `grip_right_1` locators will. Composed directly, a pack's
left grip lands on the character's right at x=+0.190; with the yaw it lands at
x=-0.190 where it belongs. `normalize_armor.SOCKET_YAW`.

**A rigid prop is authored around its own origin, not in body space**, and
carries empties marking where it mounts: a backpack ships a
`backpack_attach_1_loc` empty that pairs with the skeleton's
`backpack_attach_1_override` bone. `normalize_armor.place_at_socket` composes
`bone_rest · locator⁻¹` so the prop's frame lands on the bone, then exports the
result **in body space**. The viewer cancels the bone's rest matrix when it
parents the mesh.

Two earlier attempts were wrong and are worth not repeating. Baking the mesh
into the bone's local space in Blender fought the exporter's Z-up to Y-up
conversion of the bone's own rest rotation and put backpacks 1.3 m off the body.
Skipping the locator and using the bone position alone left the pack floating at
head height, because the prop's origin is not its mount point.

`catalog.SLOT_SOCKETS` maps a rigid slot to its bone. Grafted bones are marked
`use_deform = False` so they never pick up weight.

**Colour variants reuse the canonical mesh.** They differ only by tint, so
converting each one would duplicate geometry for nothing.
`pipeline.refresh_assets` points a variant at its canonical item's GLB, and the
viewer re-applies the variant's own palette colour, since the shared mesh carries
the canonical colour baked into its material.

### Non-wearable records

Some DataCore records carry an armor attach type without being wearable: shop
displays (`Shop_*`), the loot containers armor drops into
(`Lootable_Container_*`, `Tint_LootContainer_*`), and outright placeholders
named `<= PLACEHOLDER =>`. `catalog.flags_for` marks these `not_wearable`,
`placeholder` or `test`, and the viewer's `HIDDEN_FLAGS` keeps them out of the
listing. Items flagged `unnamed` are real armor whose localization key did not
resolve; they stay visible under their class name.

### Undersuits and the base body

The base GLB ships a default undersuit, so there is a body to look at and a
skinned mesh for the viewer to read the skeleton from. Equipping another
undersuit would stack two layers, so `BaseCharacter` hides the built-in body
whenever that slot is filled. It captures the body meshes once at mount, because
armor pieces are reparented under the same root when they bind and re-traversing
would hide the armor too.

### Extraction is case-sensitive, and that bit

StarBreaker's `--filter` glob matches case-sensitively, while the DataCore spells
the same directory both `Objects/...` and `objects/...`. A lowercase prefix
matched nothing and the extract call still reported success, so four real items
failed conversion much later with "no converted geometry". `tools.path_regex`
builds a case-insensitive, separator-tolerant regex and extraction uses
`--regex` instead. The directory that yielded 0 files by glob yields 182 by
regex.

`Settings.write_errors` merges one section into `errors.json` rather than
replacing the file: catalog and convert both report there, and a catalog re-run
used to erase the convert failures.

### Shading, and why armor looked low-poly

Nothing was wrong with the geometry: pieces convert at LOD0 with 28-40k
triangles, and LOD variants are filtered by name. The problem was normals.
CryEngine hard-surface meshes depend on custom split normals, and **neither the
Collada nor the glTF import brings them across**: a mesh arrives with all
28,138 polygons smooth shaded and no auto-smooth, so Blender averages normals
straight over sharp panel edges. `_common.shade_auto_smooth` keeps edges above
`convert.smooth_angle` (default 40 degrees) hard, and the triangulate step
preserves custom normals where they do exist.

### The base body

The base GLB is built by `build_base_rig.py`, which for a long time never ran
the material pipeline, so the body kept Blender's placeholder materials and
rendered as a flat white mannequin under the armor. `scx rig --undersuit-item`
now passes real material descriptors, the same ones armor gets.

**Hiding the base body needs a coverage test, not the slot name.** Several
records in the undersuit slot are partial: a torso wrap, a necksock. Hiding the
whole body for those leaves a legless torso. Height alone does not separate
them either, since a waist-up piece measured 1.20 against a 1.64 body, or 73%.
What separates them is whether the piece reaches the feet: measured on real
items, full suits start at y=0.00 while a torso wrap starts at y=0.65. The
viewer hides the base only for a piece that reaches both the feet and the chest.

### Poses

`scx poses` retargets standing and crouching poses out of the game's own
animation data. Nothing is hand-authored.

**Where the data is.** The skeleton's `.chrparams` names the animation
databases; for a bare-handed human they are under
`Animations/Characters/Human/male_v7/weapons/no_weapon/locomotion/`:
`stand.dba` with 189 clips, `crouch.dba` with 43, plus `hunch` and `prone`.
Useful frames come from `nw_stand_idle_turn360_planted` and
`nw_neutral_crouch_idle`. Clips suffixed `_add` are additive deltas layered at
runtime and are no use alone.

**Getting it out.** StarBreaker parses `.chr` skeletons and `.dba`/`.caf`
animation but exposes neither on its CLI, so `tools/anim-dump` is a small shim
over its `starbreaker-3d` crate with two commands: `bind` dumps a skeleton's
bind pose, `pose` dumps a clip's final frame. 145 animated bones, every name
resolved by CRC32 against our skeleton.

**Why it is a retarget.** Three approaches, two of which fail:

1. *Copy the local rotations.* Fails. A clip stores absolute local rotations in
   the animation rig's bone frames; ours no longer match after Collada, Blender
   and the glTF exporter. The character ends up on its back. No axis permutation
   fixes this, and seven were tried.
2. *Copy the world orientations*, obtained by running forward kinematics over
   the `.chr` hierarchy. Closer, and the spine and legs land correctly, but the
   arms point at the ceiling: absolute orientation only transfers where the two
   rigs' bone axes agree, and for arms they do not.
3. *Transfer the delta from each rig's own bind pose*, `world_clip *
   inverse(world_bind)`, applied to our rest orientation. This works, because
   "rotate this bone by however far the animation moves it" needs no agreement
   about axes at all. Bone lengths stay ours, so the pose adapts to our
   proportions.

Two details the data dictates. The clip's world space has up along -Y and
forward along +Z, reaching glTF through a 180 degree rotation about X; that was
read off a standing clip putting the head 1.70 above the floor and a crouch
putting the knee forward. And the armature **root is skipped**: it carries the
clip's own world placement, which otherwise drags the whole body a metre
sideways. Feet are then seated on the ground, since the clip is authored against
the game's floor.

Measured result: idle puts the hands at ±0.31 either side at hip height, crouch
drops the head from 1.70 to 0.99 with the knee forward and the foot planted.

One measurement trap: when checking whether a pose differs from rest, capture
the rest from a genuinely unposed skeleton. The viewer applies a pose on load,
so a first attempt captured the posed state as "rest" and reported zero
difference everywhere, which looked like a parsing failure and was not.

### Backdrops

`viewer/src/components/Backdrop.tsx` puts a photographic plate behind the
character, cropped to cover rather than stretched. Lighting still comes from the
HDR environment: a screenshot is a perspective image, not an equirectangular
map, so using it to light the scene would be wrong. The reference grid is hidden
whenever a backdrop is active, since it reads as floating debris over a photo.

Backdrop images live in `data/out/backgrounds/` and are served through the same
`/assets` mount as everything else, which also means they are gitignored like
any other extracted asset.

### Still unverified

- Whether female meshes bind to the same bone names as male ones.
- Only one set has been converted end to end. `scx convert` has not been run
  across the full catalog, so per-item failure rates are unknown.
- The socket bone is chosen from a per-slot table rather than read from the
  CDF's `CA_BONE` entry, which carries the real `BoneName` and relative
  transform. Fine for backpacks; other rigid pieces may need the CDF.
- 12 of 41 complete sets are converted. Running the full catalog through
  conversion has not been attempted, and Collada intermediates are large.
- 93 items with unresolved localization keys, and some placeholder junk in the
  catalog (`<= PLACEHOLDER =>`, `Body`) that should be flagged and hidden.
- 331 items have no manufacturer code.

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
