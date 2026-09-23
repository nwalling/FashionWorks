# LOADOUT.md — Weapons, holsters and the raised pose

A plan, scoped against build 1.0.191.55227 on 2026-09-23, and **built the same
day: Phases 0-4 are done in the web kitbasher** (`@fashionworks/web` 0.6.0).
Phase 5 -- gear in the local Blender viewer -- is **dropped**: decided on
2026-09-23 that the Blender viewer does not need weapons, so the plan is
complete. "Status" below says what each phase measured when it was run, and
where reality differed from the plan.
Everything under "What the data says" was measured against the real archive.

## Status

| phase | state | what it measured |
| --- | --- | --- |
| 0 -- one rifle on the back | done | P4-AR on the heavy core's `wep_stocked_attach_2_override` and on the CSP-68H's own side node, both bodies. Holstered: muzzle at (-0.146, 1.096, 0.202), grip (-0.05, 1.345, 0.2), against a left shoulder at (-0.196, 1.502, 0.021) and hip at (-0.099, 0.997, -0.006) -- vertical beside the spine, stock up. |
| 1 -- catalogue | done | 505 gear items, `ports` on every armour item, schema 4. `full_diff`: armour 2,475/2,475 and gear 505/505 both ways, 100% of fields. First catalogue build with gear 9.0 s (was 10.2 s without, same harness). |
| 2 -- holsters, every class | done | Rifle both sides, size-5 launcher refused on the left with the reason and taken on the right, pistol, knife, multitool, 4 grenades, 4 pens, 8 magazines, 4 more on an ammo-carrier pack; a fifth of each refused as full. Heavy to light core: "one rifle holster, two grenade points, four magazine points; P4-AR Rifle, 2 x MK-4 Frag Grenade came off". 20 items, 373k scene triangles: 59 fps. |
| 3 -- in hand, raised pose | done | Rifle raised and crouched, pistol and knife raised, both bodies, magazine travelling with the weapon. Left hand: median 2.6 cm from the weapon's surface over 53 meshes, p90 5.0 -- no IK. |
| 4 -- share URL, sets, hardening | done | v2 string round-trips armour, gear and the held port; a v1 string still decodes. Equip-set re-validates gear. Package budgets hold. |
| 5 -- local viewer | **dropped** | Decided: the Blender viewer does not need weapons. The Python side of Phase 1 stays, so the manifest carries gear and ports at parity with the port; nothing local renders them. |

Where it differed from the plan:

- **Precedence was not settled by a screenshot.** None was to hand. The rule
  is still outermost-wins, and the evidence for it is the data's own: a
  backpack ships `wep_stocked_attach_2/3_override` nodes either side of the
  pack, which only makes sense if the pack takes those holsters over.
- **The left-hand measure changed.** The plan said to measure `LeftHand`
  against the weapon's `L_IkGripTarget`; that helper turns out to sit at the
  *pistol grip*, mirrored from the right one, so it says nothing about the
  support hand. Distance from the left knuckle to the weapon's nearest vertex
  does, and is what was measured.
- **Colourways needed `geometryTags`,** which the plan did not know about: a
  weapon record picks its tagged `SubGeometry` child by it.
- **Two mesh shapes were new**: a `.cdf` whose model is a `.cga`, and multi-node
  `.cga`s whose groups live in their node's space. Both handled.
- **Raising the arms exposed an armour bug**, not a gear one: orphaned wrist
  piston weight on the Defiance arms, now resolved through the piece's own
  bone hierarchy (CLAUDE.md).

It targets the web kitbasher (`web/`), which is where the product lives now,
with the Python pipeline kept at catalogue parity the same way the rest of the
port is. Rendering weapons in the local Blender viewer was a separate, optional
last phase, and has been dropped.

## In short

Almost everything needed already exists, in the archive and in the port:

- **Armour declares its holsters as item ports.** Each port names the bone the
  item hangs from, the types and sizes it accepts, and the locator on the item
  that meets the bone. The count really is decided by the armour: a heavy core
  carries two rifle holsters, four grenade points and eight magazine points; a
  light core one, two and four. Legs carry the sidearm, the two utility points
  and the four pen points regardless of weight. Arms and helmets carry none.
