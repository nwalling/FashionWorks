# CLOTHING.md — Clothing as a wearable layer

A plan, scoped against build 4.10.193.11644 (`sc-alpha-4.10.0`, 2026-09-24),
for letting a visitor dress the figure in clothing -- shirts, jackets, trousers,
boots, gloves, hats -- instead of the armour layer. Everything under "What the
data says" was read out of this build's DataCore; everything under "Phases" is
a proposal with an exit test.

## Status

| phase | state | what it measured |
| --- | --- | --- |
| 0 -- zones | done | The body's 30 (male) and 31 (female) zone submeshes named from geometry and coverage, and shared by every shirt and jacket that covers them. The rule -- a zone is hidden where a higher layer lists it, unless the chunk's `VisibleLayers` keeps that layer -- holds on shirt, trousers, boots and jacket on both bodies: no skin through cloth, and skin kept at the cuffs. See "Phase 0, as run". |
| 1 -- catalogue | done | 1,970 clothing items in eight slots, both catalogues, 100% field agreement over 4,416 items in both directions. 261 clothing colourway families, all but six (unnamed, as for armour) sharing a name prefix. No armour item's set, family or name moved. See "Phase 1, as run". |

## What the data says

### The character is a chain of item ports, and armour hangs off the undersuit

The body item (`body_01_noMagicPocket`, the one the customizer uses) declares
its own ports:

| port | takes | flags |
| --- | --- | --- |
| `Armor_Undersuit` | `Char_Armor_Undersuit` | nontransferable inventory |
| `Clothing_Torso_0` | `Char_Clothing_Torso_0` (shirt) | nontransferable inventory |
| `Clothing_Torso_1` | `Char_Clothing_Torso_1` (jacket) | inventory HeadWear |
| `Clothing_Legs` | `Char_Clothing_Legs` | nontransferable inventory |
| `Clothing_Feet` | `Char_Clothing_Feet` | nontransferable inventory |
| `Clothing_Hands` | `Char_Clothing_Hands` | nontransferable inventory |
| `Head_ItemPort` | `Char_Head` | nontransferable |

The **armour ports are not on the body. They are on the undersuit**: of 222
undersuits, 222 carry `Armor_Helmet`, 172 `Armor_Arms` and `Armor_Legs`, 170
`Armor_Torso`, alongside the holsters. The jacket carries `Clothing_Torso2`
(belts and harnesses, `Char_Clothing_Torso_2`), and the head carries the hat,
hair, beard and eyewear ports.

So there are two outfits, and the data makes them exclusive rather than
layered: **every undersuit but seven hides all five clothing ports** --
`Clothing_Torso_0`, `_Torso_1`, `_Legs`, `_Hands`, `_Feet` (215 of 222, via
`SCItemClothingParams.HiddenParts`). In game you wear armour on an undersuit,
or clothing on the body, not both. The kitbasher's current freedom to put
armour straight on the bare figure is its own liberty, not the game's rule.

### Every wearable says which body zones it covers, and at which layer

`SCItemClothingParams` on every worn item carries:

- **`HiddenParts`** -- ports it hides while worn. The undersuit hiding the
  clothing ports is one use; a jacket hiding the shirt is another (288 of 558
  jackets); a helmet hides the head's `Hat`, `Facewear` and `hair_flair`
  ports on all 683, eyewear on 355, and the head itself on 251.
- **`Chunks`** -- `{MeshChunk, Layer, VisibleLayers, VisibilityConditions}`:
  named body zones the item covers, and the layer it sits at.

The layers are consistent across the whole tree:

| layer | what | chunks at that layer |
| --- | --- | --- |
| 0 | the body | 480 (18 body records) |
| 1 | shirt, trousers, boots, gloves | Torso_0 6,072 · Legs 3,394 · Feet 780 · Hands 217 |
| 2 | jacket | Torso_1 9,585 |
| 3 | undersuit | 7,508 |
| 4 | armour and helmets | torso 520 · legs 527 · arms 894 · helmets 653 |

