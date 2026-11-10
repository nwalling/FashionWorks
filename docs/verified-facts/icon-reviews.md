# Reviews against the game's icons

What holding the item renders and the catalog against the game's inventory icons found and fixed (2026-10-30 to 2026-11-02).

### Items held against the game's own icons (2026-10-30)

The Hangarworks item renders were put beside references for 32 items and 12
ships, and three faults in the surfaces came out of it, each worth a class
of items. The method matters as much as the faults.

**The game's inventory icons are the reference for items, not the wiki.**
`cstone.space/uifimages/<guid>.png` is the icon the game draws for the item
in the current build (30 of 33 sampled items have one). The wiki's weapon
"shop display" shots are from **2019** -- before the `weapons_v7` rework --
while its armour and clothing shots are 2024; the file's upload date is in
`imageinfo`, and a reference older than the asset is not one. For ships the
wiki's `<Ship> in space - Isometric.jpg` series (one per ship and livery,
3840x2160, the same camera for all) is the fair comparison. Cut the ship out
of the black with a threshold, opening, closing and a hole fill, or every
shadow below the threshold is left out and the reference reads brighter than
it is.

**A palette entry with a black tint under a bright specular is a metal, and
makes a metal of whatever layer it paints.** The game's spec-gloss paints say
bare metal that way: the Behring default is tint (0,0,0) under spec
(143,143,143), and the standard P8-SC's body is a *dielectric* paint layer
(`weapon_metal_01`, TintMode 0, reflectance 0.044) on that entry -- silver in
game, black when the tint was multiplied in. 425 of 7,269 palette entries are
of this kind, most of them the default weapon palettes, so every standard
weapon skin drew black. `paletteEntryIsMetal` (bake.js) and
`palette_entry_is_metal` (tint.py): tint luminance under 0.012 linear and spec
over 0.07; such an entry takes its specular as the layer's F0 and draws it as
metal. The ship pipeline reached the same place by the glTF spec-gloss
conversion (`sc_materials.metal_rough`), which is the general rule this is the
unambiguous corner of; the partial-metal cases are left as they were until a
reference decides them.

**The `_hal` map is read only under `%HUE_AO_LUMINANCE_MAP`, and almost
nothing sets it.** 21 of 11,652 armour LayerBlend submaterials and 0 of 5,227
weapon ones, while 11,356 and 4,923 bind the map. Armour's maps are near-white
(the one decoded reads 245 mean green), so reading them as occlusion anyway
never showed -- which is how the earlier "inferred, not confirmed" note in `layerblend.md`
survived. A weapon's is a per-panel mask with whole panels black (the P8-SC's
has its rails black and its receiver white), and read as occlusion it took a
third of the light off every standard weapon. `material.rs` binds `hal` only
under the flag; the Python bake has no gen mask to read and still applies it,
which on armour is under 3%.

**Base layers sit in the slot their name says.** The blend mask's channels
address slots, so blue is the third slot whether or not the first two exist.
The Ketchum Beanie lists only `BaseLayer3` (its heather) and `BaseLayer4`
(black); placed by position, its 94%-blue mask reached past the two it has and
folded onto the black, and the beanie drew black. 542 of 11,647 armour and
clothing submaterials skip a number (most of those are empty-path layers the
earlier fix already put back; about 60 are absent outright). `by_slot`
(material.rs) and `SubMaterial.base_layers` (material.py) place by number and
fill a gap with an empty layer.

**Checked for regression** on the same sample: the armour and clothing rows
are unchanged by all three, and ship parts too.

**What was ruled out on the P8-SC.** Its wear mask is 81% above 224 -- under
"dark is worn" barely worn -- so wear is not what darkened it; and the
metal-entry fix alone moved its mean from 41 to 54 sRGB, the hal gate the
rest of the way to a silver receiver. The remaining gap to the icon is
lighting: a polished metal in the dark `hangar` probe reflects a dark room.

### The render review, held against the game (2026-11-02)

The Hangarworks render review of 30 October listed what the ship and item
renders had learned that FashionWorks had not. Built by the Hangarworks main
session on branch `render-review`, and drawn through the Hangarworks item
renderer on a 46-look bench (weapons, armour, clothing, helmets, ship parts,
decor) against the same bench on `7dacc9f`, with the game's inventory icons
where cstone has them. Armour, clothing and helmets moved by about 1 (mean, of
255): the WebP noise floor.

