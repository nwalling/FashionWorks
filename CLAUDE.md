# CLAUDE.md — working instructions

## What this is

A Star Citizen FPS-armor kitbasher. Pipeline:

```
Data.p4k -> catalog (JSON) -> geometry/textures -> Blender normalize -> .glb + manifest.json -> React/Three.js viewer
```

`LIGHTING.md` holds a deferred plan for the viewer's lighting model.
`WEB.md` holds the plan for a public web front end on sc-hangarworks.org.
`WEB-INTEGRATION.md` is the contract the Hangarworks site builds against.

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
- **Swapping does not leak, on repeat.** Renderer geometry count rises while the
  `useGLTF` cache fills, then holds flat across hundreds of swaps, with tint
  changes interleaved. Only the handful of geometries actually in the scene are
  live; the rest is the cache, which is what makes swaps instant. Median swap
  latency is ~17 ms (one frame). Re-measure with `window.__kitbasher.gl.info`.
  This holds for swapping *between items already loaded*. It says nothing about
  the cost of each new one, which on real assets is 13.6 MB retained forever --
  see "The GLB cache needs a byte budget" below.
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

**The blend mask is a hard-edged layer selector, not a soft gradient.** Four
saturated colours cover 96% of a real armour mask. Which colour reaches which
layer took four attempts; the settled mapping and the evidence for it are under
"The blend mask table, settled on the fourth attempt" below. The figures that
used to sit here described the first, refuted attempt.

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

### Layer colour comes from Diffuse and Specular, not the folder (2026-09-14)

Chasing why armour rendered lighter than the game shows it turned up two
errors in how a detail layer's colour was read. Neither was the cause -- that
was the material-slot bug above -- but both are wrong on their own terms.

**A dielectric's colour is its `Diffuse`.** 168 of 317 dielectric layers set it
to something other than white and 46 set it below 0.5, and it was being ignored
entirely, so those rendered at full brightness.

**A layer is metal by its own reflectance.** `LayerMaterial.is_metal` takes
`Specular` above 0.2, or a black `Diffuse` with any real reflectance, which is
CryEngine's signature for bare metal and catches near-metals like
`weapon_bare_120` sitting at 0.188. The old rule keyed on the layer living
under `Materials/Layers/metal`, which misses the whole `metallic/` category
(that path does not contain `/metal/`) and promotes the 24% of `/metal/`
entries that are dielectric by their own numbers.

Measured on the Defiance torso both rules produce **identical** output, because
its metal layers qualify under either test. They matter elsewhere in the
catalog, not there.

**What is left is lighting, not materials.** Sweeping the environment showed
the armour reading close to the in-game reference at `scene.environmentIntensity`
around 0.25 with the lights at 40%, and unchanged in hue throughout. The scene
stacks a full IBL, a directional light at 1.1 and an ambient at 0.25, which is
considerably brighter than the game's dim hangar. This has not been changed;
it is a viewer default, not a data problem.

**Defiance legs really do use a CDS mesh.** `Defiance Legs Tactical` pairs
`m_cds_heavy_armor_01_legs.skin` with `m_slaver_heavy_armor_legs_01_01_01.mtl`,
and no slaver legs mesh exists in the archive. Only 27 of 2103 items pair a
mesh and material from different family folders, and they are genuine reuse.
Do not "fix" this.

### Decals and the Detail map are inert on armour -- both closed

Both were chased as "the missing texture layer". Neither is implementable, and
more importantly neither is *wanted*. Do not reopen either without new evidence.

**Decals (TexSlot9), declared by 5599 of 11436 layer-blend submaterials.**
Compositing them lifts the gold region's luminance std from 13.4 to 36.9, so the
temptation is real. Four independent findings say no:

* No armour mesh has a second UV set. Sampling 25 `.skinm` files across 15
  manufacturers with `SB_DEBUG_STREAMS=1`, every one carries exactly
  `IVOVERTSUVS` at elem_size 20 and no `IVONORMALS2` at elem_size 4 and no
  `IVOVERTSUVS2`. StarBreaker parses secondary UVs and its GLB writer emits
  `TEXCOORD_1` when they exist, so this is the mesh, not the tooling.
* The atlas is not in UV0 space. Decal alpha landing inside the union of a
  piece's UV islands is **5.8%** where the islands cover **5.6%** of the square
  -- an enrichment of **1.04x**, which is chance.