- **Every one of those bones is already in our armature.** All 36 attachment
  points the port grafts from its two donors are the ones the ports name --
  `wep_stocked_attach_2/3_override`, `grenade_attach_1..4_override`,
  `magazine_attach_1..8_override`, `wep_sidearm_attach_override`,
  `utility_attach_1/2_override`, `medPen_/oxyPen_attach_1/2_override`,
  `gadget_attach_1_override`. Nothing new has to be grafted.
- **Every holsterable item carries the locator the port names**,
  `attach_offset_left_01` / `attach_offset_right_01`, whether it is a rifle, a
  pistol, a knife, a magazine, a medpen, a grenade or a multitool. Placement is
  the same `bone_world · locator⁻¹` the backpack already uses.
- **The held weapon goes on `RightWeaponBone`**, a bone the base skeleton has,
  and **the raised pose is in the archive**:
  `stocked_alerted_stand_idle_turn360_raised` animates that very bone. It
  retargets today, through `anim-dump` and the same `retargetPose` the idle
  and crouch use: 148 bones, 0 unresolved, on the male; the female rig ships
  the same clip.
- **Weapons are `LayerBlend_V2`**, like armour, with the same tint palettes.
  The compositor needs no new shader.

Two things are genuinely new. Weapons, pens and grenades are rooted in a
**`.cdf` + `.chr`** rather than a `.skin` or a `.cga`, so the item loader needs
a third shape. And the catalogue and the loadout need a **port model**: which
piece owns which holster, what fits, and what comes off when the owner changes.

## What the data says

### Holsters are item ports, and the count follows the torso's weight class

Every armour record carries `SItemPortContainerComponentParams.Ports[]`. Read
across all 1,741 `pu_armor` records the pattern is exact -- there are no
exceptions inside a weight class:

| piece | weight | holsters it declares |
| --- | --- | --- |
| torso | Light (199) | `wep_stocked_3`, `grenade_attach_1..2`, `magazine_attach_1..4`, `gadget_attach_1`, `backpack` |
| torso | Medium (135) | `wep_stocked_2..3`, `grenade_attach_1..3`, `magazine_attach_1..6`, `gadget_attach_1`, `backpack` |
| torso | Heavy (136) | `wep_stocked_2..3`, `grenade_attach_1..4`, `magazine_attach_1..8`, `gadget_attach_1`, `backpack` |
| legs | all (462) | `wep_sidearm`, `utility_attach_1`, `utility_attach_2`, `medPen_attach_1..2`, `oxyPen_attach_1..2` |
| backpack | all (137) | `wep_stocked_2..3`, `gadget_attach_1` |
| backpack | 4 mag carriers | `magAttach_1..4`, `wep_stocked_3` (Large only) |
| undersuit | standard (163) | `wep_stocked_3`, `wep_sidearm`, `utility_attach_1`, `magazine_attach_1..2`, `medPen_attach_1`, `oxyPen_attach_1` |
| undersuit | flight suits (24) | the whole heavy set |
| arms, helmet | all | none |

So a light core holds **one** primary and a medium or heavy core two, which is
the user-visible rule the game enforces. The backpack port's `MaxSize` also
follows the torso's weight -- 1, 2, 3 for light, medium, heavy -- which the
kitbasher does not enforce today and should.

What each port accepts, as declared (identical wherever the port appears):

| port | accepts | size | bone on the body | locator on the item |
| --- | --- | --- | --- | --- |
| `wep_stocked_2` (backLeft) | `WeaponPersonal:Medium`, `:Gadget`, `FPS_Deployable:Medium` | 2–4 | `wep_stocked_attach_2_override` (Spine3) | `attach_offset_right_01` |
| `wep_stocked_3` (backRight) | `WeaponPersonal:Medium/Large`, `:Gadget`, `FPS_Deployable:Medium` | 2–5 | `wep_stocked_attach_3_override` (Spine3) | `attach_offset_left_01` |
| `wep_sidearm` | `WeaponPersonal:Small/Rocket` | 1 | `wep_sidearm_attach_override` (right thigh) | `attach_offset_left_01` |
| `utility_attach_1` | `WeaponPersonal:Gadget/Rocket`, `RemovableChip:Hacking` | 1 | `utility_attach_1_override` (left thigh) | `attach_offset_right_01` |
| `utility_attach_2` | `WeaponPersonal:Knife/Gadget` | 1 | `utility_attach_2_override` (right thigh) | `attach_offset_left_01` |
| `medPen_attach_N`, `oxyPen_attach_N` | `FPS_Consumable` | 1 | `*_override` (left thigh) | `attach_offset_left_01` |
| `grenade_attach_N` | `WeaponPersonal:Grenade`, `FPS_Deployable:Small` | 1 | `grenade_attach_N_override` (Spine3) | `attach_offset_left_01` |
| `magazine_attach_N` | `WeaponAttachment:Magazine/Rocket` | 1 | `magazine_attach_N_override` (Spine1) | `attach_offset_left_01` |
| `gadget_attach_1` | `Gadget` | 1–2 | `gadget_attach_1_override` (Spine1) | none |

