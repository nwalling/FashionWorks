# Web kitbasher

The web kitbasher's surfaces and its gear: compositing, glow, stencils, holsters and the held weapon.

### The web viewer's surfaces, rebuilt (2026-09-23)

Five reported bugs, four causes, all in the port rather than the data.

**The viewport going white was the compositor leaking WebGL contexts.**
`compositeSurfaces` created a context per call and never released one, and
every listing swatch was a composite too. Chrome keeps sixteen and then drops
the *oldest* -- the viewer's own -- which renders as a white canvas with a
broken-image icon. There is now one shared compositing context. Measured
after: 30 torsos equipped and 40 swatches composited, context intact.

**The striped Sunchaser padding was moire.** Layer textures tile 20-2560
times across the UV square and were sampled into a 1024 bake from a
single-level array with `LINEAR`, so a weave became coarse diagonal grey
stripes. Two changes: the bake takes each layer's **mean** (`uFlatDetail`), and
`three/materials.ts` draws the grain on the mesh at screen resolution from the
layer slot the bake records in the ORM alpha. The colour is exactly the
bake's; only the texture is added back. The pipeline never had this bug because
its `_tiled` resizes with Lanczos.

**"Missing detail" was the armour's normal map, never bound.** `TexSlot3`
(`_ddn`) was in the material payload and nothing used it. CryEngine maps are
DirectX-style, and with textures uploaded unflipped that is already the +v
direction three.js's derivative tangent frame uses: `normalScale (1, 1)`.
Blender flips v on import, which is the only reason the pipeline inverted
green.

**Blend-mask edges are anti-aliased in the bake.** Each channel's crossing is
measured against `fwidth` across the texel, so an edge texel mixes the two
layers by coverage. Away from an edge one layer has all the weight and the
result is the verified table, unchanged.

**One atlas per piece.** Every submaterial used to get a full 1024 albedo and
ORM -- sixteen textures, ~85 MB, for one torso. `surface.rasterOwners`
rasterises each submaterial's UV triangles into an owner map (dilated for the
gutters), and every pass writes only its own texels into one shared target.
Submaterials sharing more than 10% of their UV space with another get their
own bake. A Sunchaser torso is now 46 MB, and the engine's cache is bounded
at 640 MB and evicts least-recently-used pieces that are not worn.

**97 of the 142 backpacks name no material,** so they rendered in placeholder
grey. `web/core/src/discover.rs` ports the pipeline's `discover_materials`:
class name first (longest prefix), then the mesh's own `MTL_NAME`, then
`<stem>_NN.mtl` beside it. Separately, **non-LayerBlend submaterials** --
`Illum` straps and lights, `GlassPBR` visors, `MeshDecal`, screens -- now get
the constants and textures their `.mtl` declares instead of the placeholder.

**A piece's `_override` bones are it moving the attachment points.** The rig
takes them from one undersuit donor; the ADP-mk4 core re-declares
`backpack_attach_1_override` at y -0.228 local, ten centimetres behind the
donor, so a Warden pack hung on the donor's point sat inside the shell.
`loadMesh` now returns a piece's own override bones, and the outermost piece
declaring a point wins (torso over legs over arms over helmet over undersuit).

**`Glow` is a fraction of the surface's own colour, emitted.** The ADP-mk4 Big
Boss graffiti is a bright green layer on a submaterial with `Glow 0.02`, and
glows in CIG's render while the near-black plate around it does not. Emitted
as `albedo * glow * GLOW_GAIN` (25, chosen by eye against that render). 486
LayerBlend submaterials carry some Glow; the gain is capped at 4.

**A metal emits nothing.** The live composite's colour is a dielectric's albedo
but a metal's F0, so `albedo * glow` made every bright metal on a glowing
submaterial emit up to four times its reflectance: the BUL-H4 SteelTek's
silver, the IAE 2953 suits' champagne aluminium and the Geist "Golden Blossom"
gold all baked flat white, and no change of light moved them (environment x0.25,
key x0.4: identical). Glow is now `colour * (1 - metal) * glow`, which keeps the
Big Boss graffiti (a dielectric) as it was.