* There is no decal geometry: zero `.skin`/`.cgf`/`.cga` matching *decal* in the
  whole male armour tree.
* **The in-game reference shows no decals on the piece.** A user photograph of
  the real Sunchaser shoulder pad has none of the atlas's text on it.

Sampled on UV0 anyway, it renders metre-high "WARNING" and "DEFENSE SYSTEMS"
across the chest. That was implemented, rendered and reverted.

**The Detail map.** `DetailDiffuse`, `DetailBump`, `DetailGloss` and
`DetailTiling` appear on 475 of the 495 layer materials, but they are template
defaults, not authored intent: 458/495 sit at `DetailDiffuse=0.5`, 450/495 at
`DetailTiling=8`, 458/495 at `DetailGloss=0.5`. And **no detail texture is
bound** -- TexSlot7 appears on exactly one layer material in 495
(`weapon_parkerized_02`, pointing at `textures/unified_detail/metal/metal_006_detail.tif`).
A `unified_detail` library of 66 textures exists but almost nothing references
it. With no texture bound the parameters do nothing.

So the flatness of a painted plate is faithful to the source. `paint_01`'s own
diffuse texture has a std of **2.8** and its `_ddna` is a flat (127,127,254) at
std 2.3. Surface interest comes from the wear blend and the armour's own `_ddn`
(std 30/24/18), not from the layer and not from a detail map.

### TintMode declares metal -- but mode 0 declares nothing

`PublicParams TintMode` on a layer material takes three values: **0 (144
layers), 1 (201), 2 (130)**. Modes 1 and 2 are the artist stating the shading
outright -- mode 1 is 3% metal by reflectance and is fabric, canvas, fleece and
paint; mode 2 is 96% metal and is aluminium, steel and bronze. That is exactly
what `LayerMaterial.is_metal` was inferring, so the stated value now wins. The
two disagree on 70 of 475 library layers, among them `anodized_white_metal_01`
(specular 0.061, diffuse 1.0) and `burnt_metal_02`, which read dielectric and
are declared metal.

**Mode 0 is not a statement, and reading it as one caused a regression.** It was
taken to mean "this layer is not tinted", which is wrong: `rubber_diamond_02` is
mode 0, and every Venture undersuit colourway authors a *different* TintColor on
it -- (54,31,79) on the purple, (210,210,210) on the base, (57,57,57) and
(153,153,153) elsewhere. If mode 0 discarded the tint, every colourway would be
identical on those layers, which is the whole point of the colourway system.
Discarding it forced **1185 of 43576 armour layer references (2.7%)** to white
and baked **12 of the 28 Venture undersuits flat near-white** -- Tan/Brown at
(220,220,219), Olive/Black at (222,222,220), Green/Black at (223,224,223), none
of which has a white layer.

Mode 0 says nothing about metalness either, so it falls through to the
reflectance heuristic rather than asserting dielectric.

The general lesson: an enum value that is merely *absent of a claim* is not the
same as a claim of the negative. Check what varies underneath it before acting
on it -- here, the per-colourway TintColors settled it in one query.

### A metal layer's diffuse texture is pattern, not albedo

**77 of the 208 metal layers carry a TexSlot1 diffuse texture**, and multiplying
it into the base colour scaled the metal's reflectance down by that texture's
own mean. On `anodized_black` -- spec 0.254, `polished_surface_01_diff` at 0.235
linear -- a sleeve the artist tinted (189,189,189) composited to
0.509 x 0.254 x 0.235 = 0.030, or **sRGB 50**. Near-black, on a light grey
garment. That is the "shiny black where it should be matte" symptom, and it is
independent of the blend-table bug even though the two compound.

These layers set their material `Diffuse` constant to **black (0.013)**, which
is CryEngine's own signature for metal and says outright that there is no
diffuse term for the texture to be. The colour is the F0 in `Specular`; the
texture is brushed/scratched/polished surface pattern. So it is normalised to
its own mean and modulates around 1.0, which keeps the detail without the
darkening. `aluminum_dirty`, which ships no diffuse texture at all, is the shape
the docs describe and was never affected.

Dielectrics are unchanged: their texture genuinely is albedo.

### A palette entry has two colours, and a metal layer takes the specular

A tint palette entry carries a tint colour *and* a specular colour. The
composite read only the first, which is right for a dielectric and wrong for a
metal: a metal has no diffuse albedo, so its appearance **is** its F0. The
entry's specular is that F0, and its tint colour says nothing.