**A carved decal is light and shade, never color.** 330 FPS `MeshDecal`
submaterials, and some 2,000 ship and 2,800 decor `Illum` ones with `%DECAL`,
compile `%PARALLAX_OCCLUSION_MAPPING`. Their color image is a white mask with
the carving baked in as shading (`behr_pom_diff`: screws, vents,
"S/N: 1234567890mmx", AUTO/SEMI/BURST/SAFE, calibre stamps); the carving is in
the height map (`TexSlot4` on `MeshDecal`, `TexSlot8` `_displ` on `Illum`).
Drawn as color they laid white rings, dots and panels over the P8-SC, the
Klaus & Werner pistols and every ship part with a POM sheet; the icons show
none. `SubMaterial::relief` and `materials.ts` `reliefMaterial` draw the ship
renders' emboss (`sc_materials.relief`, constant for constant): the height one
step toward the texture's upper left against the height here, white where a
bevel faces the light, black on a groove's far wall, plus depth below 0.5 and
the color image's baked shading, all inside its alpha.

**`StencilTintOverride` is three ways, not a yes.** 0 and 2 color a palette
stencil with the palette's `decalColorR/G/B`, 1 with its three tints (entries
A, B and C), as the ship renders read a hull stencil's. Read as a yes/no, 1
and 2 took the material's own `StencilDiffuseColor`s, which are white on 406
of the 408 decals that set either: the decor and prop looks drew their
markings white. `Stencil::tint_override`; the kitbasher picks the colors.

**A ship part's damage is not drawn.** A rigid mesh's groups on nodes named
`dmg_*`, `*_dmg*` or `*damage*` are dropped (`gear::hide_damage`), as the ship
renders hide them, unless that would drop every group -- then the damage is
the item.

**An item's own material beats its model's.** `SGeometryResourceParams
.Material.Material.path` names the material that makes an edition its edition
when it shares its family's mesh (`material_override`, both catalogues; the
Hangarworks item step's `Record.mtl`). 61 armour and clothing items took no
material before and now take their own (RRS and Grin backpack editions, Navy
BDU belts), 4 gear items likewise, and gear also takes that node's palette.
One Squadron 42 training trouser now wears the sweatpants material its record
names. The Ambit Coverall names none and keeps its model's. `full_diff`:
materials 100% both ways; the tint field's 53.6% is unchanged from `7dacc9f`
(the port carries the stencil decal, the Python does not). Catalogue 4.

