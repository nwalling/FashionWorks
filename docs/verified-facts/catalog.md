# Catalog and archive

What the game archive's records look like and how the catalog reads them: record shape, slots, geometry trees, names and localization, lookups and extraction.

### Verified against real game data

Build **1.0.191.55227** (`sc-alpha-4.10.0-hotfix`, 3 Sep 2026), a 158 GB
`Data.p4k`. A full catalog run takes about 17 seconds and yields **2475 items**
(708 helmet, 474 torso, 459 arms, 469 legs, 143 backpack, 222 undersuit),
594 canonical plus 1881 colour variants across 210 sets, every one with real
geometry, **0 flagged `no_geometry` and 0 duplicate class names**.

**Rebuilt against 4.10.1 (2026-09-24)**: build **4.10.193.11644**
(`sc-alpha-4.10.0`, 15 Sep 2026), 160.5 GB, on the GENIUS share mounted at
`/Volumes/SC Data`. **2486 items**, 11 more than 4.10.0 and none removed,
renamed or re-meshed; between the two archives, 1 of about 163,000 character,
weapon and layer entries changed size and 437 were added. The new pieces are
the Artimex Akuma arms and legs, Monde Streamline, Shogun Kiba Akuma, a
Skullcap helmet, a Warden Streamline pack and a ForceFlex Skeleton undersuit,
plus `qrt_specialist_medium_core_03_01_01`, which has no name in the build's own
table. **A new archive must replace every cache built from the old one**: the
DCB export was written over rather than replaced, so a record the new build
dropped would have survived as a phantom item, and `global.ini` was extracted
once and kept, which came out as the new pieces all `unnamed`. Both now carry
the archive's key (`dcb.archive_key`) and are rebuilt when it changes.

These are the figures after the phantom-record fix below and the variant-linking fix
in `variants.md`, both of which change the counts. An earlier reading of 2615 items in 165
sets included 140 tint-palette records that are not items at all, and grouped
eleven pieces spanning two product lines as one colourway family.

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

  Later superseded: the canonical armature now carries the override bones, so
  Option A works. See "Option A is restored, but only because Blender does the
  remap" in `pipeline.md`.

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

### A material references a .tif and the archive ships a .dds

Every entry in the detail library names its textures as
`textures/layers/natural/leather_01_diff.tif` -- the artist's source file. What
is in the P4K is the built `.dds`. Looking the path up as written finds nothing,
**silently**, and the composite then runs with no layer textures at all: flat
tinted plates that look plausible and carry none of the surface detail.

`find_asset` retries with the extension swapped to `.dds`.

### Looking an asset up by scanning is the difference between 2s and 20s

`find_asset` normalised both sides per comparison -- two `String` allocations
against each of **1,365,842 entries** -- and a split DDS resolves about
**eighteen** of these, one per mip stream, on top of the lookup for the texture
itself. A piece wants a dozen textures.

Measured on the Sunchaser core, scan against a `HashMap` built once:

| | scan | indexed |
| --- | --- | --- |
| helmet, 5 surfaces | 15,162 ms | **1,490 ms** |
| core, 5 surfaces | 19,586 ms | **485 ms** |
| texture decode, total | 23.9 s | **1.6 s** |
| mesh load | 1,218 ms | 206 ms |

Range reads are identical at 285, so none of this was I/O. `Archive::by_path`
is a `OnceCell` built on first lookup; `ArchiveSiblings::read_sibling` goes
through it too, which is where most of the eighteen went.

### The catalogue held 140 phantom items, from tint palettes

`catalog.build` iterated **every record in the DCB export**, and the export
carries `**/tintpalettes/**` because the palette lookup needs it. A palette is
named after the piece it colours, so `slot_for`'s class-name fallback matched
`ccc_combat_medium_armor_01_02_01` (`_arm` -> arms) and even
`Tint_LootContainer_Generic_Legendary`, and turned 140 `TintPaletteTree`
records into catalogue items with no geometry, no materials and no name.

**75 of them duplicated the class name of the real item they colour**, which
matters beyond the count: anything keyed on class name -- `_material_by_class`,
the audit's `check_distinct_names` -- was working against a list with 75
collisions in it.

The build now skips any record whose `record_type` is not
`EntityClassDefinition`. Only entities describe an item; everything else in the
export is there to be looked up. Rebuilt, the catalogue is **2475 items with 0
`no_geometry` and 0 duplicate class names**, against 2615 with 140 and 75.

**Why it survived so long:** the viewer requires `assets.glb` as well as the
flags, and a phantom has no GLB, so nothing was ever visibly wrong. It surfaced
only when the Rust port -- which filters on the `entities/scitem/characters/
human/` path and so never saw them -- built 140 fewer items.