**The Lynx arms settle it, because they have nothing else.** All four base
layers of `gauntlets_m` sit on `iron_scratched_*` with `TintColor` white and
`PaletteTint` 1/2/3, every colourway names the same `.mtl` and the same
geometry, and the whole colourway lives in the palette specular:

| colourway | entryA colour | entryA **spec** |
| --- | --- | --- |
| Red | `#ffffff` | `#ff0000` |
| Orange | `#ffffff` | `#ff7d03` |
| Yellow | `#ffffff` | `#ffd303` |
| Green | `#e3e3e3` | `#0a921c` |
| Seagreen | `#e3e3e3` | `#00ffaa` |
| Blue | `#e3e3e3` | `#0314fd` |
| Purple | `#e3e3e3` | `#7703ff` |
| Violet | `#e3e3e3` | `#ee01ff` |

Reading the colour rendered ten Lynx colourways as the same grey arm, and the
five that differ *only* in specular came out pixel-identical -- hue EMD exactly
0.0000 between Blue, Green, Purple, Seagreen and Violet. The internal control is
that Aqua and Olive, which carry their hue in the tint colour (`#39615a`,
`#4a3e2c`) with a neutral spec, always rendered correctly.

**Confirmed against CIG's own studio renders**, not inferred: the cstone
reference shots of Lynx Arms Blue/Green/Red/Yellow show exactly the hue the
specular predicts, on a steel arm whose other three layers take the neutral
entryC spec, which is what the mask coverage predicts too.

**Scope.** 1154 of 6275 palette-tinted base-layer references in the male armour
tree are metal (18.4%), so this is not a corner. 46 items were rendering
identically to a sibling purely from this -- the Lynx arms, the Oracle helmets,
the Stirling Exploration backpacks among them.

**Regression-checked against every piece this file already validated**, by
baking each twice and diffing per submaterial: Defiance Core Sunchaser, Beacon
Undersuit Orange and Odyssey II Undersuit Tan/Black are bit-identical, 0 of 5,
7 and 12 submaterials changed. Corbel Halcyon moves slightly and stays plainly
yellow (`core01_m` 173,127,0 -> 151,113,14). Emulate the old behaviour for such
a diff by passing a palette whose `spec` is set to its `color`; that is exactly
what the previous code did.

### cstone.space is a reference corpus, and its ids are ours

`finder.cstone.space` keys every item by the **same GUID the DataCore uses**, so
it joins to `manifest.items[].id` exactly -- no name matching. 2402 of our 2615
items are in their index, and `https://cstone.space/uifimages/<id>.png` is a
reference photo for about 78% of those. Their item pages also carry the class
name, and their names disambiguate 134 of our duplicate display names, including
some we have as `unnamed` (`doom_combat_medium_arms_01_01_01` is "Clash Arms").
There is no index route -- `/FPSArmors1/` is a 404 -- but `GET /GetSearch`
returns the whole 7807-item list as JSON.

**Most of those images are player screenshots, not studio renders, and that
limits them.** Only about 3% have a uniform dark background; the rest are shot
in hangars with machinery, signage and coloured lighting in frame. Scoring a
reference against its *own* name, which should be easy, gives a median named-hue
mass of 0.62 on the studio subset and 0.19 on the rest -- and blue scores 0.95
because hangars are blue-lit while olive and gold score 0.01. So the cluttered
ones are for eyeballing a suspicion, never for an automated verdict. Segment on
a uniform dark border before trusting one.

