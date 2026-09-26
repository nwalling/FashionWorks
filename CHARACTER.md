# CHARACTER.md — A player's own character, from their `.chf`

A plan, scoped against build 4.10.193.11644 (`sc-alpha-4.10.0`, 2026-09-25),
for letting a visitor load the character they made in the game's customizer --
face, skin, eyes, hair -- onto the figure the kitbasher dresses. Everything
under "What the data says" was read out of this build and out of one player's
file (`Ilucide.chf`, supplied by Noel); everything under "Phases" is a proposal
with an exit test.

**The file is a `.chf`, not a `.chr`.** The customizer saves characters as
4 KB `.chf` files, in `StarCitizen/LIVE/user/client/0/CustomCharacters/` on the
player's machine; `.chr` is the skeleton format this project already reads.

## Status

| phase | state | what it measured |
| --- | --- | --- |
| research | done | The `.chf` fully parsed; every item it names resolves to a record the catalogue already exports; the face is a per-region blend of library heads that ship as ordinary meshes of the protos head's topology; the skin colour is the shader's own tone target. See below. |
| 0 -- the face | done, awaiting the in-game comparison | Head id *k* is name *k*, proven on the archive's own characters; a one-head character reproduces its head to 0.0002 mm. Faces blend in the browser in 3.3 s cold, 1.7 s warm, with the eyes following their sockets. Three things the data did not say had to be settled on the way -- seams, shading, rough masks. See "Phase 0, as run". |
| 1 -- the face in the core | done | All 38 characters among the archive's 40 `.chf` files blend, 24 male and 14 female, v7 and v8; the other two are a tattoo overlay and a hair colour, and fail with a message. |
| 2 -- colour | done | The `.chf`'s head material resolves through one record's lookup table; head and body recolour to `BodyColor` and meet at the neck with the fudge factors gone; the iris takes `EyeColor`; hair, beard and brows take their melanin and dye. Freckles and sun spots are not drawn. See "Phases 1-4, as run". |
| 3 -- the player's items | done | Hair, brows, lashes, beard, stubble, scalp and piercings, fitted to the face; the hair swaps under a cap and goes under a mask or helmet. |
| 4 -- UI | done | The character stays on through outfits, belongs to its own body, and a share link of its outfit opens on the default figure. |

## What the data says

### The container is solved already

StarBreaker's `starbreaker-chf` crate reads it, and `starbreaker chf to-json`
converts one: a 16-byte header (`0x4242`, CRC32C, sizes), zstd-compressed data,
always exactly 4,096 bytes. Inside:

| field | Ilucide | what it is |
| --- | --- | --- |
| `body_type_id` | `25f439d5-…` | a **Tag** in the tag database, not an item: the body type |
| `dna` | 13 parts × 4 blends | the face shape -- below |
| `itemport` | 8 ports | the head's items, by DataCore GUID |
| `materials` | 7 | skin, eyes, hair, beard and eyebrow colours |

Across the 40 `.chf` files the archive ships (`Libs/CharacterCustomizer/`: the
masculine and feminine defaults, mission givers, NPCs) plus Ilucide: versions
7 (12 face parts) and 8 (13, adding the neck), 26 male and 14 female, and the
same ports every time -- body, head, eyes, hair, eyebrows, eyelashes, scalp,
with beard, stubble and five piercing ports where used.

### Every item it names is a record

Resolved against the DataCore export, all eight of Ilucide's items are records
under `entities/scitem/characters/human/`, the tree the catalogue reads -- but
under `head/`, which it does not catalogue. Phase 3 takes them out separately:

| port | record |
| --- | --- |
| body | `body_01_noMagicPocket` -- the body the figure already draws |
| head | `PU_Protos_Head` -- the head the figure already draws |
| eyes | `PU_Head_Eyes_White_CharacterCustomizer` |
| hair | `hair_75` |
| eyebrow | `brows_002` |
| eyelashes | `Head_Eyelashes` |
| beard | `facial_hair_011` |
| scalp | `shared_scalp_unified` |