Two consequences worth stating. A **Large** weapon (size 5: HMGs, launchers,
the railgun) fits only `wep_stocked_3`, the right side of the back. And the pen
ports do not distinguish medpen from oxypen -- both accept any `FPS_Consumable`
-- so the names are labels, not rules.

The only field on the body that mentions holstering, `holsterWeapon`, is an
interaction flag on the usable state machine and has nothing to do with ports.

### Which piece owns a holster when two declare it

Both the torso and the backpack declare `wep_stocked_2`, `wep_stocked_3` and
`gadget_attach_1`, and nothing in the records links them: `linkedItemPorts`,
`itemPortRules`, `PortTags` and `RequiredPortTags` are empty on every one.

The backpack answers the question itself. It is a rigid `.cga` with no bones,
and **it carries its own helper nodes named exactly like the skeleton's**:
`cds_combat_heavy_backpack_01.cga` has nine nodes, among them
`wep_stocked_attach_2_override` at (-0.194, 0.155, 0.153),
`wep_stocked_attach_3_override` at (+0.194, 0.155, 0.153) and
`gadget_attach_1_override` at (0, -0.263, 0.199), in the pack's own frame --
one either side of the pack, which is where a pack-wearer's rifles visibly sit
in the game, and which is how the request describes them. The torso's bones sit
at ±0.124 on Spine3, where a rifle sits with no pack on; the torso's ports also
carry `invis_p1`, which the backpack's do not.

So the rule this plan adopts is **the outermost owner wins**: backpack over
torso over undersuit for the back and the gadget; torso over undersuit for
grenades and magazines; legs over undersuit for the thigh. It is a reading of
the data, not a statement in it. Phase 0 checks it against one in-game
screenshot before anything is built on it.

### Every holsterable item carries the locator the port names

Confirmed on one item of every class, by dumping its own nodes or bones:

| class | asset | locators | also carries |
| --- | --- | --- | --- |
| rifle (P4-AR) | `brfl_fps_behr_p4ar.chr`, 26 bones | `attach_offset_left_01` (-0.028, -0.043, 0.100), `attach_offset_right_01` | `R/L_IkGripTarget` (+ `_HumanFemale` twins), `magAttach`, `sight_attachment`, `barrel_attachment`, `underbarrel_attachment`, `weapon_term` (muzzle), `ADS_align`, `bolt`, `trigger01/02` |
| pistol (LH86) | `bpst_fps_gmni_LH86.chr`, 37 bones | both | grips, `magAttach`, `slide`, `hammer`, `weapon_term` |
| knife (VNCL) | `vncl_melee_01.cgf`, NMC nodes | both | `grip_right_1` |
| magazine | `mgzn_s03_behr_5rb_01.cgf`, NMC nodes | both | `grip_left/right_1` |
| medpen | `gdgt_fps_crlf_medical_pen.chr` | both | `L/R_IkGripTarget_Ctr`, `needle`, `fluid_*` |
| grenade (MK4) | `gren_frag_behr_mk4.chr` | both | `cap`, `button` |
| multitool | `gdgt_fps_grin_multitool.chr` | both | `weapon_term`, `magAttach`, `canister_attachment`, `grip` |

Two shapes, then: on a `.cdf`-rooted item the locator is a **bone in its
`.chr`**; on a `.cgf` item it is an **NMC helper node**, which is what
`socket::mount_for` already reads. One exception found: the rotary
`mgzn_s04_behr_40gb_01.cga` has no `attach_offset` nodes at all, only its
rotator and chambers, so an item without a locator sits at the bone's origin.

The locator's rotation is not identity -- the rifle's `attach_offset_right_01`
is `[0.5, 0.5, -0.5, 0.5]` -- and that is what turns a rifle muzzle-up on the
back. Nothing about the placement is per-class.

### The held weapon