There are **48 zone names**: the body's own 30 (`torso01..04_zone`,
`underwear_zone`, `underwear_top_zone`, `hips_zone`, `l/r_shoulder_zone`,
`l/r_arm01..05_zone`, `l/r_hand_zone`, `l/r_leg01..04_zone`, `l/r_foot_zone`),
the jacket-over-shirt seams `l/r_arm05_torso0_zone`, and armour's own
`omega_*` and `theta_*` zones. The reading is the one the numbers suggest: a
zone on a lower layer is not drawn where a higher layer covers it, so a shirt
hides the skin of the chest and not the forearms, and a jacket hides the
shirt's sleeves. That is how the game avoids skin poking through cloth, and it
is data, not depth.

`VisibleLayers` is set on 478 shirt chunks and 128 jacket chunks, always to
`[0]`; `VisibilityConditions` is present on about 250 items, and the ones
inspected carry empty port lists. What `VisibleLayers [0]` means -- most
likely "leave the skin under this chunk drawn" -- is for Phase 0 to settle,
not to guess.

### The body mesh is split into those zones

`m_body.skin` is 30 submeshes -- the "30 bone-parented regions" RENDERING.md
Phase 4 already noticed -- each with a node index, plus a sorted table of 30
32-bit words. Thirty zones, thirty submeshes, and each node index points into
that table. Which word is which zone is settled under "Phase 0, as run".

### Clothing is armour-shaped everywhere else

- **Geometry**: the same tree -- a carry prop at the root (`box_clothing_1_*`),
  then `f_*.skin` and `m_*.skin` with display and prop children --
  so `select_wearables` picks the worn mesh unchanged.
- **Materials**: `LayerBlend_V2`, with the odd `Illum` light, so the live
  compositor, tint palettes and decals already work.
- **Counts**, by slot: jackets 558, trousers 382, shirts 346, footwear 322,
  hats 211, gloves 140, torso accessories 10, clothing backpack 1 -- about
  1,970, of which about 1,900 are player clothing (`pu_clothing`,
  `pu_bespoke`), about 50 Squadron 42 crew uniforms (`s42_clothing`), and the
  rest medical-bay and armour-folder oddities.
- **Head items**: 77 hair, 51 beards, 15 eyewear and goggles, 80 piercings.

## Phase 0, as run

**Every character mesh carries a zone table, and the node index points into
it.** After the submesh list, a sorted run of 32-bit words, one per zone; each
submesh's `node_parent_index` is its zone's position in that run. The same
zone has the same word in every mesh that has it -- the body's torso and arm
words turn up in 100 shirt and jacket meshes. The words are not the CRC32,
CRC32C, any of the other CRC-32 variants, FNV-1/1a, djb2, MurmurHash3 or
xxHash32 of any spelling of the names, so they are named another way.
`examples/zone_words.rs` dumps every mesh's table.

**The body's zones, named from geometry and coverage** (`web/core/src/zones.rs`).
The male body is 30 submeshes and the female 31, sharing 30 words. Off-centre
submeshes split by side -- the character faces +y, so left is -x -- the arms
by distance out (shoulder, `arm01`..`arm05`, hand) and the legs top to bottom
(`leg01`..`leg04`, foot). The six central ones take the evidence of which
items cover them:

| zone | where | what decided it |
| --- | --- | --- |
| `vneck` | the narrow V at the collar, 75 vertices | shirts without it are the V-necks |
| `torso01` | upper chest, front only | open-collar shirts leave it bare |
| `torso02` | abdomen, front only | jackets with lapels cover it and skip `torso01` |
| `torso03`, `torso04` | middle and lower back | open-front jackets cover just these two |
| `underwear` | the pelvis, 1,471 vertices | armour legs cover only it |
| `underwear_top` | the female's extra submesh | the bra area |

`hips_zone` is **not on the body**: it is a garment zone, a shirt's hem or a
trousers waistband, and it is what jackets and long shirts hide.

**`VisibleLayers`, settled.** It appears only on the last zone a sleeve
reaches -- `arm02` on 119 short-sleeved shirts, `arm05` at the wrist of 93 long
ones, the shoulders under a tank top's straps -- always as `[0]`. The item
covers the zone at its layer but leaves the body drawn there, because it ends
part way across it. Rendered: short sleeves end over drawn forearm, with no
gap of missing skin.

