# CLOTHING.md — Clothing as a wearable layer

A plan, scoped against build 4.10.193.11644 (`sc-alpha-4.10.0`, 2026-09-24),
for letting a visitor dress the figure in clothing -- shirts, jackets, trousers,
boots, gloves, hats -- instead of the armour layer. Everything under "What the
data says" was read out of this build's DataCore; everything under "Phases" is
a proposal with an exit test.

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
32-bit words. Thirty zones, thirty submeshes. **Which submesh is which zone is
not yet known**: the words are not the CRC32 of the zone names or of any bone
name, nor FNV-1/1a, djb2 or CRC32C of any spelling tried. The submeshes' own
centres make a geometric assignment easy if the hash stays hidden -- hands at
x ±0.64, feet at z 0.06, the arm segments in order along the arm.

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
