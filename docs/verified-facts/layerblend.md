# LayerBlend and layer materials

How the LayerBlend_V2 shader's inputs work: detail layers, wear, metalness, the blend mask table, gloss, and the factory-new default.

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
`data/interim/gloss`. Real gloss is `layer Shininess x GlossMult x the palette
entry's glossiness`, times that alpha where the layer ships one
(`tint.layer_gloss`; the web shaders match), which replaced a hand-tuned
0.30-0.75 roughness band. Until 2026-11-01 the alpha *replaced* Shininess
instead of being scaled by it; see "A layer's Shininess scales its gloss map"
below.

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

### Layer colour comes from Diffuse and Specular, not the folder (2026-09-14)

Chasing why armour rendered lighter than the game shows it turned up two
errors in how a detail layer's colour was read. Neither was the cause -- that
was the material-slot bug in `pipeline.md` -- but both are wrong on their own terms.

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

### A layer's Shininess scales its gloss map (2026-11-01)

Reported by Noel through the Hangarworks item session: the Ambit Coverall drew
as wet vinyl where the game's icon shows matte cloth. Its main layer is
`nylon_01`, Shininess 91, over a `_ddna` gloss map averaging 0.93, and every
port took the map *instead of* Shininess whenever a map existed -- smoothness
0.93, roughness 0.07.

**The library says the map is scaled.** Of 97 layers with a decoded gloss map,
31 set Shininess below 255, and every one of them is a rough material whose
map alone would be shiny: canvas, fleece, jersey, lace, lycra, thread, towel,
tweed, cotton, leather, wicker, burlap, polyester, rust and nylon. `towel_03`
is 135 over a 0.89 map, `jersey_04` 100 over 0.87, `nylon_01` 91 over 0.93 --
read as the map alone, towels and jerseys come out glossier than most metals.
The metal folder sits at 255 almost entirely, so metals do not move. The skin
and `Illum` path (`materials.ts` `glossRoughness`) already read it as
`alpha x Shininess`.

Drawn through the Hangarworks item renderer on a 22-look bench: the Ambit
Coverall moves by 10.6 (mean, of 255) and loses its wet sheen (99th
percentile 215 -> 153), the Argus helmet 7.0, MacFlex legs and the Scaleweave
undersuit 3.0. Weapons are unchanged; hard armour moves by under 1, and that
is a real change, not noise: the Clark Defense chest moves on 0.4% of its
channels (mean 0.65 of 255), its yellow paint's highlights a little softer.
`tint.layer_gloss`, `layerblend.js` and the live `fwLayer` all apply it; the
Python bake's cache key gains `:shinemap`.

### A piece is drawn as it left the factory (2026-11-02)

The white chips on that backpack were its wear: the shell's paint pairs with
polished aluminium, and the chosen wear curve (`WEAR_THRESHOLD`) bares it in
every dark patch of the mask. The game shows pieces new -- in its icons, its
store renders and on a new character. Held against cstone icons, the Zeus,
Zeus Solar, Starscape and Stirling packs, the CSP-68H Red Alert, the Lynx arms
and the Artimex core are all clean, where worn they carry bright chips over
every painted plate (the Artimex core most of all). **Wear is off by
default** in the web engine (`state.wear`), which every path reads -- live
surfaces, baked atlases, swatches, carried gear, and the Hangarworks item
renders through it -- and in the local viewer, whose pipeline already bakes
both surfaces. It stays a toggle.