**The rule, proven.** `three/zones.ts`: a submesh on layer K is not drawn
where an item on a higher layer lists its zone, unless that chunk's
`VisibleLayers` includes K. Worn through `Kitbasher.wearClothing` on both
bodies -- `eld_shirt_04` (layer 1), `dmc_pants_05` (1), `gsb_boots_03` (1),
then `drn_jacket_01` (2) over them. Under the shirt and trousers the body keeps
12 of its 30 zones -- `arm02`..`arm05`, the hands and the ankles (`leg04`) --
and under the jacket only the wrists, hands and ankles, with the shirt beneath
hidden entirely. No skin through cloth anywhere in the renders; skin
where the sleeves and the trousers end.

**Only the body and shirts carry zone tables, and that is enough.** Of the
clothing meshes, 96 of 100 shirt meshes are fully zoned (1,712 of their 1,819
submeshes named by the body's words), while 212 of 221 jackets, 130 of 144
trousers, 114 of 120 boots, every glove and 80 of 84 hats have no table at
all. That fits the layering: what gets covered by other clothing is the body
and, under a jacket, the shirt. Outer garments are never hidden, so they need
no zones.

**Garment-only zones are the open item.** 45 words appear in garments and not
on the body, most in a single garment each: hems, cuffs, the `omega_*` zones
armour covers. The records cannot name them -- every statistic tried measures
garment type rather than zone, since shirts and jackets list the `omega_*`
zones and trousers do not. One is named because the evidence is unambiguous:
`232552810`, shared by 35 shirt meshes, an all-round band at the waist, whose
records list `hips_zone` 271 times in 273. Before it was named, the female
shirt's hem showed as a white strip under the jacket. The rest are for Phase
2, by where each submesh sits (a hem at the waist is `hips`, a cuff at the
wrist `arm05_torso0`).

## Phase 1, as run

**The eight types map to eight slots**, named for what they are rather than the
port: `Char_Clothing_Hat` hat, `Torso_0` shirt, `Torso_1` jacket, `Torso_2`
accessory, `Hands` gloves, `Legs` trousers, `Feet` footwear, `Backpack` pack.
A slot belongs to one outfit, so the slot decides `outfit`; the armour slot
names are unchanged. Counts reproduce the survey exactly: jackets 558,
trousers 382, shirts 346, footwear 322, hats 211, gloves 140, accessories 10,
pack 1.

**The clothing type is read before the class-name hints.** 40 records were in
the armour catalogue only because their names matched an armour word, and now
land where their type puts them: the Ready-Up Helmet's 28 colourways are hats
(the game wears them on the head's `Hat` port), the ThermoWeave Breathing
Apparatus is the one clothing pack, the medical bay's ten "Body" meshes are
shirts, gloves and trousers (still hidden by the listing's anatomy rule), and a
`<= PLACEHOLDER =>` is an accessory. Armour went from 2,486 items to 2,446.

**Items carry `chunks` and `hidden`**, schema 5 on both sides.
`chunks` is `SCItemClothingParams.Chunks` as `{zone, layer, visible}` -- it
used to ride along raw in `stats.Chunks`, where nothing read it, and is out of
`stats` now. `VisibilityConditions` is left out: 48 chunks carry an empty one,
and the rest tie an undersuit's or armour's zone to the armour ports, which the
armour outfit does not draw by zone. `hidden` is `HiddenParts`, port names with
the repeats dropped (`sc_nvy_bdu_jumpsuit_02_01_17` lists `Clothing_Torso_0`
twice).

**Squadron 42 is flagged by folder**, `clothing/s42_clothing/`: 50 items,
hidden by the web listing. Only clothing -- S42 armour under
`armor/s42_armor/` was already in the armour catalogue, and moving it is not
this plan's call.

**Clothing names needed their own slot words.** They have armour's shape with a
garment for the slot -- "Toughlife Boots Dark Red", "Keldur Hat and Hickory
Goggles" -- and `product_key` stops only at armour's words, so every clothing
colourway keyed on its whole name and was a family of one: 58 families across
1,970 items. A garment list (jacket, pants, boots, shirt, t-shirt, hat, mask,
apron and 44 more) read **only for clothing slots** gives 261 families holding
1,649 items, and cannot move an armour key: measured against the schema-4
manifest, 0 of 2,446 armour items changed set, family or name. The six
clothing families that share no name prefix are unnamed items keyed on class
names, as armour's three are.

**The pipeline stays armour-only.** `scx convert`, `scx variants`, `scx sets`
and `scx audit` read `Manifest.armour()`; the local viewer drops clothing when
it parses the manifest, keeping `Item.slot` the six armour slots.

## Phases

| phase | what | size |
| --- | --- | --- |
| 0 | zones: map submeshes to zone names, prove the hiding rule on one outfit | spike |
| 1 | catalogue clothing (both catalogues, schema 5) | small |
| 2 | the outfit model: ports, HiddenParts, layer/zone visibility | medium |
| 3 | UI: an Armour / Clothing switch and the clothing slots | medium |
| 4 | head items: hats, eyewear, hair | small |
| 5 | gear with clothing | small |

### Phase 0 -- zones

A spike, because everything after it rests on it. Map each of `m_body.skin`'s
30 submeshes to a zone name -- by the hash if it can be found, by geometry if
not (centre, side and parent bone decide it) -- and the same for one shirt, one
jacket and one pair of trousers, whose meshes carry their own zone
submeshes. Then wear shirt, jacket and trousers on the figure with the rule
"a zone is hidden when a higher layer covers it" and settle `VisibleLayers`
against it.

**Exit:** the three items on the male and female figure with no skin through
cloth and no missing skin at the cuffs, collar or waist; the rule and the
`VisibleLayers` meaning written down with the item that decided them.

### Phase 1 -- catalogue

`slot_for` learns the eight `Char_Clothing_*` types in the Python catalogue
and `web/core/src/catalog/build.rs` together; `full_diff` stays 100% both
ways. Items gain `outfit: armour | clothing` and their `Chunks` and
`HiddenParts`; schema 5 on both sides. Squadron 42 crew uniforms are flagged
the way `test` and `placeholder` are, so they can be hidden. Variants, product
lines and swatches come for free from the existing rules -- check they hold,
because clothing names ("Drake Jacket Blue") may not follow armour's "Line Slot
Edition" shape.

**Exit:** the clothing counts above reproduced by both catalogues; colourway
families that share a name prefix, as `CLAUDE.md` requires of armour.

### Phase 2 -- the outfit model

The engine gains the ports, not just slots: body ports for clothing and the
undersuit, undersuit ports for armour. Equipping an undersuit hides the
clothing it lists; equipping clothing while armour is worn asks the caller to
choose, since the game does not allow both. `HiddenParts` is applied
generically -- the helmet-hides-hair rule the figure already has becomes one
instance of it. Zone visibility is recomputed when the outfit changes, not
per frame: for each worn item and the body, a submesh is drawn unless an item
on a higher layer covers its zone.

**Exit:** a full outfit on both bodies, no poke-through in the harness views,
switching outfit and body carries what can carry; memory and fps against the
armour loadout.

### Phase 3 -- UI

An **Armour / Clothing** switch above the slot list, because the outfits are
exclusive. Clothing slots in the game's order: hat, shirt, jacket, torso
accessory, gloves, trousers, footwear, backpack. The listing, search, swatches
and equip-set work as for armour; equip-set groups by product line. Share links
carry the outfit and the clothing, schema-versioned so old links still restore.

**Exit:** a visitor can dress the figure from nothing and share it; an old
share link restores unchanged.

### Phase 4 -- head items

Hats sit on the head's port, not the body's, and helmets already hide them.
Eyewear and goggles likewise. Hair is optional: the figure has one hairstyle
today, and 77 more are there if wanted.

**Exit:** a hat and a pair of glasses on both heads, hidden correctly under a
helmet.

### Phase 5 -- gear with clothing

Clothing declares no holsters -- 251 jackets even hide `weapon_sidearm_attach`
-- so in the clothing outfit a weapon can only be in the hands. Holding a
weapon without drawing it from a holster needs a small change to `raised`.

**Exit:** hold a rifle and a pistol in a clothing outfit; holsters appear only
when armour does.

## Not planned

- **Clothing on the local Blender viewer.** Same decision as LOADOUT.md
  phase 5: the web kitbasher is the product.
- **Mixing clothing and armour.** The game does not allow it, and the data
  hides one under the other. If wanted later it is one switch -- ignore the
  undersuit's `HiddenParts` -- with the poke-through that follows.
- **Cloth simulation.** Coats and skirts ship simulated strands (`CA_PROW`,
  302 in the armour CDFs alone); they will hang rigid, as armour straps do.
