# Clothing and character

Clothing in the catalogue, a player's .chf character, and chunk visibility between pieces.

### Clothing is catalogued, and the pipeline ignores it (schema 5)

`CLOTHING.md` is the plan and the record. Both catalogues map the eight
`Char_Clothing_*` attach types to the slots `hat`, `shirt`, `jacket`,
`accessory`, `gloves`, `trousers`, `footwear` and `pack`, and every item
carries `outfit` (`armour` or `clothing`, decided by the slot), `chunks`
(`{zone, layer, visible}`) and `hidden` (port names). 4,416 items, 1,970 of
them clothing, 100% agreement in both directions. The Blender pipeline, the
audit and the local viewer read armour only -- `Manifest.armour()` -- because
the web kitbasher draws clothing live.

Two things that are easy to get wrong here:

* **The type is read before the name hints.** The Ready-Up Helmet is a hat;
  it was an armour helmet only because its name says "helmet".
* **`product_key` takes the slot.** Clothing stops at the garment ("Toughlife
  Boots Dark Red" is Toughlife), and that list is read only for clothing slots,
  so it cannot move an armour key.

### A player's character: what the `.chf` points at (CHARACTER.md)

**A `.chf`'s material GUIDs are not records.** They are keys in one record's
table, `SCharacterGenerationParams.DefaultCharacterGenerationParams`
`.materialLookupTable`: 94 materials and 40 textures by GUID. The head
material names the skin a face is drawn with -- `male36_t1` for Ilucide -- and
all 40 archive files resolve. The worker reads it, with the 299 head items
under `entities/scitem/characters/human/head/`, while the catalogue is built
(`appearance::Library`), because the DataCore is not kept afterwards.

**Some `.chf` names are not CRC32C.** `Head Material`, `HairDyeMaterial`,
`BodyColor`, `EyeColor`, `HairDyeColor1` and others are stored under hashes
StarBreaker maps by hand. Compare through `NameHash::name()`, not
`NameHash::from_string`, or every colour reads as absent.

**Skin joins at the neck through its tone mask, not a fudge factor.** Head and
body recolour from `SourceAverageColor` to `FinalSkinTone` (the `.chf`'s
`BodyColor`), and slot 7's green -- black exactly where the meshes meet --
takes both to the flat target there. `SourceAverageColor` is a picked swatch,
not its texture's mean, so recoloured regions land near the target, not on it.
The figure's body is `m_body_character_customizer.mtl` because `m_body_cau`
declares no tone.

**Hair kind is a shader flag, and a cap's density is in alpha.** `%HAIR_CARDS`,
`%HAIR_CAP`, `%HAIR_COAT` (`SubMaterial::hair`); guessing from `_opac` in the
file name misreads a buzz cut's coat. Most caps are white RGB over an alpha
density; read by red they draw as opaque sheets.

**The customizer is the reference for hair colour, and its record says what
the dye sliders are** (2026-11-02, CHARACTER.md "Hair, brows and skin, held
to the customizer"). The natural-colour picker image
(`root_color_graph_31_03_2025`) is Chiang's melanin curve at an azimuthal
roughness of 0.82, not Blender's 0.3, which drew every head at a quarter of
its colour. `DyeShift` and `DyeFadeout` are the two ends of one "Dye
Gradient" slider, root to tip, read here against the vertex red a hair mesh
counts its strands out in. A hair's highlight width comes from its
`Smoothness` as a physical roughness, not CryEngine 5's `Hair.cfx` exponent,
which put a white patch on every head. Skin reflects its `Specular` times its
spec map, through the 30x pore detail map on slot 6 the core used to drop.

**Far off, a head takes the middle strand's colour** (2026-11-03). Once a
pixel spans several strands the shader used to draw the mean of every
strand's colour in linear light, and on a wide melanin spread that mean is the
white strands': Ilucide's hair (spread 1.0 from his `.chf`, a fifth of it at
melanin 0) turned flat silver as the camera stood back. The strand id map is
mipped, so the filtered id's colour is what a distant pixel takes, as in game.
**The beard thinned far off from the depth offset and the cut-out**
(2026-11-03). Held against the same view drawn at eight times the pixels and
averaged down -- what the strands up close look like from further away --
Ilucide's beard went from 37% of its region covered at 0.5 m to 20% at 6 m,
where the reference holds 41% to 36%, and its moustache broke into clumps.

* *The depth offset read an average as a strand's edge.* `PixelDepthOffset`
  pushes a fragment back by how transparent it is, 9.2 mm on the beard. Hair
  masks load at 1024 (`plainSize`), where a strand is under half a texel, so
  outside an extreme close-up a pixel's opacity is several strands' average,
  partial everywhere, and the beard went back behind the skin it lies on, the
  moustache first. It now fades between half a texel a pixel and two
  (`HAIR_DEPTH_FADE`): at half a metre 42% covered, the reference's figure,
  where it was 37%.
* *A cut-out keeps the densest texels.* One threshold over a mip whose
  coverage is right in total keeps the roots, where the cards bunch, and drops
  the tips and the moustache: the jaw drew solid black, and each pixel it kept
  was one strand's highlight, a glitter. Between 2 and 5 texels a pixel
  (`HAIR_HANDOVER`) the cut-out dissolves and the blended pass carries the
  strands at their density as the mips carry it, `OpacityMipScale` and no
  more: the 1.5 lift that fills between the cut-out's strands made the far
  beard a fifth too covered.

Measured: 42/40/37/33% covered at 0.5/1.2/3/6 m against 40/38/35/34%, and
the region's spread of log luminance 1.14-1.17 against 1.02-1.08, from
1.41-1.65. Head hair and brows take the same passes and do not visibly move;
the portrait's moustache is a band again. The far beard reads about 15%
darker than the eight-times render, because magnified each strand takes its
own melanin and the lighter ones lift the red, where unresolved the filtered
id names the middle strand -- as the game's mipped id map would. Left.

The diagnosis this replaces -- filtering pulls the coverage mips' passing
texels under the test, so far off the cut-out draws nothing -- holds only
further out; before that the cut-out drew, on the wrong texels, and the
blended pass left to carry the rest was the one the depth offset hid. And
alpha to coverage cannot carry the far beard: one alpha gives every layer the
same samples, so overlapping cards do not stack, which is why handing over
through it drew thinner.

### A helmet's cowl answers to its core (2026-11-05)

Reported by Noel: the Artimex helmet's cowl and breathing tube, and the Geist
ASD helmet's hood, were drawn with any core. They are one zone of the helmet's
mesh, `theta_head_zone` (word `2583318635`, read off the meshes the way
CLOTHING.md Phase 0 read the body's), and the record draws it only under
`Chunks[].VisibilityConditions`: the piece in `Armor_Torso` must hold the
Artimex core's tags. A chunk is drawn while any condition holds, a condition
holds when all its port checks pass, and a check wants every `ActiveTags` and
no `DisableTags` tag on the piece in its port, held through the tag tree and
read from the entity's `tags` and its `OverlayTags` together. Read that way,
each of the 281 conditions in the archive picks exactly its own partners --
the Artimex cowl the three Artimex core families and nothing else. The
inventory icon agrees: the Artimex helmet on the bare mannequin has neither.

The web catalogue carries it as `visibility` and `tagged` (catalogue 6), and
`outfit.offZones` decides it, against what is worn and what the holsters and
the hand hold (a Morozov-SH-I Stronghold pouch goes off under a magazine). The
Python catalogue does not -- no tag tree in its export, no zones in its baked
meshes -- and `chunks` is unchanged in both. Every conditional zone is named
now, and a condition decides only the piece's own zone: what its chunk covers
stays covered. Naming `omega_core_zone` also brings the covering rule to the
torso: a core hides the undersuit's parts in that zone. The Artimex core's
neck ring and cloak are drawn with any helmet, as the game's icon shows them.
CLOTHING.md, "Chunks that answer to a partner".