`data/out/manifest.json` keeps the phantoms until `scx catalog`, `scx refresh`
and `scx variants` are re-run in that order. **Those three have been run**:
2475 items, 2289 renderable, 1854 variant surfaces baked.

### A one-directional diff scores the test, not the reference

`full_diff` compared every item the port built against the manifest and
reported "100.000% on all 20 fields, none unmatched". Both halves were true and
the conclusion was not: an item the port **never built** cannot appear as a
disagreement, so 189 manifest items -- 7.2% -- were absent from a comparison
that called itself complete.

A rate needs the reference as its denominator, not the thing being tested.
Reported the other way round it immediately split into two real faults, one on
each side: the port was missing the class-name slot fallback (23 wearable items,
the Ready-Up Helmet's twenty colourways among them), and the pipeline was
cataloguing 140 phantoms.

### `@LOC_EMPTY` is a real key that resolves to an empty string

`sc_nvy_deckcrew_helmet_01_01_01` carries
`AttachDef.Localization.Name = "@LOC_EMPTY"`, and `global.ini` maps `LOC_EMPTY`
to nothing at all. The Python writes `name or record.class_name`, and Python's
truthiness folds `""` in with `None`, so it falls back to the class name and
flags the item `unnamed`.

A port using `unwrap_or` gets `Some("")` and keeps it: three helmets came out
with a blank name and no flag. **An empty resolution is not a resolution**, and
it is a distinction the original never had to make.

### A name key can carry `,P`, and a placeholder is not a name (2026-11-03)

**13,380 of 90,437 `global.ini` keys end in `,P`**, a suffix the record never
names: `AttachDef.Localization.Name` says `@item_Name_doom_combat_medium_arms_01_01_01`
and the file says `item_Name_doom_combat_medium_arms_01_01_01,P=Clash Arms`.
Read as written, 56 items (armour, clothing and gear) found no name and showed
their class name -- the Clash Arms, Defiance Arms Ultimatum, the Strata
Levski Edition, the Shiv and the Novian crossbows among them. Stripping the
suffix never collides with a key that exists, so both loaders do it
(`localization.rs`, `localization.py`). Casing still differs too
(`GRIN_utility` in the file, `grin_utility` in the record), which the
existing case-insensitive fallback already covered.

**A localiser's placeholder resolves as absent**: 58 item names read
`PH - <class name>` or `PLACEHOLDER - <class name>`. With both rules, 60 of
4,941 records have no game name at all -- Squadron 42's navy and marine
uniforms, the character customizer's own clothes, promotional prints -- and
the kitbasher hides them (`unnamed` joined `HIDDEN_FLAGS`): a visitor sees
only the game's own names. `CATALOGUE_VERSION` 5.

### A record name is not unique across types

165 items resolved a palette reference to the wrong record. The VGL Warden
backpack ships an entity and a tint palette both named
`vgl_combat_heavy_backpack_01_03_01`, and `Index.by_class` kept whichever
loaded first, so `tint_for` got an entity, found no `root`, and returned a
palette ref with no colours. `Index.resolve_ref` now takes `record_type`, and
`tint_for` asks for `TintPaletteTree`. Palettes resolving went from 1237 items
to 1402, and backpacks without one from 85 to 52.

### Non-wearable records

Some DataCore records carry an armor attach type without being wearable: shop
displays (`Shop_*`), the loot containers armor drops into
(`Lootable_Container_*`, `Tint_LootContainer_*`), and outright placeholders
named `<= PLACEHOLDER =>`. `catalog.flags_for` marks these `not_wearable`,
`placeholder` or `test`, and the viewer's `HIDDEN_FLAGS` keeps them out of the
listing. Items flagged `unnamed` are real armor whose localization key did not
resolve; they stay visible under their class name.

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

### The browser catalogue streams its records (2026-09-24)

`buildCatalogue` parsed every wearable record into a `serde_json::Value` and
held all of them before building the first item. The exported human records
are 466 MB of JSON, several times that as trees, and the WebAssembly heap
reached **2.09 GB** -- 1.66 GB before clothing joined -- with dlmalloc spending
68% of the build in `memory.grow`. Opening an archive sat at "item names" for
over a minute and a half. `db::armor_records` and `db::gear_records` now yield
one record at a time, each built and dropped: **565 MB** peak, 316 MB of it the
DataCore itself, and 32-44 s against 160-173 s for the same build under the
same load. The output is unchanged, 100% both ways.

Profile it with a wasm that keeps its names --
`CARGO_PROFILE_RELEASE_STRIP=none CARGO_PROFILE_RELEASE_DEBUG=1` and
`wasm-bindgen --keep-debug` -- under `node --cpu-prof`; a stripped build
reports `wasm-function[690]`.