**Compare in hue, not luminance.** Our viewer runs about twice as contrasty as
these references (Odyssey II Tan/Black: light/dark median ratio 4.48 against the
reference's 2.27, matching the 4.09-vs-2.48 gap already recorded for Sunchaser),
so any luminance comparison flags every item. HSV hue and saturation are ratios
of channel extremes and survive that gap intact; that is why the comparator in
this work is built on them. A first eyeball reading of Odyssey as a tan/black
*inversion* was wrong -- measured, we render **more** light area than the
reference (35% against 25%), and the excess contrast was crushing mid-tan to
near-black.

### Stray weight goes to the vertex's own bones, not one bone per mesh

Pieces floated off the body: a bracelet on the Defiance arms, a left
shoulderpad on the Antium set. `rebind` moved *all* stray weight to a single
dominant bone chosen for the whole mesh, so mirrored geometry was flung across
the body. The Defiance arms sent 1828 vertices to `LeftForeArm`, the right
wrist cuff among them; the Antium arms sent 8037 to `RightArm`, including the
left shoulder.

Stray weight is now redistributed to each vertex's own surviving bones,
renormalised, which is right whenever a cuff is also weighted to the forearm.
Only a vertex with no surviving bone needs a guess, and that one prefers a
same-side bone sharing a word, then the busiest bone on that side, then the
mesh's dominant bone.

**Side is the reliable signal, not the words.** Anatomy names barely overlap:
nothing in `LeftWrist_CuffTwist` matches `LeftForeArm`. Tokenising has to split
camelCase as well as separators, or `LeftWrist` stays welded together and
matches nothing.

### Sunchaser, measured on screen against the in-game reference

Both figures measured the same way, as a percentage of lit body pixels:

| region | in-game | viewer |
| ------ | ------- | ------ |
| core / torso | 24.5% | 25.5% |
| helmet | 50.1% | 52.9% |
| arms | 8.9-11.8% | 2.9-3.3% |
| legs | 5.3% | 14.2% |

**Core and helmet are right, so the palette index mapping is not globally
wrong.** If `PaletteTint 1 -> entryA` were off by one, every piece would be
wrong together, and two of the four match to within a point.

What is wrong is per material: the arms carry about a third of the gold they
should, and the legs nearly three times too much. The legs were 0% before the
slot-matching fix, so that fix moved them in the right direction and overshot.

Measure this on screen, not on the texture atlas. An atlas fraction counts
unused UV space and is not comparable to what the eye sees: the arms read 7.7%
of their atlas but only 3% of their silhouette, which is the difference
between "slightly low" and "clearly wrong".

### The shader parameter block does not select the palette entry

Checked exhaustively, because it was the last plausible hiding place. Every
`PublicParams` attribute used anywhere in the armour tree was enumerated: 200
of them, and the only palette-shaped one, `ETintModeType`, appears on 8
MeshDecal materials and is always 0.

More decisive: `core_plate_m`, which matches the reference, and
`biceparmor_m`, which does not, have **byte-for-byte identical**
`PublicParams` and identical Material attributes -- same shader, same flags,
same `StringGenMask`. Nothing there distinguishes them. The answer is not in
the shader block.

### The palette modulates a layer's TintColor, it does not replace it

966 of 1984 palette-tinted base layers carry a **non-white** `TintColor`,
median 0.50. Substituting the palette colour for it, rather than multiplying,
rendered half of them up to twice as bright as the game.

### Compare contrast, not absolute luminance

Two in-game captures of the same armour disagree on absolute brightness
because their scenes differ: the Sunchaser reference reads a non-gold median of
32.7 on one sheet and 42.3 on the store render. Absolute comparisons against a
viewer tuned to a third capture are therefore meaningless.

The lighting-invariant measure is the ratio of gold median to non-gold median
within one image:

| source | ratio |
| ------ | ----- |
| reference, user sheet | 3.47 |
| reference, store render | 2.95 |
| viewer, before the blend-table fix | 2.33-2.55 |
| viewer, after | **3.81** |

Use this ratio for any future comparison, and measure it against a real
silhouette: masking the body by "brighter than the backdrop" counts the
backdrop too and reported 4% gold over 442k pixels where the truth was 17.5%
over 105k. Render the scene twice, once with the armour hidden, and take the
pixels that changed.

The blend-table fix moved the ratio from 25% under the reference band to about
10% over it, so the residual is now non-gold being slightly too dark relative
to gold rather than much too light. That is a smaller and opposite error.

### The blend mask table, settled on the fourth attempt

**The mapping.** A splat: a ground layer with blue, green and red lerping over
it in that order, highest channel winning, and the layers **numbered from the
top** -- the natural reading reversed.

| mask | layer | | mask | layer |
| --- | --- | --- | --- | --- |
| black (ground) | BaseLayer4 | | red | BaseLayer1 |
| blue | BaseLayer3 | | magenta | BaseLayer1 |
| green | BaseLayer2 | | yellow | BaseLayer1 |
| cyan | BaseLayer2 | | white | BaseLayer1 |

**Derived on Corbel Halcyon, confirmed on references it was not fitted to.**
That order is what makes this attempt different from the three before it.

* **Corbel Halcyon** (OMC utility heavy). Yellow exists only as palette entry A,
  so every yellow pixel needs a PaletteTint=1 layer. The third table sent the
  mask's ground -- 80% of the helmet mask, 76% of the core's -- to BaseLayer2,
  which is `steel_dark_01` on palette C and `gun_metal_03`, so the helmet shell
  and upper chest rendered black where the game shows yellow, and the yellow
  landed on the faceplate and a stripe down the core instead. The whole Corbel
  lineup was inverted the same way.
* **Sunchaser back, blind.** Upper back gold on CIG's store render **33.0%**;
  this table **32.9%**, the third table 20.3%. Waist and legs are identical under
  both, as they should be.
* **Sunchaser shoulder pad, preserved.** Its mask has blue on for 99.9% of the
  pad and green off, so red alone chooses: red -> BaseLayer1 gold frame, blue ->
  BaseLayer3 grey interior. No ground or green appears on the pad.
* **Beacon Undersuit Orange, blind.** The ground region is the sleeves. On
  BaseLayer4 they come out the dusky mauve-brown (123,92,89) the reference
  shows; on BaseLayer2 they were glossy black anodized metal.

This also fits the colourway structure better: BaseLayer4 carries an item's
*second* colour, and it now lands on the large secondary region (Beacon's
sleeves) rather than on small green details.

**Four readings are refuted. Do not try any of them again:**

| reading | why it fails |
| --- | --- |
| ground -> BaseLayer2, green -> BaseLayer4 (third) | Corbel inverted; Sunchaser back 13 points short; Beacon sleeves black |
| blue -> BaseLayer1 (second) | inverts the Sunchaser shoulder pad |
| ground -> BaseLayer1, magenta -> BaseLayer4 (first) | Beacon body in anodized metal: grey, 59% metallic |
| plain blue <-> magenta swap | pad interior on a light rubber (204,204,204) where the reference is charcoal |

**Method, which matters more than the table.** The first two attempts were fitted
to a single aggregate figure on the slaver torso, which cannot discriminate: it
carries near-black paint on BaseLayer1 (0.0395), BaseLayer2 (0.0382) and
BaseLayer4 (0.084) alike. The third was fitted to located regions on two pieces
and still wrong, because neither piece exercised the ground-vs-green choice. So:

1. Bake candidate tables for every submaterial of a set with
   `tint.compose_layered`, monkeypatching `BLEND_BUCKETS`.
2. Swap the baked albedo and ORM onto the live materials by name, and render the
   **current table first as a control** -- it must reproduce the bug report.
3. Compare against a reference image, then **confirm on a different piece and a
   different reference** before committing. Measure banded gold fraction against
   a silhouette diff, not by eye.

All submaterials of one piece share a single blend mask, so a whole-atlas bucket
histogram is not a per-submaterial coverage; weight by the submaterial's own
triangles or read it off a render.

**CIG's store renders are the best reference available**, far better than a
screen grab: `~/Downloads/Buy CDS Defiance 'Sunchaser' Armor Set ... _files/source*.webp`,
five 1820x1024 images, the fifth showing the back. Measured off them: torso
36.0% gold, upper back 33.0%, gold median (190,136,49), gold-to-non-gold
contrast 2.48.

### A colourway names BaseLayer3, and BaseLayer4 is its second colour

Read across the 14 named Beacon colourways and the roles are unambiguous:
BaseLayer1 and BaseLayer2 are frozen neutrals -- (125,125,125) and (65,65,65)
in 12 of 14 -- while **BaseLayer3 carries the colour in the item's name**
(Crimson 164,43,43; Yellow 239,215,33; Purple 94,74,138) and **BaseLayer4
carries the second** (Green/*White* 255,255,255; Grey/*Aqua* 132,226,223;
Tan/*Brown* 139,115,90).

This is the cheapest discriminator available for any layer question: take a
family of colourways, and the layer whose TintColor tracks the name is the one
the artist meant as primary. It needs no render and no in-game capture.

### PaletteTint is an absolute index, not a rank -- tested and settled

The suspicion was that `PaletteTint` might be a rank among the indices a
submaterial actually uses, rather than an absolute palette entry. 283 armour
submaterials use index 2 or 3 without ever using 1, and reading those as
"primary" would have turned the Sunchaser bicep plate gold.

`Chiron Legs AA Support` discriminates cleanly: its material uses only indices
2 and 3, and its palette's primary is a bright `#ea2d40` red. UV-weighted
prediction was **0.0% red as an absolute index, 49.5% as a rank**.

The in-game set shows the legs **charcoal, with no red at all** -- the red sits
on the core, arms and helmet. The absolute index is right and the rank reading
is wrong. Do not revisit it.

This also means the Sunchaser arms shortfall (about 3% gold rendered against
9-12% in game) is not a palette-index fault. It is smaller than it first
looked, and the store renders show the arms are mostly dark with gold confined
to the shoulder pauldron and one forearm plate.

### Ruled out while chasing the Sunchaser arms

Worth recording so nobody spends the time again.

* **`SwizzleOverride` is null on every armour record** (0 of them set it), so
  palette channels are not remapped per reference.
* **`ChildPath` is empty and the palette tree has no children.**
  `slaver_heavy_01_01_03` is a single root holding
  `['#f9b541', '#5e5e5c', '#575757']`, so there is no per-submaterial palette
  variant to look up.
* **The blend channel order is confirmed.** Summed over the core's
  submaterials, entryA coverage is 1.152 under the current
  blue-then-green-then-red order and 0.050 reversed, and the core is the piece
  that matches the reference.
* **The `_hal` hue channel is flat neutral**, and only 11 armour submaterials
  enable the HUE flag at all.

### The arms shortfall, measured

`arm_coated_metal_m` is 56.6% of the arms mesh and carries gold on 8.6% of its
own UV footprint, contributing 4.9%; the render shows 3.1% and the game 8.9 to
11.8%. The gap is `biceparmor_m`, 32.5% of the mesh and plainly gold in the
reference, whose palette-tinted layers sit on `PaletteTint` **2 and 3** -- both
near-identical greys in this colourway.

So for the arms to look right, index 2 would have to reach the gold entry;
but the core matches the reference precisely with index 1 reaching it. Both
cannot hold under one global mapping, and nothing in the record distinguishes
them. That contradiction is the open question, and it is not answerable from
coverage measurements alone.

### A record name is not unique across types

165 items resolved a palette reference to the wrong record. The VGL Warden
backpack ships an entity and a tint palette both named
`vgl_combat_heavy_backpack_01_03_01`, and `Index.by_class` kept whichever
loaded first, so `tint_for` got an entity, found no `root`, and returned a
palette ref with no colours. `Index.resolve_ref` now takes `record_type`, and
`tint_for` asks for `TintPaletteTree`. Palettes resolving went from 1237 items
to 1402, and backpacks without one from 85 to 52.

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

### Binding must put meshes back where it found them

Equipping a torso made the backpack disappear, permanently. Binding
reparents meshes out of the cloned GLTF scene and under the base character,
and `detach` only removed them, leaving the clone empty. The next bind
traversed that clone, found no meshes and attached nothing -- silently. It hit
socket pieces because their bind effect re-runs whenever the torso changes the
mount offset. `binding.rememberOrigin`/`restoreOrigin` record each mesh's
parent and local matrix at bind time and put it back on detach.

The same fault was latent for skinned pieces; their effect just did not re-run,
because only `offsetKey` was changing.

### Match material slots by name before falling back to position

`apply_materials` assigned descriptors in one pass, taking a name match when
there was one and the descriptor's ordinal otherwise. That let an unmatched
descriptor take, by position, a slot that a later correctly-named descriptor
needed.

The Defiance legs are the case. The mesh is CDS, with slots `pads_straps_m`,
`clips_m`, `thighs_m`, `shoes_m`, `sole_m`, `thigh_panels_m`, `glows_m`. The
.mtl the record names is a whole-body **slaver** material that lists
`shoulderpads_m`, `arm_base_m`, `arm_exo_m`, `gloves_m`, `collar_m` and
`torso_base_m` in between the leg entries. So `shoulderpads_m` took the
`clips_m` slot, `arm_base_m` took `thighs_m`, and by the time the real
`thighs_m` descriptor came round its slot was gone. Arm and collar materials
were painted onto leg geometry, and the leg materials -- including the
palette-tinted gold accents -- landed on nothing.

Name matches are now assigned first and leftovers fill whatever slots remain.

Reusing one whole-body .mtl across separate meshes is normal here, so the
descriptor list routinely contains submaterials a given mesh does not use.
Positional assignment is only ever a guess; names are the real key.

### Open: the backpack shell takes the wrong palette entry

With the palette now resolving, the CSP-68H Red Alert renders red on its trim
and grey on its shell, where the game shows the shell red. `backpack_01_m`
puts `PaletteTint=2` on the layer covering roughly half the surface and
`PaletteTint=1` on the next, so the shell takes entryB (`#3d3d3d` grey) rather
than entryA (`#bf2628` red).

This reopens the index-to-entry question in a way the earlier test did not
settle. That test showed entryA is the *primary* colour, in 81% of named
colourways, and that stands. What it did not show is that `PaletteTint 1` is
the index pointing at it. This backpack argues the dominant layer should be
entryA, which would make the mapping off by one. Catalog-wide coverage does
not adjudicate: indices 1, 2 and 3 cover 31%, 30% and 38% of palette-tinted
area, which is too even to call. Do not "fix" this by guessing; it needs a
piece whose in-game appearance is unambiguous and whose blend mask is
understood.

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

### Lighting is matched to an in-game capture (2026-09-14)

Measured against a capture of Defiance Tactical with an Artimex helmet. Over
the torso the game reads **mean 34, median 29, 95th percentile 68**: dark, and
more to the point flat.

The scene used to stack a full image-based light at full strength with a 1.1
directional and a 0.25 ambient, giving mean 67, median 52, p95 157. Now
`Scene.ENV_INTENSITY` 0.25, `EXPOSURE` 0.85, directional 0.15, ambient 2.2,
which lands mean 33.6 and median 28.1.

**Ambient was the knob, not exposure.** The problem was the width of the tonal
range, not its level: lowering exposure matches the highlights but crushes the
midtones, and lowering the environment does both at once. Ambient fill lifts
the darks without adding highlights, which is what reads as matte. A sweep over
environment, directional, ambient and exposure confirmed no combination of the
first and last alone gets there.

**p95 still sits near 89 against 68, and no lighting value fixes it.** That
residual is specular response and wants lower metalness or higher roughness in
the bake. Left alone deliberately rather than compensated for in the lighting.

### Palette index ordering is correct: PaletteTint 1/2/3 -> entryA/B/C

Tested, because the legs rendering lighter than the game made the mapping a
suspect. It is not the cause.

**entryA is the primary colour.** Across 48 colour variants whose palette
genuinely differs from their canonical sibling's and whose name states a colour
that is really present in the palette, the named colour sits in **entryA 81% of
the time, entryB 18%, entryC never**. A colourway is named for its primary, and
primary is index 1, so 1 maps to A.

Two traps in running that test. Sampling every item whose name states a colour
gives a meaningless 49/28/22 split, because families like ADP ship Blue, Red,
Green and Purple variants that all carry the *same* palette -- their colour
comes from a `mtl_var` material, not the palette. And the named colour has to
actually be in the palette, not merely the closest of three greys.

**Surface coverage does not discriminate.** Across 969 submaterials the
palette-tinted area splits 31% / 30% / 38% between indices 1, 2 and 3, which is
too even to argue either way.

**Permuting the mapping changes nothing measurable** on the piece that prompted
the question: baking the Defiance legs with 1->A and again with 1->C gives a
mean albedo of 69.9 both times, because only **3 of that material's 52 base
layers are palette-tinted at all**.

### Why the Defiance legs are lighter than the game shows

Not the palette. The material's own baked `TintColor` values decide it, and
they are light: untinted layers run from 0.032 to 0.468 linear with a median
around 0.069, and three submaterials carry `(0.376, 0.376, 0.246)`, which is
the olive that reads on the thighs. Whether the blend mask really gives those
layers as much area as the composite does is the open question, not the
palette.

### A colour group is not named after one of its members

The twenty-one Odyssey II undersuits used to appear as "Odyssey II Undersuit
Alpha" with the other twenty as swatches under it. Alpha is a colourway in its
own right, and the game lists all of them as separate items, so titling the
group with whichever member happened to be canonical made one stand in for the
rest. `SlotPanel.sharedName` titles a group with the words its members' names
actually share, and `colourwayName` shows what distinguishes the selected one.

Checked at the same time, since it was the other suspect: tinting is **not**
applied twice. Every material on an equipped variant carries `color` at
`#ffffff` with a single swapped map, so the colour arrives once, from the
texture. The flat palette multiply that used to sit on top is gone.

### Backdrops

`viewer/src/components/Backdrop.tsx` puts a photographic plate behind the
character, cropped to cover rather than stretched. Lighting still comes from the
HDR environment: a screenshot is a perspective image, not an equirectangular
map, so using it to light the scene would be wrong. The reference grid is hidden
whenever a backdrop is active, since it reads as floating debris over a photo.

Backdrop images live in `data/out/backgrounds/` and are served through the same
`/assets` mount as everything else, which also means they are gitignored like
any other extracted asset.

### The GLB cache needs a byte budget (2026-09-14)

Swapping really is free *on repeat*, exactly as the 2026-09-13 note says. What
that note could not see, because it was measured on 30 synthetic placeholders
with trivial geometry and no textures, is that the cache never releases
anything. On real assets the first sight of an item costs **13.6 MB and keeps
it**.

Measured by equipping 12 different helmets, one slot, one visible mesh at a
time:

| swaps | geometries | textures | JS heap |
| --- | --- | --- | --- |
| 0 | 13 | 9 | 56 MB |
| 6 | 19 | 26 | 116 MB |
| 12 | 25 | 44 | 220 MB |

Linear, never plateauing. At that moment the scene held **2 meshes, 1 skeleton,
3 draw calls** -- so 23 of those 25 geometries belonged to helmets that were no
longer in the scene at all. The binding is not what grows; the cache is.

The catalog has **471 distinct GLBs** (helmet 138, torso 91, arms 83, legs 81,
undersuit 47, backpack 31), averaging 7.3 MB on disk and about 1.8x that
resident once decoded. Browsing all of them wants ~6.4 GB against a 4.19 GB tab
limit, so the tab dies around **304 distinct items, roughly two thirds of the
way through**.

`viewer/src/three/gltfCache.ts` puts a ceiling on it: a byte budget over the
`useGLTF` cache, evicting least-recently-used GLBs. Default **768 MB**, about 25
items. With it, 30 swaps hold flat at 25 entries, 741-766 MB, 38 geometries and
77 textures, and repeat swaps stay instant.

Two things make eviction safe, and both are load-bearing:

* **Equipped pieces are pinned.** `ArmorPiece` reparents *clones* that share
  geometry, materials and textures with the cached original, so a piece on
  screen still owns its cache entry. A full loadout reports `pinned: 6`.
* **The `retain` effect is declared last in `ArmorPiece`.** React runs cleanups
  in declaration order, so release happens *after* the bind effect's `detach`
  and after the tint effect restores the shared materials. Declared earlier, it
  would dispose geometry still parented into the scene.

`useGLTF.clear()` only drops the suspense entry and frees no GPU memory, so the
module disposes textures, materials and geometries itself before clearing.
Size is measured from the decoded buffers, not the file, because that is what
stays resident. `window.__gltfCache` exposes `stats()` and `setBudget()` in dev.

### One colour drag was 40 undo steps (2026-09-14)

`setTint` ran through `withHistory` on every `onChange`, and a colour picker
fires those continuously while dragged. One gesture produced **40 history
entries** against a `HISTORY_LIMIT` of 50: the whole undo stack gone, and 40
undos needed to reverse one drag.

The store never sees a `pointerup`, so the gesture boundary is inferred from the
gap between events (`TINT_COALESCE_MS`, 600 ms). Coalescing on the item key
alone was not enough -- every drag of one swatch for the rest of the session
folded into a single undo step, which is worse than the bug. Now 75 tint events
across three gestures produce three entries.

### Object URLs cannot be revoked on the next line (2026-09-14)

`exporters.download` revoked the blob URL immediately after `anchor.click()`.
`click()` only queues the navigation; the browser takes its reference after the
event is dispatched, so the URL could be gone before the download started. The
combined GLB is the one that loses that race -- a six-piece loadout exports at
**43.3 MB**. Revocation is deferred by `OBJECT_URL_TTL_MS` (60 s), and the
anchor is appended to the document first, because Firefox ignores `click()` on a
detached anchor.

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
  `window.__store`. That is how the swap-leak and latency numbers above were
  measured. Both are stripped from production builds.
- Geometry and materials are shared with the `useGLTF` cache. Only geometry that
  `binding.ts` cloned for a skin-index remap may be disposed *by the viewer*.
  Everything else is owned by `three/gltfCache.ts`, which disposes a whole GLB
  when its byte budget evicts it, and never one that a mounted `ArmorPiece` has
  pinned.
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
component. **Public deployment of asset URLs is gated on a review of CIG's fan
content policy** (PLAN.md §0, §6) and has not been done.