So the hair, beard and brows a player chose are ordinary items with geometry
trees -- `hair_75` has the same `hatHair` children CLOTHING.md Phase 4 already
swaps under a hat.

### The face is a blend of library heads, region by region

The DNA block names, for each of 13 face parts (eyebrow, eye, cheek and ear,
each side; nose, mouth, jaw, crown, neck), four `(head_id, weight)` pairs whose
weights sum to 65,535. Ilucide's nose, for example, is 33% head 8, 13% head 16,
39% head 47 and 15% head 49.

**What a head id means is in the protos head's `.dna`**, beside its mesh:
`heads/male/pu/protos_human_male_face_t1_pu/protos_human_male_face_t1_pu_head.dna`,
76 MB, headed `DNA V1.6` -- CIG's own format, not Epic's MetaHuman DNA,
although the rig definition beside it is named `dna_riglogicspu.cdf`. StarBreaker
does not read it. What is read so far:

| where | what | checked |
| --- | --- | --- |
| `0x28`, `0x2a` | 13 face parts, 61 library heads (female: 48) | matches the `.chf` |
| `0x30`, `0x34` | 5,584 vertices, 32,178 indices | matches the protos head mesh |
| offset at `0x50` | the head names, 40 bytes each: `protos_human_male_face_t1_pu`, `male_archetype_v001_t1` .. `v015`, `male16_t1`, `silas_t1`, `bautista_t1`, … `male48_t1` | head id *k* is entry *k* |
| offset at `0xf0` (+8) | 13 × 5,584 floats: each vertex's weight per face part | every vertex sums to exactly 1; left and right parts mirror |

**The shapes themselves need no decoding, because the library heads ship as
meshes.** 60 of the 61 male names and all 48 female ones are ordinary
`*_head.skin` files (`imperator_t1` is the one missing), and every one checked
has the protos head's 5,584
vertices and 32,178 indices **in the same order**: vertex for vertex they sit a
mean 3-6 mm from the protos head, at most 1.5-2.2 cm -- face-shape variation,
not reordering. So a player's face is

    position(v) = Σ over parts p of  mask_p(v) × Σ over the four blends of  (weight / 65535) × position_head(v)

a convex combination of meshes already in the archive, with the protos head
supplying the topology, UVs and skin weights. The `.dna`'s two large sections
(21.8 MB and 48.5 MB) are not plain vertex positions and are most likely the
facial expression rig; nothing here needs them.

The female `.dna` has the same layout -- 13 parts, 48 heads, 5,584 vertices,
masks summing to 1 -- so one reader serves both bodies.

### The skin colour is the shader's own target

`BodyColor` in the `.chf` -- Ilucide's `#a77b65` -- is exactly the
`HumanSkin_V2` parameter `FinalSkinTone` written in sRGB: the masculine
default's `#513428` is linear (0.0823, 0.0343, 0.0212), the value
`MasculineDefault.xml` -- the same character as XML -- gives `FinalSkinTone`. Each skin material also declares
`SourceAverageColor` under `%TONE_ADJUSTMENT`, which stands for its texture's
average: the shader recolours each texture from it to the one target, which is
how the head and the body meet at the neck in the game. (It is a picked
swatch, not a measurement -- see Phase 2 as run.)

That explains the figure's hand-tuned `MALE_SKIN_MATCH` (RENDERING.md Phase 4):
the head and body textures have different averages, and a single target
recolours them by different amounts -- (1.05, 1.26, 1.39) body over head for
the default, against the tuned (1.32, 1.33, 1.40). With the tone adjustment
done properly the fudge goes.

The rest of the head material is parameters the customizer exposes:
`FrecklesAmount`/`Opacity`, `SunSpotsAmount`/`Opacity`, three makeup layers
(colours, opacity, metalness, smoothness, tiling) and a tattoo (age, hue,
tiling). Eyes carry one `EyeColor`. Hair, beard and eyebrows each carry
`BaseMelanin`, `BaseMelaninRedness`, `BaseMelaninVariation`, `DyeAmount`,
`DyeShift`, `DyeFadeout` and two dye colours -- the parameters
`materials.hairColour` already reads off the hair `.mtl`.