**A vehicle paint's grey texture is neutral, not albedo.** The ship library's
paint layers (`painted_panel_a_base`, `painted_tileable_a_base`) carry a flat
mid-grey diffuse: `panel_a_base_diff` 0.408 linear (std 0.013),
`ship_lf_panel_a_base_diff` 0.509. Multiplied in, a palette-painted ship part
drew at 40-50% of its paint; the ship renders scale the paint back up
(`sc_materials.neutral_grey`). `bake.js` `neutralGreyGain` divides such a
texture by its mean -- dielectric, palette-tinted, under `textures/vehicles/`,
mean 0.25-0.65 -- in the live and baked paths alike. FPS paint textures sit at
0.79-0.94 and a weapon's grease (0.06) is meant dark, so armour and weapons do
not move; nor does a part painted by a metal palette entry (most ship weapon
palettes' entry A), which the metal rule already normalises. 97 of the 727
ship looks paint such a layer with a dielectric entry. The Python bake bakes
FPS armour only, never the vehicle library, so it is left alone and its cache
key with it. **Mind the item renderer's light:** it draws ship parts with the
environment x4 (`item-renders.mjs` `SHIP_ENV_SCALE`) so bare metals read
silver, and that boost had been carrying the dim paint too. The F7A Mk I nose
turret's #969696 grey went from 0.12 to its own 0.30 albedo and now reads near
white under it: the ship-part light wants retuning against the icons when the
item session next redraws ship parts.

**A ship part's vertex color carries its occlusion.** HardSurface compiled
with `%VERTCOLORS` and LayerBlend with `%WEAR_DIRT_AO_VERTEX` keep occlusion
in the vertex color's blue, as the ship renders read it
(`sc_materials.strip_vertex_color`, 0.6). The live surface multiplies it in
(`VERTEX_AO`); a mesh with no colors under such a material gets white ones.
Armour's vertex color is its decal UV and carries neither flag. Measured on
the bench it is subtle -- the parts sampled average 63-98% blue, and no look
moved by more than 4 of 255 for it alone -- shade in the crevices, not a
change of tone.

**Looked at and left as they are:**

- *Dark glass.* The ships moved to near-opaque dark glass (alpha 0.95) because
  canopies sit over a black hangar. The game's helmet icons show see-through
  visors -- the Gys bubble clear, the CDS Legacy light helmet's smoked teal
  with the face behind it -- so FPS glass keeps its own.
- *Lighting.* The item renders already left `hangar` for the `studio` preset
  with per-kind environment scales (weapons x1.5, ship parts x4, knives x1;
  `ITEM_RENDER_VERSION` 2-3). AgX in place of Neutral would move every look in
  the kitbasher for an unmeasured gain.
- *`Illum` `%BLENDLAYER` second layers* and *vertex-alpha-tested decals.* The
  ship renders apply each only to the ships a reference settled (the Ballista
  and 300 series; the Pulse's sponsor logos, where vertex alpha x
  `DecalAlphaMult` under `AlphaTest` explained most but not all of the hidden
  logos). Neither is a rule to port blind.

### The catalogue held against the game's icons (2026-11-02)

Every armour, clothing and weapon look -- 4,731 -- was put beside the game's
own inventory icon (`cstone.space/uifimages/<guid>.png`; 3,152 have one, and
1,838 of those are plain inventory shots rather than scenes) and scored on
colour. What the comparison can and cannot say matters as much as what it
found.

**An icon is a reference only through its light.** The inventory lights its
mannequin white but fills from teal: a shadow reads teal at saturation 0.45
whatever the paint, a purple suit reads blue, a dark red cloth reads mauve,
and the K7 and Razorback trousers' twenty colourways each average within a
few units of (56, 60, 62) -- muted, not wrong (zoomed, each shows its colour).
Half the armour icons, and most weapon ones, are in-game screenshots under
scene light, and a dim one passes a dark-border test. So the scores rank
candidates and the eye decides; balance only the icon, on its brightest
pixels, and count hue only above a third of each image's brightness. The
scorer reads Hangarworks' item data and stays outside this repository; the
method is what to keep.

**A vertex colour is not always a decal coordinate -- fixed.** `decal_uv`
decoded every vertex of a mesh once any looked like one, and 684 character
meshes (LOD0; 990 looks) carry whole islands in another scheme -- red near
17-35, 96, 159 or 255, green's low nibble 6. Decoded, those land off the
sheet, and its repeat wrapping laid sheet content over them: hazard stripes
over the Clash Arms, white paint over the jaw and side ring of every Tailwind
flight helmet. A vertex is now decoded only inside the encoding (red 160-223,
green's low nibble 2-5, `mesh::is_decal_coordinate`) and samples the neutral
corner otherwise. Confirmed on references it was not fitted to: the Tailwind
Adrenaline, Big Bite, Blackbolt and Thunderstruck now wear the dark blue,
black, yellow and orange jaws their icons show, and the Clash Arms the brown
leather. In a random 100 of the 990, 2 change plainly; the Sunchaser and
Shogun decals do not move. A mesh-wide "mostly another scheme" cutoff was
tried and refuted: 282 LOD0 meshes are under half in the encoding and still
place real decals (10,690 vertices on the female CDS medium arms).
`examples/decal_coding.rs` surveys the archive.

**Thin films with no ramp -- fixed (`film.ts`).** Five looks paint
`%IRIDESCENCE` with no ramp of their own: the Arclight "Glimmer" and the
Yubarev and Atzkav "Mirage" and "Venom". Their thickness was read on the
interference ramp as its square root, fitted to the wiki's 2021-23 shots,
which drew the Glimmer gold where the game's icon is violet-blue. It is now
in proportion, `FILM_NM_PER_UNIT` 4,700 nm per unit of
`IridescenceThicknessU`: Mirage 212 nm blue-violet, Venom 282 nm green,
Glimmer 423 nm violet-blue, all three as their icons show. Two more things
the Venom needed:

* *A saturated metal keeps its paint, measured by saturation as well as
  chroma.* A weapon's bare metal reflects 25-40% (`weapon_bare_05`), so the
  Venom's green -- (0.27, 0.44, 0.07) under Specular 0.40 -- has a chroma of
  0.15 and the film painted it mint. `FILM_KEEPS_SAT` counts saturation above
  near-black (the Starchaser's near-black violet still takes its film).
* *Strength scales before the clamp, the paint's claim after it.* At strength
  5 the clamp undid the kept paint.

Held across all 88 film looks (Starchaser, Shrike, Greycat, Heartthrob,
Scorched, Shadowflux among them), 13 move: the five, the Chiron Heartthrob set
and Cambio SRT, which lose the ramp's magenta for a purer purple (their paint,
as the "keeps its paint" rule was written for), and the Aril Scorched
accents, slightly more bronze. Still short: the Venom reads a paler green
than its icon.

**Found and left:**

- *A weapon's housing reads dark* (the Yubarev). Its body is palette entry A
  at (42, 42, 42), dark in both. Taking a weapon metal's tint as its F0 in
  place of tint x Specular was tried and changed nothing visible; the
  "panels" that differed were the films above.
- *Helmet glass.* The Odyssey II Racing domes read dark teal in the item
  renders because nothing is inside them; the icon has the mannequin's head
  behind the same teal glass. Presentation, not material.
- *The Deo Shirt (Modified)* is periwinkle by its data (entry C of the Nine
  Tails palette on `cotton_01`); its only reference is a screenshot under
  orange light, which cannot overrule that.
