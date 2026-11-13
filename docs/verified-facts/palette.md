# Tint palettes

How tint palette entries map onto layers: PaletteTint indexing, tint versus specular, and the investigations that settled it.

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

**Regression-checked against every piece these notes already validated**, by
baking each twice and diffing per submaterial: Defiance Core Sunchaser, Beacon
Undersuit Orange and Odyssey II Undersuit Tan/Black are bit-identical, 0 of 5,
7 and 12 submaterials changed. Corbel Halcyon moves slightly and stays plainly
yellow (`core01_m` 173,127,0 -> 151,113,14). Emulate the old behaviour for such
a diff by passing a palette whose `spec` is set to its `color`; that is exactly
what the previous code did.

### A painted metal takes the entry's specular alone, not times its own

The rule above settled *which* of the entry's two colors a metal takes. Until
0.17.5 the product then multiplied that specular by the layer's own Specular,
so a painted metal carried its library metal's hue and brightness twice. On a
bright or saturated entry (the Lynx reds and blues) the hue survives and the
error hides; on a dark neutral one it does not.

**The Corbel Raider Camo settles it.** Its core, arms and legs plates are
`bronze_scratched_04` (Specular 0.254/0.184/0.112, TintMode 2) on entry A of
`vanduul_incursion`, whose specular is (59,59,59). The product drew them
0.044 x bronze, about 0.011 linear: near-black with a bronze sheen. An in-game
screenshot (Noel, 2026-11-13, a desert in daylight) shows dark **neutral**
gunmetal with silver worn edges, and no bronze anywhere.

**Bench, 40 looks** (Hangarworks `~/Library/Caches/hangarworks/bench/painted-metal`):
the four Raider Camo pieces, the Corbel Crush and Halcyon cores, four Lynx arms
and 30 random looks with a painted metal layer and a cstone icon. 18 moved by
more than 3/255; every one moved toward its icon (the Raider Camo plates to
gunmetal, the Berserker and Artimex Chairman's Club gold trim to the bright gold
of their icons, the Lynx steel to silver, Geist Backpack Forest to its lighter
green) and none away from it. Unpainted metals are unchanged: they still take
their own Specular.

All three renderers carry the rule: `live.ts`, `web/gpu/layerblend.js` and
`tint.py` (bake key token `paintedmetal`); `test_a_painted_metal_takes_the_palette_specular_alone`
fails on the old rule.

### The palette modulates a layer's TintColor, it does not replace it

966 of 1984 palette-tinted base layers carry a **non-white** `TintColor`,
median 0.50. Substituting the palette colour for it, rather than multiplying,
rendered half of them up to twice as bright as the game.

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

**Closed by the icons (2026-11-02).** Drawn on main against the game's own
icon, the arms carry gold on the pauldron frame and the forearm, as the icon
shows, at 19% of the piece. Some later fix moved them; which one was not
traced. See "The catalogue held against the game's icons" in `icon-reviews.md`.

### Closed: the backpack shell takes the wrong palette entry

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

**Closed by the icons (2026-11-02):** the shell draws red on main, as the
game's icon shows, with the mapping as it stands, 1 -> A. Some later fix
moved it; which one was not traced.

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