### What was not resolved, and how it was

All four were settled in Phases 0-3; kept here with the answers.

- **Texture overrides.** Materials name textures by GUID, and no DataCore
  *record* carries those GUIDs -- but one record's *field* does: the lookup
  table under Phase 2. Slot 4 is the blemish mask on every file; slots 8-14
  are makeup and tattoo sheets. Drawing them is not done.
- **The head's own textures.** Not the protos material's: the `.chf`'s head
  material GUID names one of 94 `maleNN`/`femaleNN` head materials through the
  same table. Ilucide wears `male36_t1`'s; the masculine default `male17_t1`'s.
- **Eyes, eyelashes and brows following the face.** The eyes blend from the
  library's own eye meshes (Phase 0). Lashes, brows, beard, hair and piercings
  are fitted to the blended head by a wrap (Phase 3).
- **`imperator_t1`**, male library head 19, has no mesh; a blend that names it
  renormalises the other three (Phase 1, `character::usable`).

## Phase 0, as run

**Head id *k* is name *k*, and the blend is right where the data is
unambiguous.** Two of the archive's mission givers are single library heads
throughout: `Macken.chf` is 100% `macken_t2` and `recco_battaglia.chf` 100%
`battaglia_t3`, each the entry at its id. Blended, Battaglia reproduces
`battaglia_t3_head` to 0.0002 mm. Macken does everywhere but the neck, which a
version-7 file does not describe and which therefore stays the protos head's --
confined to the neck mask to the same 0.0002 mm. The masculine default's
heaviest head is `male17_t1`, 31%, which is exactly the head whose textures
`MasculineDefault.xml` names: the lead for which head textures a character
wears.

**Absolute against offset is not a question.** The masks sum to one at every
vertex and the weights to one in every part, so blending positions and
blending offsets from the protos head are the same arithmetic.

**Three things the data does not say, settled by measurement:**

- **Seams.** The mesh splits a vertex along its UV seams and the DNA masks the
  copies independently -- one wholly jaw, its twin wholly neck -- so a mixed
  face cracked open along the jaw, 24 places, up to 8.4 mm. The library heads
  keep the copies exactly together, so giving the copies their mean mask
  closes every seam (0.0000 mm on eight characters). `DnaLibrary::weld`.
- **Shading.** Blending the library's normals under the masks jumps between
  heads wherever a mask is hard-edged, which drew a jagged dark band down
  Ilucide's right cheek. The authored normal is kept and turned by however
  much the blend turns the surface, measured on the welded geometry.
  `character::reshade`.
- **The masks are rough.** 117 vertices carry a part none of their neighbours
  has -- one beside the ear is 73% mouth -- and eyelid folds change part across
  a single edge. As shipped, mixed faces buckle: edges stretch up to 2.4 times
  on Ilucide and 5.9 on Meg, a stepped jaw and lumps at the mouth. Two passes
  of smoothing over the surface take that to 1.1 and 1.7 while the face moves
  0.06 mm on average. **This one is an interpretation**: how the game treats
  the masks is not in the data, and a capture of the same character settles
  it. `DnaLibrary::smooth`, `MASK_SMOOTHING` in `lib.rs`.

Ruled out on the way: the masks are in the mesh's own vertex order. The mesh
carries each vertex's original, pre-optimisation index in its second colour
stream (`IVOCOLORS2`, red plus green times 256: 5,386 values, the welded vertex
count), and reordering the masks by it makes them ten times rougher, not
smoother. The rough patches are in the data.

**The eyes follow their sockets.** Each eyeball blends from the library's own
eye meshes -- 922 vertices on every head -- under its eye part's weights: the
pair's width runs 84 to 91 mm across the characters tried, and on all five
rendered the eyes sit in their lids. The head's neck rim moves at most
0.45 mm, so the head still meets the body.

**The part count is a byte.** The byte after it repeats it, so read as a
`u16` the two make 3,341; the first reader asked for a 97 MB file.