**A composited surface emits at most half its colour** (`GLOW_CAP` 0.5, the
Big Boss graffiti's 0.02 x 25). Higher Glow does not read brighter in CIG's
renders: the Doomsday Skullcap's bone face (`skull_m`, Glow 0.45, Emissive
white) is lit bone in the store render, its sockets, nasal cavity and teeth in
shadow and only two LEDs glowing, but at the old ceiling of 4 it emitted four
times its colour and drew as a flat cream shape that no light moved. 184 item
looks had a layer at that ceiling (the Ana arms' gold, skulls, bones,
interiors) and about 800 more emitted between 0.5 and 4 times their colour.
The `_hal` blue (luminance) channel is not the mask: the Skullcap's is a grain
pattern at 0-58 with the eye sockets black. Plain materials (displays, eyes)
keep their own `GLOW_GAIN * 0.4` path and its ceiling of 4.

**An empty layer is still a layer.** StarBreaker's `.mtl` parser drops a
`<Layer>` whose `Path` is empty, and the composite places layers by position,
so every later layer slid into the previous one's blend channel. 1,566 of 27,862
LayerBlend submaterials on character gear and FPS weapons have an empty base
layer ahead of another. `material::parse` now re-reads each material's
`MatLayers` and puts the empty ones back in slot order (as the Python bake
always had them); the library skips them, and the shader draws one as a
dielectric in its own TintColor or palette entry. StarBreaker itself is left
alone: its CLI feeds other pipelines.

**A palette tints glass.** `glassColor` is set on 525 of 2,369 palettes, and a
GlassPBR lens's own Diffuse is white, so a colourway that differs only in its
lens (SightRight Goggles Yellow) drew identical to the plain one. The catalogue's
`tint.glass` now colours glass surfaces; white means untinted.

**A palette paints stencil decals.** A `MeshDecal` compiled with `%STENCIL_MAP`
whose stencil slot is the placeholder `$TintPaletteDecal` (819 material files,
182 of them FPS weapons) draws the colourway palette's `decalTexture`: its red,
green and blue are separate masks, coloured by the palette's `decalColorR/G/B`
unless the material sets `StencilTintOverride` (then its own
`StencilDiffuseColor`, `...2`, `...3`). The placeholder resolved to nothing, so
every such decal was hidden: the P8-SC's large "BEHRING" side marking among
them. `material::Stencil` carries the material's half, the catalogue's
`tint.decal` the palette's, and `stencilMaterial` draws them.

**One failed request used to kill the worker client.** Replies were matched to
requests by type and a failure was a bare `failed`, which the client could
only treat as the whole worker failing -- so one missing material rejected
every request after it. Requests now carry ids and a failure rejects only its
own.

**The listing groups by product line, the first word of the name.** Keyed by
mesh, "Defiance Arms (Modified)" was a colour of Defiance Arms (shared mesh)
while "Defiance Core (Modified)" was its own row (own mesh), and "ADP-mk4
Core" appeared twice. Every first word shared within a slot is one product
line across the catalogue -- Aves Shrike/Starchaser/Talon, Aztalan
Galena/Tamarack, Carnifex -- except after an article: "The Butcher" and "The
Hill Horror" share only "The". The medical bay's anatomy meshes (named
"Body", under `body/anatomy/`) are hidden.

### Holsters, gear and the held weapon -- built (2026-09-23)

LOADOUT.md is the plan; this is what building it established. Phases 0-4 are
done in the web kitbasher. Phase 5 is dropped: the local Blender viewer does
not draw gear, by decision, and does not need to.

**Armour declares its holsters** as `SItemPortContainerComponentParams.Ports`,
and the count follows the torso's weight with no exceptions across 1,741
records: a light core carries `wep_stocked_3`, two grenade and four magazine
points; medium `wep_stocked_2..3`, three and six; heavy two, four and eight.
Legs carry `wep_sidearm`, `utility_attach_1..2`, `medPen_attach_1..2` and
`oxyPen_attach_1..2` at every weight. Backpacks carry `wep_stocked_2..3` and
`gadget_attach_1`; four ammo carriers add `magAttach_1..4`. A Large (size 5)
weapon fits only `wep_stocked_3`. Catalogued as `ports` on every item (schema
4), 100% agreement between the Python and the port.

