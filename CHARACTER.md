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

### Every item it names is already catalogued

Resolved against the DataCore export, all eight of Ilucide's items are records
under `entities/scitem/characters/human/`, the same tree the catalogue reads:

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
`SourceAverageColor`, its own texture's average, under `%TONE_ADJUSTMENT`: the
shader recolours each texture from its own average to the one target, which is
how the head and the body meet at the neck in the game.

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

### What is not resolved

- **Texture overrides.** Materials name textures by GUID -- slot 4 on 39 of the
  40 archive files, slots 8-14 on a few (makeup and tattoo masks, most likely)
  -- and no DataCore record carries those GUIDs. Without them a character's
  makeup and tattoo patterns cannot be drawn; everything else can.
- **The head's own textures.** Every character's head uses the protos
  material, which points at `male02`'s albedo, tone-adjusted. The masculine
  default's XML names `male17`'s instead; which one a given character gets, and
  why, is open.
- **Eyes, eyelashes and brows following the face.** They are separate meshes,
  and where eye sockets move between library heads the eyes must move with
  them. The per-library eye meshes probably settle it the same way the heads
  do; the facial joints in the `.dna` are the other candidate.
- **`imperator_t1`**, male library head 19, has no mesh. A blend that names it needs
  a fallback -- renormalising the other three is the obvious one.

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