**In the browser.** `web/core` reads the `.chf` with StarBreaker's crate and
the DNA's header, names and masks by streaming the first 22 MB of its 76 --
zstd, fetched a megabyte at a time (`p4k::read_entry_prefix`) -- once per body,
then loads the library meshes the face names. Ilucide, 22 library heads, loads
in 3.3 s with the DNA read and 1.7 s after; the core grows by 110 KB. The
engine swaps the figure's head and eyes for the blend, re-applies it when the
figure is rebuilt, and switches to the character's body when it differs. A
"character…" button beside the body switch takes a `.chf`; the file is read in
the browser and goes nowhere. That is most of Phase 1 and a sliver of Phase 4,
done because the spike needed them.

Checked on Ilucide, Macken, Intersec Tobin, the DefenseCon NPCs and both
defaults (male); Recco Battaglia and Meg (female).
`examples/character_probe.rs` reproduces the measurements from extracted
files.

## Phases 1-4, as run

**Phase 1 is Phase 0's core, run across the archive.** All 38 characters in
the 40 `.chf` files blend with their seams shut, male and female, v7 and v8.
`regen_boss_hair_color.chf` and `Ninetails_Body_Tattoo.chf` are not characters
-- a hair colour and a tattoo overlay the generator layers onto others -- and
say so.

### Phase 2: the head material, the tone, the iris, the hair

**A `.chf`'s material GUIDs are keys in one record's table.**
`SCharacterGenerationParams.DefaultCharacterGenerationParams` holds a
`materialLookupTable`: 94 material GUIDs and 40 texture GUIDs, each with a
file path. The body material is `m_body_character_customizer.mtl` (female
`f_...`) on every file; the head material is one of the `maleNN`/`femaleNN`
head materials -- 40 of 40 resolve. The core takes the table out while the
catalogue is built (`appearance::Library`), since the DataCore is not kept.

**The body the figure wears is the customizer's.** `m_body_cau.mtl` declares
no tone adjustment; `m_body_character_customizer.mtl` does, with the same
submaterials. `MALE_SKIN_MATCH` and `FEMALE_SKIN_MATCH` are gone.

**The tone mask is what joins the neck.** Recoloured by `Final / Source`, the
textures still disagree where the meshes meet: the male head reads a fifth
lighter than the body across the 45 vertices they share. The skin materials'
slot 7 (`head_mask`, `m_body_mask`) settles it: its green is white nearly
everywhere and black in one band on each texture -- the lower neck on the
head, the collar on the body -- exactly where they meet. Drawn as "the flat
target where the mask is black, the recoloured texture where it is white",
the seam goes on every head tried. **Inferred**: the shader is compiled into
the engine. The multiply is inferred too; `CalibrationPower` 1 and
`CalibrationSlope` 0 on every skin material make it the plain ratio.

**`SourceAverageColor` is a swatch, not a statistic.** Against its own
texture it is 1.37 times the linear mean on `m_body_01`, 0.83 on `male02`,
1.06 on `male36`, and no mean, median or sRGB average fits them all. The
values are colour-picker picks -- 0.3515 is sRGB 160 -- and `female01`'s is
the female body's, copied. So a recoloured region lands near the target, not
on it, and where the mask fades from flat to texture below the collar there
is a soft step. That is the mask's own falloff.