The body record (`body_01`, the Player's `Body_ItemPort` child) declares
`weapon_attach_hand_right` on helper **`RightWeaponBone`** and
`weapon_attach_hand_left` on `LeftWeaponBone`, both with **no item-side
locator**, flags `selfphys select uneditable usegripdata`. Both bones are in the
base 220-bone `.chr`, children of `RightHand` and `LeftHand`. So a held weapon
is the weapon's own origin placed on `RightWeaponBone`, and nothing else.

`usegripdata` is the game IK-ing the hands onto the weapon's `R/L_IkGripTarget`
through the `Animation_Driven_IK_Targets` block in the chrparams
(`RWeapon_IKTarget`, `LWeapon_IKTarget`, ...). A static pose frame does not get
that refinement; see the risk below.

### The raised pose is in the archive, and retargets today

The male chrparams wires `Animations/Characters/Human/male_v7/*/*.dba` by
wildcard, so every database under the skeleton is its own. The weapon sets:

| set | male DBAs | full-body idle clips of interest |
| --- | --- | --- |
| `stocked/` (rifles, SMGs, shotguns, LMGs, snipers) | 12 | `stocked_alerted_stand_idle_turn360_raised` (148 ch), `..._turn360_planted` (147, weapon ready, lowered), `stocked_alerted_crouch_idle_01` (148) |
| `pistol/` | 13 | none full-body; `pistol_alerted_stand_idle_upperbody_01` (89 ch, spine up), `pistol_alerted_crouch_idle_iron_01` (116) |
| `knife.dba` | 1 | `knife_alerted_stand_idle_01` (149) |
| `grenade.dba`, `grin/multitool.dba`, `select_deselect.dba`, `reloads.dba` | -- | transitions and overlays, no standing idle |

Dumped through `tools/anim-dump` against `bhm_skeleton_v7.chr` and our
`male.skeleton.json`:

| clip | bones resolved | `RightWeaponBone` | hands | hips |
| --- | --- | --- | --- | --- |
| `stocked_alerted_stand_idle_turn360_raised` | 148, 0 unresolved | animated, rotation and position | both | yes |
| `knife_alerted_stand_idle_01` | 149, 0 unresolved | animated | both | yes |
| `pistol_alerted_stand_idle_upperbody_01` | 89, 0 unresolved | animated | both | **no** -- upper body only |
| `stocked_alerted_crouch_idle_01` | 148, 0 unresolved | animated | both | yes |

**The raised clip animates `RightWeaponBone` itself.** Parent the weapon there,
apply the clip, and the gun is in the hands with no IK on our side. An
upper-body clip has to be layered over a full-body one for the legs, which is
exactly how the game uses it; that is a small change to `applyClip`.

The female rig mirrors all of it: 42 weapon DBAs under `female_v2/weapons/`,
and its `stocked/locomotion/stand.dba` (350 clips) carries
`stocked_alerted_stand_idle_turn360_raised` (147 ch) and
`stocked_alerted_stand_idle_01` (123). Two gaps: the female `knife.dba` has
only the upper-body idle, and neither body has a full-body pistol idle.

### Weapons render with the shader we already composite

The P4-AR's `brfl_fps_behr_p4ar_mat.mtl` declares 12 submaterials: **9
`LayerBlend_V2`** (`Paint_01_A/B/C`, `Parkerized_01_A/B/C`, `L_Plastic_02_A`,
`Bronze_01_A`, `Copper_01_A`), a `NoDraw` collision proxy, and `Decals` and
`POM` on `MeshDecal` (`Illum` on two colourways) pointing at a brand-wide
`behr_decals_diff`/`behr_pom_diff`. It carries its own `_ddna`, `_hal` and
`_wear` control maps at 2K, split into mip streams like armour's. Its tint
palette, `behr_weapon_default`, is a `TintPaletteTree` with `entryA/B/C` and
the same colour-plus-specular pairs; **231 weapon palettes are already in the
DCB export cache**, because the export takes `**/tintpalettes/**`.

Footprint of one rifle: `parts.skin` 23,582 vertices, 31,151 triangles, 16
submeshes; 2.8 MB across its six LOD `.skinm`; about 10 MB of control-map top
mips. A helmet's worth.

### The records, and how a colourway is declared

| type | records | distinct meshes | where |
| --- | --- | --- | --- |
| `WeaponPersonal:Medium` (stocked) | 274 | 42 | `scitem/weapons/fps_weapons` |
| `WeaponPersonal:Small` (pistols) | 72 | 12 | same |
| `WeaponPersonal:Large` (size 5) | 19 | 5 | same |
| `WeaponPersonal:Knife` | 28 | 17 | `scitem/weapons/melee` |
| `WeaponPersonal:Gadget` (multitool, tractor, binoculars, extinguisher) | 36 | 5 | `fps_weapons` |
| `WeaponPersonal:Grenade` | **2** | 2 | `scitem/weapons/throwable` |
| `WeaponAttachment:Magazine` | 63 | 60 | `scitem/weapons/magazines` |
| `FPS_Consumable` (pens, packs, chips) | 40 | 4 | `scitem/consumables` |
| `Gadget` (2H mining, deployables) | 10 | 4 | `scitem/weapons/devices` |

The DataCore holds 461 `WeaponPersonal`; the 25 outside those directories are
glowsticks, flares, tablets and spawners. This build ships **two grenades**
(`behr_gren_frag_01`, `ksar_gren_frag_01`), and the UI must not imply more.

The `AttachDef.Tags` name the animation set: `stocked` (302), `pistol` (72),
`knife` (28), `multitool` (22), alongside `rifle`/`smg`/`shotgun`/`lmg`/`sniper`
and the product line (`behr_rifle_ballistic_01`, 16 records).

**A colourway is declared on the geometry root**, as armour does it: the root
node carries the `.cdf` plus the record's own `.mtl` and/or `Palette`.
`behr_rifle_ballistic_01_green01` has `..._mat_green_01.mtl` on its root;
`_tint01` has the same mesh with `behr_weapon_black`; `_sf01` a cosmetics `.mtl`
and a KSAR palette. The `SubGeometry` children are **tagged alternates for
other records** (`Tan01`, `Green01`, `Mr01`, and `tableDisplay`/`empty` display
meshes) and must be ignored -- the opposite of armour, where the worn mesh
lives in the children and the root is a crate.

A `.cdf` is small: `<Model File="….chr" Material="…">` plus a `CA_SKIN`
`parts.skin` and a `CA_BONE bullet`. 397 of the 436 weapons are `.cdf`-rooted;
knives and magazines are plain `.cgf`. The magazine that ships with a weapon is
in `SEntityComponentDefaultLoadoutParams.loadout.entries[]`
(`magazine_attach` → `behr_rifle_ballistic_01_mag`); optics, barrel and
underbarrel default to empty. The weapon's own `magazine_attach` port names
bone `magAttach` and no item locator, so the magazine's origin sits on it.

## Design

### The port model

Two additions to the catalogue item, on both sides of the parity line:

```
armour item:   ports: [{ name, owner_slot, types: [{type, subtype}],
                         min_size, max_size, helper, offset_helper, select_tag }]
gear item:     attach: { type, subtype, size, anim_set }      // anim_set from Tags
               default_children: [{ port, class_name }]       // the magazine
```

and a new `slot` vocabulary for gear, parallel to the six armour slots:
`primary` (Medium/Large stocked), `sidearm` (Small), `knife`, `gadget`,
`grenade`, `magazine`, `consumable`. Hacking chips and keycards are
`utility_attach_1` items on paper and cards on screen; they are out for now.

The loadout gains `carrying: Map<portName, item>` beside `wearing`. A port is
**resolved to its owner at bind time** by the outermost-wins rule above, and
re-resolved whenever the torso, legs, undersuit or backpack changes.

**Acceptance** is the port's declaration and nothing else: the item's
`(type, subtype)` is in the port's list and `min ≤ size ≤ max`. A Large weapon
offered to `wep_stocked_2` is refused with the reason, and the UI greys the
side that does not fit.

**Removal says why.** Swap a heavy core for a light one and `wep_stocked_2`,
`grenade_attach_3..4` and `magazine_attach_5..8` cease to exist; the items in
them come off and the status says so -- "light core: one rifle holster, two
grenade points, four magazine points; the LMG, two grenades and four magazines
came off" -- the same rule equip-set already follows. Nothing disappears
silently.

### Placement

`socket::place` and `socket::mount` stay exactly as they are. What changes is
where the locator comes from and where the bone comes from:

- the locator is the port's **declared** `offset_helper`, not a name derived
  from the bone's, looked up among the item's NMC helpers (`.cgf`/`.cga`) or
  its `.chr` bones (`.cdf`-rooted); absent, the item sits at the bone's origin;
- for a **skeleton-owned** port the bone is the armature's, as for the backpack;
- for a **backpack-owned** port the bone is `backpack_mount · helper_node`, so
  `loadProp` has to return the backpack's helper transforms, not only their
  names as it does now;
- for the **magazine on a weapon** the bone is the weapon's `magAttach`, and the
  weapon carries its magazine wherever it goes.

The item is parented to its owner -- bone, backpack mesh or weapon -- so
posing carries everything for free, as it does the backpack.

### The held item and the raised pose

One item is "in hand" at a time, chosen from what is holstered; holding it
takes it out of its holster, as in the game. It is parented at
`RightWeaponBone` with identity offset. The pose set gains **ready**
(`..._turn360_planted`), **raised** (`..._turn360_raised`) and **raised
crouch**, chosen per the held item's `anim_set`:

| anim set | stand ready / raised | crouch | female |
| --- | --- | --- | --- |
| `stocked` | `stocked_alerted_stand_idle_turn360_planted` / `_raised` | `stocked_alerted_crouch_idle_01` | same clips |
| `pistol` | `pistol_alerted_stand_idle_upperbody_01` over `nw_stand_idle_turn360_planted` | `pistol_alerted_crouch_idle_iron_01` | same |
| `knife` | `knife_alerted_stand_idle_01` | upper-body over the crouch idle | upper-body only |
| `multitool` | deferred | -- | -- |

With nothing in hand the weapon poses are disabled, with a title saying so.

**The left hand is the open risk.** Each clip was authored against one
reference weapon; the game then IK-s both hands onto the held weapon's grip
targets, and a static frame will not. Phase 3 measures the distance from
`LeftHand` to the weapon's `L_IkGripTarget` in world space across all 42
stocked meshes; if the median is more than a couple of centimetres a two-bone
IK on the left arm goes in, aimed at that bone. Not before it is measured.

### Loadout encoding

Today: armour ids, comma-separated, in `SLOTS` order. Version 2 appends
`;port=id` pairs and `;hold=port`, and the decoder accepts the old form
unchanged. It stays an opaque string to the host, so `WEB-INTEGRATION.md` does
not change.

### UI

The toolbar already wraps, and gear would add seven tabs to six. So: an
**armour / gear** switch that swaps the slot tab set, everything else in place.
Equipping a gear item goes to the first free port that accepts it; where more
than one does (grenades, magazines, pens, the two back holsters) a small port
row under the swatches shows which are filled and lets one be chosen. The
status strip reports placement and every removal.

### Pipeline parity

The Python catalogue admits the same record roots (`dcb.DEFAULT_FILTERS` gains
`**/entities/scitem/weapons/**` and `**/entities/scitem/consumables/**`),
`fields.py` gets the port and loadout field paths, `manifest.py` goes to
schema 4 with `ports`/`attach`, and `full_diff` stays at **100% on every field
in both directions** -- the discipline that caught the 140 phantoms. Rendering
weapons locally was Phase 5, and is dropped.

## Phases

**Phase 0 — Spike: one rifle on the back**

Hard-code the P4-AR. In the core, a `.cdf`-rooted branch of `loadProp`: read
the `.cdf`, load its `.chr` for the bones and its `parts.skin` at bind pose,
and find `attach_offset_left_01` among the bones. In the engine, mount it on
`wep_stocked_attach_3_override`, composite it with the existing pipeline, and
look at it -- then put the CDS heavy backpack on and mount it on the pack's own
helper instead. Measure where `weapon_term` (the muzzle) and the stock land
relative to the shoulder and hip, on both bodies.
**Exit:** a rifle sits on the back muzzle-up on both bodies, on the torso and on
the pack, with the numbers recorded; and one in-game screenshot settles
backpack-over-torso precedence, which the rest of the plan assumes.

**Phase 1 — Catalogue: records and ports**

Admit weapons, melee, throwables, magazines, consumables and 2H gadgets on
both sides. Per gear record: `attach`, root-node geometry with its `.mtl` and
palette, tagged children ignored, `default_children` from the loadout,
families by shared `.cdf` and product tag. Per armour record: `ports[]`.
Schema 4; `catalog/mod.rs` and `catalog.py` slot tables; `readCatalogue`
grouping; the count in `scx catalog`.
**Exit:** `full_diff` reports 100% on every field, old and new, over every
item, both ways; the browser builds the catalogue inside the current time
budget (the DCB is already read whole -- this is more records to parse, not
more bytes to fetch); tests cover port parsing on a torso fixture, root-only
geometry on a weapon fixture, and the default magazine.

**Phase 2 — Holsters, every class**

Generalise `loadProp` (declared locator, three bone sources, helper
transforms), add `carrying` with resolution, acceptance and removal-with-reason
to the engine, and the armour/gear switch, gear tabs and port row to the UI.
Place and eyeball every class: rifle, LMG (right side only), pistol, knife,
multitool on the thigh and on the back, four pens, four grenades, eight
magazines, a mag-carrier backpack. Watch the engine's `cache` -- it has no
eviction, and gear multiplies what it holds; measure, and give it a byte budget
if a full loadout on both bodies pushes it past a few hundred MB.
**Exit:** a full heavy loadout equips from the UI, survives torso and backpack
swaps with exactly the right removals and a reason for each, and the frame
rate holds at the triangle count it adds (about 150k for the lot). Tests:
outermost-wins resolution, size-5 refused on the left, removals on a heavy→light
swap, locator lookup on both item shapes.

**Phase 3 — In hand, and the raised pose**

The hold control, `RightWeaponBone` parenting, the per-set clip table, layering
an upper-body clip over a full-body one, and the female set. Then the
left-hand measurement across the stocked meshes, and IK only if it says so.
**Exit:** raised with a rifle on both bodies, pistol and knife raised, the
magazine travelling with the weapon; the hand-gap table recorded in
`CLAUDE.md` with the decision it led to.

**Phase 4 — Share URL, sets, hardening**

Loadout encoding v2 with the old form still decoding; equip-set leaves gear in
place and re-validates it; `check-package.mjs` budgets still met; `WEB.md`
pointed here; CLAUDE.md's verified facts updated with what the phases measured.
**Exit:** a shared URL restores armour, gear and the held item; the package
budgets pass; the 40-check hosting test on Hangarworks is untouched, because
nothing on the host changes.

**Phase 5 — Local viewer parity (dropped)**

Not being built: the Blender viewer does not need weapons. Recorded as it was
scoped, in case that changes. Only if the Blender viewer is still wanted as a
renderer: `scx convert` for
`.cdf`-rooted props (cgf-converter takes a `.chr` to Collada and a `.skin` with
`-dae`), `normalize_armor` placing them by the same locator rule, the React
viewer's `SlotPanel` growing the gear tabs.

## Risks

- **Precedence is inferred.** The outermost-wins rule reads the data; the
  engine's rule is not written in it. Phase 0's screenshot check costs an hour
  and decides it before anything depends on it.
- **The left hand.** Static frames do not IK. Measured before it is solved.
- **Bind pose is the assumption for `.skin` weapons.** A weapon's skin at rest
  should be bolt-closed, magazine-in; Phase 0 confirms on the P4-AR before the
  loader is generalised.
- **Memory.** Every distinct weapon costs a helmet's worth of textures, and the
  engine's cache never evicts. Phase 2 measures and budgets.
- **Non-LayerBlend submaterials.** `NoDraw` proxies must be hidden, and the
  `MeshDecal`/`Illum` decal submeshes are real diffuse decals here, unlike the
  inert armour atlases; first pass skips them, and a plain textured fallback is
  a later polish.
- **Two grenades.** The data is the data; the UI should show two, not a rack.

## Non-goals

- Optics, barrels and underbarrels (180 `WeaponAttachment` records beyond the
  magazines). The ports and helpers are there; it is a later phase, not this
  one.
- Animation playback, firing, reloads. Poses are single frames.
- Hacking chips, keycards, glowsticks, flares, deployables, ship weapons,
  clothing.
- Serving any of it from the host. Every byte still comes from the visitor's
  own `Data.p4k`.

## Open questions

Built with the plan's defaults; each is a one-line change if the answer differs.

- **Backpack-versus-torso precedence:** built as the backpack (outermost
  wins). A screenshot of a pack-wearer's rifles in game would confirm it.
- **Magazines:** built as user-placed from the magazine tab; a weapon's own
  magazine rides in the weapon. Auto-filling to match the primary is not done.
- **UI:** built as the armour/gear switch.
- **Does the local Blender viewer need weapons at all?** No -- decided
  2026-09-23. Phase 5 is dropped.
