# Colour variants and families

How color variants get their own surface, how colourway families and product lines are grouped, and the audit checks that guard them.

### An item with no material wears another item's surface

A colour variant shares its canonical item's mesh, so an item that resolves
*no* material and *no* override does not render untinted -- it renders as
whichever item baked that GLB. `Citadel-SE Arms Maroon` came out as
`Citadel Arms Brimstone`, `ORC-mkX Arms (XenoThreat v2)` as `GCD-Army Arms`,
`ADP Arms Woodland` as `ADP Arms Aqua`. That is worse than a missing texture,
because it looks deliberate.

**146 items were in this state**, across every slot, and many were the
*canonical* member of their family rather than a variant. Two causes:

* **82: the material is authored on one gender's node only.** ADP, Aril, Aves
  and Aztalan put it on the female `.skin` and leave the male one null.
  `geometry_for` now falls back to the other skeleton's worn nodes. It must be
  *those* nodes and not any node: the root is the dropped-item carry crate, and
  its material would paint the armour as a storage box. Armour materials are
  gender-neutral here and are assigned by submaterial name, so sharing one
  across the pair is how the data already works. Rebuilding gave **114 items a
  material and took none away**.
* **63: no node carries a material at all.** These are *not* broken. The
  catalog stage records nothing, but `pipeline.discover_materials` pairs a
  material with the mesh name at convert time and finds one for 63 of 65, so a
  canonical item's GLB is baked correctly and the audit's first cut reported 36
  false positives against 10 real ones. **A canonical item owns its GLB**, so
  only a variant, pointed at someone else's, can borrow a surface -- that is
  now the test.

  The 9 that were genuinely wrong are rigid backpacks. A colourway there
  declares no material and no palette and hangs off a single `.cga` shared by
  its whole family, so mesh pairing hands every member the same file and
  CSP-68L Forest Camo wore Cayman's surface. Their material is in the archive
  under the **class** name, sometimes exactly
  (`cds_combat_light_backpack_02_02_01.mtl`) and sometimes with the trailing
  component dropped (`..._01_04_01` -> `..._01_04.mtl`).
  `discover_materials` now tries the class name, longest prefix first, **but
  only where the record declares nothing** -- where something is declared it
  still wins. 8 of the 9 resolve their own material; Artimex Arms Wildwood has
  none in the archive at all, and falls back to the family base as before.
  Checked against all 168 undeclared items: 156 plausible, 0 unrelated, and the
  one crate match is the hidden `<= PLACEHOLDER =>` record, which paired with a
  crate before this too.

Found by rendering the catalogue and diffing colourways against each other, not
by reading records -- the manifest looks healthy, because "no material" is an
empty list rather than an error.

**`scx catalog` drops asset pointers and overrides**, by design: it rebuilds
from the DataCore, and `scx refresh` then `scx variants` restore them. Measuring
"items with a GLB" straight after a catalog run therefore reports zero and any
check keyed on that silently passes. Run the three in order before trusting a
count.

### Two audit checks that would have caught these

`scx audit` gained `surface-borrowed`/`surface-missing` and
`variant-surfaces-identical`. The second compares baked *filenames* rather than
pixels, deliberately: the names are content hashes, so equality means the
pipeline decided two colourways are one surface -- which is the fact worth
reporting, and is exactly how the palette-specular bug presented.

`check_colourways_differ` already existed and did not catch either, because it
looks for a whole family of four or more collapsing onto one colour. Lynx
presented as *pairs* inside a family that otherwise varied fine.

### A colourway family fails only if it collapses everywhere

`check_colourways_differ` samples whichever submaterial comes first. Sweeping
*every* submaterial instead -- which the Rust port does -- calls two healthy
families collapsed: the Defiance helmet's `camera_m` agrees to 5.9 across six
colourways while its `coated_metal_m` spreads 44.1, and the Corbel helmet's
`helmet02_m` and `helmet03_m` agree to 2.9 and 0.0 while `helmet01_m` spreads
42.7. A camera lens and an interior shell being one colour on every colourway is
the artist's intent.

What the invariant is for is the Venture collapse, where twelve undersuits went
flat near-white **together, on every surface at once**. So the family's verdict
is its widest-spreading submaterial, not its narrowest.

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

### A colourway family must not span two product lines

`link_variants` keyed on `(slot, geometry_key)`, and the mesh alone is too
loose in the same way the `Set_<n>` tag is too loose the other way. `Defiance
Legs Sunchaser` and `ADP-mk4 Legs Woodland` are both
`m_cds_heavy_armor_01_legs.skin` -- the genuine reuse recorded in `layerblend.md`, which is
not to be "fixed" -- so eleven pieces across two product lines became **one**
family. `sharedName` then found no common prefix, fell back to the canonical
member's name, and every Defiance colourway disappeared as a swatch under
*ADP-mk4 Legs Woodland*. 71 families spanned more than one product this way.

The product line joins the key. **Not the `set` tag**: that separates
`citadel` from `citadel-se` and splits Aves across four keys, over-splitting
lines that are one product with several editions.

**The measure is whether a family shares a name prefix**, because that is
exactly what `sharedName` needs to title the row, and it is the thing the user
actually sees. Aggregate counts do not discriminate here: the family count
barely moves. Across the catalogue, families sharing no prefix go from **56 to
5**, and the 5 that remain are all unnamed items whose "name" is a class name
and so share no words by construction.

**An unnamed item's name is its class name, not `None`.** `flags_for` sets the
name fallback and the `unnamed` flag together, so a fallback written as
`product_key(item.name or item.class_name)` never fires, and `product_key` of a
class name is the whole class name -- colour index included. That gives every
unnamed colourway a key of its own and splits the family it was meant to hold
together. `set_key` already had this right; the fallback tests the flag, as it
does, and uses `canonical_key`, which is what drops the index.

Mirrored in `web/core/src/catalog/build.rs`, with `full_diff` reporting
**100.00% on all 20 fields over 2475 items in both directions**, `variant_of`
and `variants` among them.

### An "Edition" is a livery, and it spans product lines

Checked because equipping a set from `ADP Core Crusader Edition` put a **Balor
HCH** helmet on the head, which looked like the ADP-Arms class of bug and is
not.

**Crusader Edition is not an ADP thing.** 23 pieces carry it, across **12
product lines** (ADP, Arden-SL, Balor, CBH-3, G-2, Morozov-CH/SH/SH-S,
ORC-mkV, PAB-1, Strata, TCS-4) and **three manufacturers** (CDS, RRS, GRIN),
each keeping its own `set` tag. What they share is a `Texture_crus01` tag.

**Liveries spanning sets is the norm, not the exception.** Of 14 `Texture_*`
tags, 8 cover more than one set: `Texture_01` covers **37**, `Texture_02` 16,
`Texture_03` 12, `Texture_crus01` 11.

**And ADP ships no Crusader helmet at all** -- only arms, legs and core. So a
complete Crusader look *has* to borrow a helmet from another line; there is
nothing else to take. The pick is right.

What was wrong is that it happened silently. `matchSet` now returns the picks
it took from another product line and the status says so -- "helmet from
Balor" -- because a visitor who did not ask for a Balor helmet should not have
to work out why they are wearing one. 142 of the picks across 573 anchors
cross a line this way.