**The iris.** `EyeColor` is the `Eye` shader's `IrisColor` in sRGB, exactly
(the masculine default's `#37110a`). The eyes item wears the customizer's
white eye, whose diffuse alpha is the iris mask over a pale patterned iris;
inside it the texel becomes `IrisColor` scaled by its brightness over the
iris's mean. The protos head's own brown eye is untouched.

**Hair.** `HairDyeColor1` is `DyeColor` in sRGB, exactly (`#89756b` is
`hair_31`'s), and the melanin and dye parameters match by name. **The dye
absorbs; settled by Ilucide.** The `.chf` dyes Ilucide's beard and brows
`#fefefe` at 0.71 and 0.91; mixed toward the dye colour by `DyeAmount` -- the
first reading -- they came out light grey and near-white, and Noel reports
them **dark with grey highlights** in game. Absorbed (colours multiplying, as
Chiang et al. add a dye's absorption to melanin's: `pigment x dye ^ amount`)
a near-white dye takes nothing away, and the grey is the strands' highlight.
The same reading turns the seven archive characters whose brows the mix drew
vivid blue -- black melanin under a `#08049c` dye -- black. It also takes
`hair_31`'s own brown dye to darken the default figure's hair to near black.
`DyeFadeout` (up to 14.5) and the second dye colour stay unread.

**Not drawn:** freckles and sun spots (the blemish masks are resolved, the
shader's use of them is not), makeup and tattoos.

**Names are not always CRC32C.** The `.chf` stores `Head Material`,
`HairDyeMaterial`, `BodyColor`, `EyeColor`, `HairDyeColor1` and other names
under hashes StarBreaker maps by hand; comparing against `crc32c(name)` read
every colour as absent.

### Phase 3: what the character wears

**299 head items**, read out of the DataCore with the table. A `.chf` names
eight to ten: body, head, eyes, hair, brows, lashes, scalp, and beard,
stubble and piercings where used. Each resolves by one rule: the node tagged
with the body (`Male`, `Female`) carries the mesh -- for the eyes, the one
under `Protos_head` -- and its material is the node's own, else the item's
`SMaterialNodeParams`, else the `.mtl` beside the mesh. A tagged material
variant that matches more than the body's tag wins over the node's: `hair_75`
asserts `$$scalpVHair_75++`, which is how the universal scalp would pick its
material -- and the scalp ships no `scalpVHair_75`, so it keeps `m_hair_02`,
which is what the data says. `examples/character_looks.rs` resolves any file.

**Worn things are wrapped onto the face.** Brows, lashes, beard, hair and
piercings are authored on the protos head; their records name `WD_Elastic`,
`WD_ElasticDQSkinning` and `WD_ElasticNUScaling` deformers where the head and
body name `Standard`. The engine's deformer is compiled in, so the core's is
the plain version, **inferred**: each point moves by the inverse-distance
blend of the displacement of the four protos-head vertices nearest it
(`character::wrap`, a k-d tree). The core keeps the last face for it and
`characterMesh` fits anything loaded afterwards, so a hat's variant loads
fitted too.

**Hair comes in three kinds, and the shader flags say which.** `%HAIR_CARDS`
is strands, alpha-tested; `%HAIR_CAP` is the shadow a hairline casts on the
skin; `%HAIR_COAT` is short hair laid over the scalp. The viewer used to guess
from the mask's name (`_opac` meant cards), and a buzz cut's coat is
`hair_02_shaved_opac`. **Most caps keep their density in alpha** over white
RGB -- the brows', the beards', `m_hair_02_scalp` -- and read by red they were
solid: an opaque sheet over the forehead, the brows and the jaw. And strands
are drawn no glossier than roughness 0.75: hair's highlight is a thin
anisotropic band, and an isotropic one at `1 - Smoothness` spread across
`hair_75`'s flat back and sides as a grey-white sheet.

**Strands, drawn as strands.** Hair looked like scratches and clumps, and
not for want of texture: the strand masks are 4096, two channels, strands
1.25-2 px wide, and decoding them at full size changed nothing on screen,
because a head on screen samples a small mip regardless. Box-filtered down to
that mip a strand is a faint smear, and the alpha test turned smears into
clumps; the flat 1.6x lift that stood in for mip handling made every level
about twice as dense as the strands are. Now each mip is scaled so the
fraction passing the test is its mean opacity -- which box filtering
preserves, and which is the true coverage (`texture_6`: 8.1% mean against
8.3% of texels over half) -- and three.js's alpha to coverage sharpens each
strand by its screen footprint. Both strand sets are drawn (red and green):
one alone read as thinning hair.

Cards are shaded as hair from two maps the material names and the viewer
ignored: the **ID map** (`%CARD_ID_MAP`, a random grey per strand) moves each
strand's melanin either way by `BaseMelaninVariation`, and the **direction
map** (`%DIRECTION_MAP`) drives an anisotropic highlight across the strands
(`MeshPhysicalMaterial` anisotropy, tangents from screen derivatives). How far
a variation of one moves the melanin, the highlight's strength and its
stretch are chosen (`STRAND_MELANIN_SPREAD`, `HAIR_SPECULAR`,
`HAIR_ANISOTROPY`), against Noel's "dark with grey highlights".

**The scalp under the strands is shaded by its cap, read against the cap's
own peak.** Most cap masks peak far below one -- the universal scalp's
`m_hair_02_scalp` at 0.29, the beard's at 0.28, the brows' at 0.44, where
`hair_31`'s reaches 1.0 -- so taken as absolute the scalp under a head of hair
took at most 29% of its colour and showed as bare skin between the strands.
The cluster reads as a convention the shader scales, so the peak is drawn as
full shade and the falloff keeps its shape. **Inferred.** Coats already reach
one and are unchanged. What is left is a card's own edge: the foot of the
beard's cap under the jaw is a hard cut.

**The outfit decides what shows, by the character's own ports.** An item is
hidden when something worn hides its port or the head; hair also under any
helmet, as the figure's own. Its variant is the first geometry tag a worn
piece asserts that it offers: under the Aegis cap `hair_75` wears its
`hatHair` cut; under the Katla mask, which asks `hatHair_mask`, it wears
nothing, because that variant has no mesh. The figure's own hair goes
whenever a character is on -- a character with none is bald.

### Against the captures (2026-09-26)

Noel supplied five in-game captures of Ilucide (front, both three-quarters,
back, profile; kept in the gitignored `data/reference/ilucide/`). Compared
from matching angles, measured as ratios against the skin in the same image
-- the hangar's green light defeats absolute colour. What they settled:

- **A cap is the hair's average colour, not its black `Diffuse`.** Every
  cap declares `Diffuse 0,0,0`, and the first reading drew them black: the
  beard's base then read brown, skin under black. The captures show it
  charcoal grey -- the average of black and white strands -- so a cap takes
  the hair's flat colour through its density, read against its peak and
  lifted by `CAP_GAMMA` 0.5, since the beard's fades halfway up the cheeks
  where the captures show it dense to the cheekbone. The first-first reading,
  hair colour with the dye mixed flat, painted it light grey: it was the flat
  dye, not the cap, that was wrong.
- **Dye is per strand.** The beard in game is salt and pepper: black melanin,
  with white strands, lightest on the moustache and chin. Neither a flat mix
  (grey) nor absorption (black) draws that. `DyeAmount` is the share of
  strands the dye reaches, chosen by a second draw from the strand ID map,
  softened by `DyePigmentVariation`; the flat colour is their average. The
  share and a dyed strand's brightness are not in the data and are
  calibrated on the chin (`DYE_SHARE` 0.45, `DYE_ALBEDO` 0.3): 36% of it reads
  bright against the capture's 29%, median 0.154 of the skin against 0.126.
  A first version let the softening reach below zero and dyed 8% of strands
  at amount 0 -- white specks through the hair, found by reading the canvas.
- **Strand density follows `OpacityMipScale`.** Coverage equal to mean
  opacity is the physics of one card; the captures show hair solid, and the
  materials carry `OpacityMipScale` (3.2 on `hair_75`, 2.7 on the beard), the
  game scaling strand opacity up the mips. Each mip's coverage is its mean
  opacity times that. Coats are read against the dense half of each level.
- **Hair cards shade as a volume.** Lit by their own normals, which point
  every which way, the hair read a quarter as bright against the skin as in
  game. Normals bend 80% toward a sphere round the hair mesh's centre, before
  skinning, and both faces face out.
- **The melanin curve was right.** Corrected for the hangar's cast, the
  capture's hair is a dark ash-brown near 7% of the skin's luminance, which
  `hair_75`'s pigment already gives; the darkness was lighting, not colour.

Still off: the captures' hair carries a broader grey sheen than ours, most of
it their bright overhead light; the head
mesh's lower neck rim shows as two dark triangles either side of the collar,
on the default face too; the beard's cap ends in a hard edge under the jaw;
and under the jaw the beard reads brown -- not its strands' colour, which a
magenta test left untouched, but their shadow on the skin, which the
captures' denser strands cover.

`coverageScale` gave up and returned no boost when a level held fewer
non-empty texels than the target asked, drawing such a mask at its thinnest;
it now passes every texel that holds anything.

### Phase 4: the file, the body, the link

The character belongs to its body. Loading one switches to it; switching away
puts the default face on the other body ("Ilucide is male: default face"),
and switching back puts the character back. Items go on under one ticket, so a
figure rebuilt while a character is dressing cannot dress it twice. A share
link carries the outfit only: reopened, the jacket was on and the face was the
default.

## Phases

| phase | what | size |
| --- | --- | --- |
| 0 | spike: Ilucide's face, blended and rendered, against an in-game capture | spike |
| 1 | face: the blend in the core, both bodies | small |
| 2 | colour: skin tone, freckles, eyes, hair melanin and dye | small |
| 3 | items: the player's hair, beard, brows and piercings | small |
| 4 | UI: load a character, and keep it across outfits and bodies | small |

### Phase 0 -- the face, proven on one character

Read the masks and head names out of the male `.dna` (a few hundred KB of a
76 MB file: range reads, not the whole thing), blend Ilucide's face from the
library meshes the `.chf` names, and put it on the figure. Compare against a
capture of Ilucide in game -- front and profile, no helmet.

**Exit:** the blended face matches the capture by eye, and the three things
most likely to be wrong are settled either way: head id *k* is name *k*, the
blend is of absolute positions rather than of deltas from the protos head, and
the eyes sit in their sockets.

### Phase 1 -- the face in the core

`web/core` gains a `.chf` reader (StarBreaker's crate, if it builds for wasm --
its dependencies are `ruzstd` and `crc32c`, both pure Rust) and a `.dna` reader
for the header, names and masks. The worker blends a head from the library
meshes it needs -- at most 52, in practice about 30 -- and hands the engine one
head mesh like any other.

**Exit:** Ilucide and five of the archive's own characters, male and female,
v7 and v8, blend without error; a blend naming `imperator_t1` renormalises.

### Phase 2 -- colour

Tone adjustment on head and body from `SourceAverageColor` to `FinalSkinTone`,
replacing `MALE_SKIN_MATCH`/`FEMALE_SKIN_MATCH`; freckles and sun spots; eye
colour; melanin and dye on hair, beard and brows.

**Exit:** the default character's neck seam gone without a fudge factor;
Ilucide's skin, eyes and hair read as in the capture.

### Phase 3 -- the player's items

The hair, beard, eyebrows, eyelashes and piercings the `.chf` names, as items,
with the hat-hair rule applying to whatever hair it is.

**Exit:** Ilucide's `hair_75` and `facial_hair_011` on the figure, and the hair
swapping under a cap.

### Phase 4 -- UI

"Load your character": a file picker for the visitor's own `.chf`, with a line
on where the game keeps it. The file never leaves the browser, which is the
same promise the tool already makes about `Data.p4k`. The character stays on
through outfit and body switches -- a male `.chf` on the female body is
refused, not bent. A share link cannot carry a 4 KB file, so a loaded
character is not shared; the outfit still is.

**Exit:** a visitor loads their `.chf` and dresses the result, and a share link
of that outfit opens on the default figure.

## Not planned

- **Decoding the `.dna`'s shape and expression sections.** The library meshes
  make it unnecessary for identity, and the figure does not animate a face.
- **Editing a character.** This reads what the game's customizer made; the
  customizer is the place to change it. StarBreaker writes `.chf` files, and
  community tools use that to edit them, but that is a different product.
- **Downloading shared characters** from sites that collect them. The visitor
  brings their own file.