**A piece's `_override` bones are it moving those points** -- see "The web
viewer's surfaces, rebuilt". The outermost piece declaring a point wins, and
the same rule decides which piece *owns* a holster: backpack over torso over
undersuit. A backpack carries its own `wep_stocked_attach_2/3_override` nodes
either side of the pack, and a rifle moves onto them when a pack goes on.

**Gear is a catalogue of its own**, 505 records under `scitem/weapons/` and
`scitem/consumables/`: 279 primaries (54 distinct meshes), 72 sidearms, 28
knives, 46 gadgets, 59 magazines, 19 pens and **two grenades** -- the build
ships only those. 100% field agreement both ways (`full_diff` compares numbers
to 1e-12: a 230/255 glossiness rounds differently in Python and Rust).

**A weapon's colourway is the `SubGeometry` child its `geometryTags` names.**
`SCItemWeaponComponentParams.geometryTags` on `behr_rifle_ballistic_01_tint01`
says `Tint01`, and the child tagged `Tint01` carries `behr_weapon_black`. 309
records set it and 297 find their child; the rest carry the colourway on the
root. The root is the item and the tagged children are other records'
alternates -- the reverse of armour, where the root is the carry crate.

**Every holsterable item carries the port's locator**, `attach_offset_left_01`/
`_right_01`: as `.chr` bones on `.cdf` weapons, as NMC nodes on `.cgf` knives
and magazines. The knife's NMC locator has exactly the rotation the P4-AR's
`.chr` one has, so the two conventions agree. A knife on `utility_attach_2`
sits across the front of the right thigh because the legs' own bone is
oriented that way; the pistol on the same leg comes out barrel-down.

**Two gear shapes the loader had to learn.** A `.cdf` can name a `.cga` as its
model rather than a `.chr` -- the Arlington's definition lists nothing else
but an unbound round, so skipping the model drew no rifle. And a multi-part
`.cga` stores each group's vertices in its **NMC node's** space: the Arlington
is ten nodes (barrel, bolt, covers, selectors), and without `bone_to_world` it
came out as slabs at the origin. `gear::place_nodes` applies it, to props too.
4 of 145 distinct gear meshes point at files this build does not ship.

**The held weapon sits on `RightWeaponBone` by its own origin** -- the body's
`weapon_attach_hand_right` names no item locator -- and
`stocked_alerted_stand_idle_turn360_raised` animates that bone, so the rifle
is in the hands from the clip alone. Pistol and knife sets have only
upper-body idles and ride on the unarmed stand/crouch.

**There is no "ready" stance, and 0.6.0's was the raised one.** The stocked
set's `..._turn360_planted` ends its turn in the raised stance exactly -- every
measured bone 0 cm from `_raised` -- so the button did nothing. Poses now follow
the game's two states: idle and rest holster the weapon, raised draws one (the
last held, else rifles first), crouch keeps what is in the hand.

**The left hand needs no IK.** Measured in the raised pose across all 53
distinct stocked meshes: the left knuckle sits a **median 2.6 cm** from the
weapon's surface, p90 5.0 cm. Outliers: two Boomtube launchers (5.5, 11.6 cm)
and the short CQ7 (30.5 cm). The plan's rule was IK above "a couple of
centimetres"; this is at it.

**Orphaned skin weight follows the piece's own hierarchy before any guess.**
Raising the arms stretched long lines off the Defiance arms: 1,828 vertices
weighted only to wrist pistons, which the name guess put on a bone that does
not follow the hand. `LeftWrist_Piston01_End` is a child of `LeftHand` in the
piece's own skeleton; `armature::rebind` now walks that chain to the first
bone the rig has, and guesses only when there is none. On the Defiance arms:
1,828 inherited, 0 guessed. The pipeline's Blender rebind still guesses.

**A HUD plane is runtime UI.** `UIPlane`/`Hologram` submaterials bind
`$RenderToTexture`; drawn, the Animus launcher's sight was a flat grey card.
Hidden.
