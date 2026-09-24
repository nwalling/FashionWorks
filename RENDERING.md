# RENDERING.md — Closing the gap to a studio render

A plan, scoped against build 1.0.191.55227 on 2026-09-24, for the web
kitbasher (`web/`). Everything under "What the data says" was measured against
the real archive or this machine's browser; everything under "Phases" is a
proposal with an exit test. What has been built is under "Status", with what
each phase measured.

It follows a teardown of SC Dressing Room (`scdressingroom.gamers-fix.com`),
the one public tool that renders the same assets visibly better than we do.
The teardown is summarised first because it decides what is worth copying and
what is not.

`LIGHTING.md` is the older plan for the **local** viewer's lighting. Its
preset-table idea carries over to Phase 1 here; its downloaded CC0 HDRs do not,
because the archive ships the game's own lighting probes.

## Status

Released in `@fashionworks/web` 0.7.0 (FashionWorks `faee59f`), vendored into Hangarworks at `5362738`.

| phase | state | what it measured |
| --- | --- | --- |
| 0 -- harness | done | `npm run harness -- <label> [--compare <old>]`; two runs agree on every scored figure, render time within 0.1 ms. Baseline below. Found and fixed an eviction bug on the way. |
| 1 -- tone, probes, presets | done | Contrast 2.19 -> **2.88** (band 2.48-3.47); Corbel hue error 13.2 -> 3.9 degrees, Lynx 5.5 -> 3.3, its saturated share 7.7 -> 27.7 % (the blue specular now reads); Beacon 0.2 -> 2.5 (the one that moved away). Probe decode 24-43 ms. Render 6.4 -> 7.5 ms. Details under "Phase 1, as built". |
| 2 -- AO, AA, quality | done | Post chain on medium/high: multisampled half-float target, GTAO, `OutputPass`. High: contrast 2.88 -> **2.95**, tactical median 26.7 -> 28.1 (in-game 29), 61 fps with the 23-item loadout, render 7.5 -> 11.2 ms, app 170 of 400 KB. Low is the old direct path, unchanged. Details under "Phase 2, as built". |
| 3 -- LayerBlend on the mesh | done | UV-space against the bake on the Sunchaser core: mean difference **0.32-0.84** sRGB units, **99.6-100 %** of texels within 6. No moire at any zoom. Refined pieces 31-35 MB (bake: helmet 58.6, torso 44.2). Heavy loadout 958 -> **393 MB**, 60 fps, render 12.5 ms. Cold equip faster than the bake once warm (4.1 s against 4.6-4.7 s for four pieces). Contrast 3.31, still in band; tactical torso mean 33.9 against the in-game 34. |
| 4 -- a body and a head | done | Both bodies with head, eyes and hair (`hair_31`, the customizer default's); no poke-through on the Sunchaser, Tactical + Artimex or Corbel sets; the body hides under a full undersuit, the hair under any helmet. Armour scores identical to Phase 3 (the harness scores armour with the figure off). The figure costs **47 MB**, +132 draw calls and +1.3 ms with the heavy loadout, 60 fps. A `figure` toggle beside the body buttons. |
| 5 -- the idle loop | done | An `animate` toggle beside the poses, off by default. Unarmed standing plays the character customizer's own idle; a weapon in hand or a crouch keeps its still pose and takes that idle's sway on the spine, neck and head. 60 fps on both bodies, feet on the floor to **0 mm** every frame, the grip on rifle and pistol unchanged to **0 mm**, and no step at the seam larger than the clip's own frame-to-frame motion. |
| 6 -- decals from vertex colour | closed again | Decal geometry exists inside the mesh -- 27 overlay patches on the Sunchaser core, 22 on the arms, 0.2-2.5 mm off the plates -- and carries a 2-D coordinate in its vertex colour. No decoding into the atlas beats a random-placement null by a wide margin on both pieces (best 1.8x and 1.9x, different decodings). Nothing shipped; `CLAUDE.md`'s decal entry has the addendum. |
| 7 -- eight-influence skinning | done | A mesh whose vertices use more than four influences keeps eight, as a second attribute pair and a define-gated shader patch, shadows included. In a crouch the extra four move 3.1 % of the Sunchaser core's vertices by 2.8 mm on average and up to 12.4 mm, and 4.8 % of the utility suit's by up to 16.6 mm; the render changes on 0.62 % of the frame, along seams and straps. Harness scores unchanged within noise; +2.1 MB worn, 61 fps. |

### Baseline (built package, 1600x1000, today's renderer)

| metric | baseline | target |
| --- | --- | --- |
| Sunchaser gold % of each piece's visible pixels: helmet / torso / arms / legs | 46.8 / 34.1 / 18.0 / 11.3 | in-game 50.1 / 24.5 / 8.9-11.8 / 5.3 |
| Sunchaser gold-to-non-gold contrast, pooled | 2.19 | 2.48-3.47 |
| Sunchaser back, torso gold % | 42.2 | store render 33.0 (upper back only) |
| Defiance Tactical torso luminance mean / median / p95 | 39.3 / 33 / 83.1 | in-game 34 / 29 / 68 |
| hue of saturated pixels: Corbel Halcyon / Beacon Orange / Lynx Blue | 65 / 35 / 245 | 48 / 25 / 235 |
| saturated share: Corbel / Beacon / Lynx | 28.8 / 76.4 / 7.9 % | -- |
| 23-item loadout: fps / render ms / draw calls / triangles | 61 / 6.6 / 426 / 398,181 | -- |
| 23-item loadout: memory of the 11 live pieces / whole cache | 958 / 988 MB | -- |

The per-piece gold targets are the in-game sheet's, measured at a different
framing; they are directions, not pass marks. The arms and legs gap is the
known open palette-index question in `CLAUDE.md`, which no rendering phase is
expected to close. What the phases must do is move contrast into the band and
hue toward the name without moving gold coverage the wrong way.

**The harness found a cache bug on its first run.** `evict()` ran inside
`load()` and `loadGear()` before the new piece was registered as worn or
carried, so once live pieces passed the 640 MB budget the piece just loaded was
the one unprotected entry: disposed, then equipped anyway and no longer
tracked. 377 MB of the heavy loadout was live but outside the cache. A load now
protects what it just made; uncached live memory is 0.

**A carried magazine costs 40 MB**, a 512 bake plus normal maps fetched at
1024, which is most of why eleven live pieces reach 958 MB. Phase 3 is where
that comes down.

### Phase 1, as built

**Probes decode in the core** (`web/core/src/lighting.rs`, `Archive.cubeHdr`):
BC6H faces to linear float through StarBreaker's public
`decode_bc6h_to_float_rgb`, one face at a time because a cube mip holds all
six. 24-43 ms per probe at 256.

**They are standard Y-up cubes**, read by three.js with no rotation. Measured
on the Idris hangar: the face labelled -Y is the one dim, even face (the
floor, 0.011-0.013 on every edge), and every side face is brighter along its
top edge (0.036-0.114 against 0.004-0.034). The inventory probe's brightest
face is the one toward the camera, which fits front-lit inventory lighting.
Its smaller mips are empty; only the full-size face is used.

**The inventory probe is purple.** Mean RGB about (0.020, 0.006, 0.022): the
inventory screen's mood, which painted every piece magenta when used as-is.
The reference preset keeps its light and drops its hue (`neutral`).

**Each probe is normalised by its own mean** (0.01 for inventory, 0.4 for the
sunny Daymar probe) and **aims the key at its brightest 1%**, so the floor
shadow falls the way the environment says the light comes from.

**The customizer rig reads from the archive** (`Archive.lightRig`): ten spots
in `LightRig_Female_Lightgroup`, authored intensity 0.002-0.25, 90-degree
cones, the `spot_075` gobo. Two traps on the way. A rig switched on by
sequence is authored off in `defaultState` and lit in another state, so the
reader takes the first lit state as StarBreaker does. And each group entity
carries `EntityComponentLightGroup` twice -- once under `PropertiesDataCore`
with only its fade presets, once as a direct child with the lights -- so taking
the first found no lights at all. The ten axes meet within 4-28 cm of one
point 1.62 m up, 0.5-0.9 m from each light: a head-and-shoulders rig,
anchored at the head, its 1 m attenuation radius dropped.

**Calibrated on the harness**: environment x0.7 and exposure 0.7 put the
Sunchaser mid-band. `classic` reproduces the pre-Phase-1 baseline to within
0.2 on every figure, so the preset plumbing itself changes nothing. p95
luminance rose (83 -> 99 against the in-game 68): specular response, which
`CLAUDE.md` already says no lighting value fixes.

**The harness's hue targets now come from the items' own data**: Corbel's
palette entry A `#f6c000` (46.8), Beacon's BaseLayer3 tint (30.2), Lynx's
palette specular `#0314fd` (235.6). The first cut used guesses and a
peak-of-bins hue that flipped between neighbouring bins on a small exposure
change; it is now the median.

### Phase 2, as built

`low / medium / high / high 150% / high 200%`, detected from the GPU's name
(software low; Intel, Mali, Adreno, PowerVR and Apple's mobile GPUs medium;
the rest high) and remembered per visitor. Medium and high render the scene
into a 4x multisampled half-float target, run three's `GTAOPass` (radius 12 cm,
blend 0.9) and finish in `OutputPass`; the scaled settings multiply the
display's pixel ratio, capped at 3.

**Invisible groups are dropped from the geometry at load.** GTAO draws its
normals with one override material, which ignores a submaterial's
`visible: false`, so NoDraw proxies and HUD planes would have shaded the armour
they sit inside. Gone from `geometry.groups`, no pass can draw them.

**The page colour now goes through the tone curve backwards.** `OutputPass`
tone-maps and exposes the whole image, background and grid included, where the
direct path never touched a clear colour. A transparent canvas over a CSS
colour was tried first and failed twice: the kitbasher's panel colour showed
through instead of the page's, and `OutputPass` sRGB-encodes premultiplied
colour, which brightened every half-covered floor pixel until the grid lines
vanished (floor row 29 -> 43, 10 line peaks -> 0). Opaque, with the page colour
and the grid colour inverted through Neutral each frame (`untoneMapped`), the
corner pixel is exact in both themes -- (10, 18, 25) dark, (244, 246, 248)
light -- and the grid is back. Neutral is not identity in the darks: it
subtracts a toe, which is why a plain divide by exposure would not have done.

**The floor blends in linear light through the chain**, so its alphas are
the linear equivalents of the sRGB ones it was tuned with, 1 - (1 - a)^2.2 for
the shadow, the pool scaled until the floor measured what it did (26 against
29 on the same row, the same ten grid lines).

**The harness counts a whole frame.** three resets `renderer.info` per render
call; a post chain makes several, so the first Phase 2 run reported one draw
call and one triangle -- the final quad.

### Phase 3, as built

`three/live.ts`. Each LayerBlend submaterial is a `MeshStandardMaterial`
whose fragment shader runs the bake's rules -- blend splat with screen-space
anti-aliasing, absolute `PaletteTint`, a metal taking the palette's specular,
the palette modulating the layer's tint, a metal's diffuse normalised around
its mean, wear paired on the slot with dark as worn, `_hal` green as occlusion
-- and hands colour, roughness, metalness, occlusion and a detail normal to
three's lighting, so the probe, the key's shadow and GTAO all still apply.
Low quality keeps the bake.

**Proven against the bake, texel for texel.** The live shader rendered into UV
space at 1024 with an unlit debug output, against the baked atlas of the same
material: five Sunchaser core submaterials, mean difference 0.32-0.84 sRGB
units, 99.6-100 % of texels within 6, identical mean colours. At that size
the mipmapped layers average to exactly the means the bake used; up close they
keep their texture.

**Per-pixel gloss arrived with it.** The port's bake never read the `_ddna`
smoothness stream -- every layer took its constant -- because `decode_rgba`
leaves it out. `Archive.loadTextureAlpha` merges the `.dds.Na` stream into
alpha. The Lynx arms' saturated share rose 27 -> 41 %.

**The formula is the Python's**, alpha x GlossMult x palette glossiness, with
Shininess only as the constant when there is no stream. `CLAUDE.md` said
Shininess x GlossMult x alpha; it was corrected against `tint.py`.

**Textures, and where the memory went.** Layer colour 512, uploaded as BC1
blocks where the GPU takes S3TC (`Archive.textureBlocks`, 171 KB a layer) --
this Mac does; RGTC for the BC4/BC5 maps it does not, so those decode. Layer
normal + gloss 256. The control maps split three ways: blend + wear RGBA at
1024; the armour `_ddn` as RG at 2048; `_hal` as one channel at 1024. Packing
the normal and occlusion together as RGBA put a refined piece at about
55 MB. CPU copies are dropped once uploaded.

**The 2048 normal arrives after the piece.** Decoding it up front cost 250 ms a
piece and left cold equips 9-15 % slower than the bake. It is decoded at 1024
first and refined when the engine has been idle 600 ms -- refining in parallel
with the next equip slowed that equip by about what it saved, the worker being
one thread. The harness waits for refinement (`refinePending`), which it did
not at first: the loadout measured 51 fps mid-upload.

**Layer means from the blocks.** The metal rule needs each layer's linear
mean. A 16x16 mip's BC1 blocks decode in JavaScript for nothing (`bc1Mean`);
asking the worker for a small decoded copy cost a round trip per layer.

### Phase 4, as built

`FIGURE` in `three/kitbasher.ts`: per body, the whole-body `.skin` the
customizer's `body_01_noMagicPocket` binds, `PU_Protos_Head`'s head and eyes,
and `hair_31`, all skinned to the rig by name. The facial bones are not in the
rig and inherit `Head`. Teeth and the eye overlays are left out: the mouth is
closed, and the overlays -- wet, occlusion, caruncle -- are blended by the
engine and blacked out both eyes when drawn opaque.

**Coverage is the existing rule, not depth.** The body hides under an
undersuit that reaches from the feet (min y <= 0.15) to the chest (max y >=
1.3); the hair under any helmet. Nothing finer was needed: across the three
reference sets no skin shows through a plate.

**Skin gloss is per pixel.** `HumanSkin_V2` carries Shininess 1 on body and
head, which as a constant is a mirror; it scales the `_ddna` smoothness
stream, as an armour layer's does. Roughness is `1 - alpha x shininess`.

**The head and body textures disagree at the neck.** Sampled at the 45 vertices
the two meshes share, the male head reads sRGB (189,120,100) against the body's
(167,105,85), the female (194,152,122) against (189,135,106) -- a collar line
on a bare figure, which the game never shows because something is always worn.
The body is multiplied to meet the head (`skinMatch`), not the other way
round: the body hides under any full undersuit and the face never does. The
female uses `f_body_cau.mtl`, the counterpart of the male's `m_body_cau.mtl`;
`f_body_01` was further off.

**Hair has no colour texture.** `HairPBR`'s slot 1 is an opacity mask -- two
strand sets in red and green over a flat blue -- and drawn as a colour map it
came out as blue and rainbow cards. The colour is physical: `BaseMelanin`,
`BaseMelaninRedness`, `DyeColor` over it by `DyeAmount`. The core now passes a
non-LayerBlend submaterial's numeric `PublicParams` through, and
`materials.hairColour` maps them with Chiang et al.'s melanin parametrisation
as Blender implements it -- **inferred**: the names match, CryEngine's own
curve is not documented. `hair_31` comes out a dark brown, sRGB (77,58,43). The scalp cap declares only smoothness and borrows the cards' colour.
Cards are alpha-tested on red with alpha to coverage, the mask lifted 1.6x
for the smaller mips (`OpacityMipScale` is 3.4 in the material; this is the
flat version).

**Memory, from 148 MB to 47.** The first figure decoded every texture at
1024 and kept the CPU copies: body 91.8 MB, eyes 18.9 for 1,648 triangles.
Each part now has its own texture size -- head and hair 1024, body 512 (it is
mostly under armour), eyes 256 -- the CPU copies go once uploaded, and the
hair's masks are two-channel. Per part: body 15.4, head 16.9, eyes 0.8, hair
14.1 MB. The plan's rule for hair was to drop it if it cost more than the head;
it does not in memory, and at 88,870 triangles (eight times the head) it is
drawn only bare-headed.

**The memory measure was counting RG8 and R8 as RGBA.** Phase 3's normal and
`_hal` control maps are two- and one-channel; counted properly, the heavy
loadout's worn memory is **335 MB**, not 393. Nothing changed but the
accounting.

### Phase 5, as built

**The still idle cannot loop.** `nw_stand_idle_turn360_planted` is a turn in
place: the root turns 360 degrees over twelve seconds in four steps, and the
legs step every three. Its ends meet (0.28 degrees), but with the root left
out -- which every player here does, since the root carries the clip's own
placement -- the figure shuffles its feet on the spot. The rifle's
`_raised` idle is the same shape, a 1.5 s stepping cycle with the arms
swinging 8 degrees a step.

**The customizer's idle can.** `Animations/Characters/Human/{male_v7,female_v2}/pu_char_customizer/pu_char_custom_idle_{m,f}_01.caf`
is the idle the game stands a new character in: ten seconds of weight
shifting, 11-12 degrees at most (the hands), the hips within 1.2, ending 0.11
degrees (male) and 0.57 (female) from where it began. Found by scoring every
clip in `stand.dba` (189), the stocked and pistol sets, `idle_overlay.dba`,
`idle_fidget.dba` and the AI libraries with `cargo run --example
loop_survey`: the widest start-to-end gap over the bones we apply, how far
anything moves, and how far the hips turn. Locomotion cycles loop perfectly
and are not idles; fidgets move 50-180 degrees; nothing armed stands still.

**Armed and crouched poses sway rather than loop a clip of their own.** The
same customizer idle plays *additively* -- its motion relative to its first
frame, over the still pose -- on `Spine` through `Head` only. Both weapon
bones hang off `Spine3`, so hands and gun ride the chest together: the left
hand's distance to `RightWeaponBone` varies by 0 mm across the loop. The hips
are left out because turning them swings the legs and slides the feet. The
game's breathing layer, `nw_neutral_stand_idle_base`, was tried first: its
2.3 degrees are in the shoulders, which cannot take it without moving one hand
off the gun, and on the spine it moves under half a degree -- invisible.

**Seams.** Each bone's gap between the last and first frame is spread over
the cycle, so the last frame lands on the first exactly. Before that, the
female idle's 0.57-degree finger gap showed as a 0.96-degree one-frame step
at every wrap against a 99th percentile of 0.62.

**Per frame**: the sampled rotations are slerped (30 fps clips at 60), the
hips put back where the still pose had them, and the feet seated as `setPose`
seats them once. The core samples the whole clip in one call (`sampleClip`,
`clips.rs`: nlerp between keys along the shorter arc, onto one frame grid);
the customizer idle is 300 frames x 140 bones, 670 KB.

| | fps | feet | grip | per-frame step, median / p99 / max |
| --- | --- | --- | --- | --- |
| male, unarmed | 60 | 0 mm | -- | 0.14 / 0.58 / 0.58 degrees |
| male, rifle raised | 60 | 0 mm | 0 mm | 0.011 / 0.034 / 0.052 |
| male, pistol raised | 60 | 0 mm | 0 mm | 0.011 / 0.037 / 0.062 |
| male, crouch | 60 | 0 mm | 0 mm | 0.011 / 0.033 / 0.046 |
| female, unarmed | 60 | 0 mm | -- | 0.16 / 0.62 / 0.68 |
| female, rifle raised | 60 | 0 mm | 0 mm | 0.019 / 0.084 / 0.085 |
| female, pistol raised | 60 | 0 mm | 0 mm | 0.019 / 0.084 / 0.086 |
| female, crouch | 60 | 0 mm | 0 mm | 0.017 / 0.073 / 0.086 |

Still stays the default, so screenshots, share links and the harness are
unchanged; the toggle is not remembered between visits.

### Phase 6, as run (a spike, closed)

Everything here is reproduced by `cargo run --example decal_probe` (UV0,
colour and material groups out of a `.skinm`) and `decal_analysis.py` over its
dump and the piece's `TexSlot9` atlas.

**Most of the colour is per-island bookkeeping.** A is 255 minus the
submaterial index on all 13 submaterials of the Sunchaser core and arms. B
tracks the island's V (Spearman 0.95 on the core, -0.88 on the arms). R sits
at 160-161 and G at `16i + 5` on 99 % of vertices, constant across an island.
G's sixteen levels match nothing tried: not U, not the island's orientation in
UV space, not position, height or angle around the body.

**The decals are geometry.** 27 islands on the core and 22 on the arms --
4 to 40 vertices, nearly all mirrored pairs -- lie 0.2-2.5 mm off the plates
(median 0.6 and 1.3 mm), and they are the only places the colour varies inside
an island. There, `R*256+G` is linear across the surface to a median 3-4 parts
in 65,536 and B to 0.2-0.3 in 255, at 86-88 degrees to each other: a 16-bit
and an 8-bit coordinate on each patch. `CLAUDE.md` had closed decals partly
because "there is no decal geometry"; that searched file names, and the
geometry is inside the armour's own mesh.

**The mapping into the atlas is not in the data.** Sixteen decodings, scored
as the share of the patches' atlas footprint on content (alpha > 0.5; the
atlas is 13.5 % content) against the same patches placed at random:

| decoding | core | its null | arms | its null |
| --- | --- | --- | --- | --- |
| `(R, B)/255` | 0.08 / 0.15 | 0.19 / 0.15 | 0.14 / 0.11 | 0.17 / 0.18 |
| `(R*256+G)/65536, B/255` | 0.08 / 0.15 | 0.19 / 0.15 | 0.14 / 0.11 | 0.18 / 0.15 |
| `B/255, (R*256+G)/65536` | 0.13 / 0.09 | 0.13 / 0.12 | 0.06 / 0.05 | 0.16 / 0.13 |
| `(R, G)/255` | 0.12 / 0.14 | 0.19 / 0.18 | 0.11 / **0.26** | 0.16 / 0.20 |
| `(G, B)/255` | 0.13 / 0.21 | 0.17 / 0.18 | 0.15 / 0.12 | 0.18 / 0.13 |
| `B/255`, 12-bit `(R&15)*256+G` | 0.18 / **0.24** | 0.17 / 0.17 | 0.13 / 0.14 | 0.15 / 0.17 |

(Each cell: V as read / V flipped; the table keeps six of the sixteen, the
rest are no better.) The best on each piece is a different decoding, within
about two standard deviations of its own null, and at or below chance on the
other piece. The coordinates also differ in scale by **16:1** per millimetre
(0.062-0.063 on both pieces), so any mapping that keeps text square needs a
factor the vertex data does not carry -- a shader constant, most likely.
Reading it out of the compiled shaders is outside this plan's boundaries.

Nothing shipped. The plan's rule was to proceed only on a decoding that beats
chance widely and reproduces a decal in a CIG render; neither happened.

### Phase 7, as built

**The core keeps eight where a mesh uses them.** `mesh::load_wide` reads the
eight-influence bone map eight wide when any vertex has more than four,
`armature::rebind_wide` remaps and redistributes at that width, and
`loadMesh` hands the fifth to eighth to JavaScript as `joints1`/`weights1`.
After rebinding, a mesh whose second set came out empty is narrowed back to
four: the hair loads with eight in the archive and none left once its strand
bones fold onto the head, which would have been 1.5 MB of zeros. Props and
gear stay four wide; the examples that diff against the pipeline still load
at four, since Blender's export limits to four too.

**The renderer adds the second four behind a define.** `three/skin8.ts`
patches three's four skinning chunks once, every addition under `FW_SKIN8`,
so a material without the define compiles exactly as before. A piece with a
wide mesh gets the define on its materials, an empty second set on any
four-wide mesh sharing them -- without it the shader reads the attribute
default, (0, 0, 0, 1), and pulls every vertex towards bone 0 -- and a depth
material with the same define, so its shadow bends as it does. Alpha-tested
meshes keep three's own depth material, which cuts the shadow along the
cards. GTAO's normal pass still skins four ways; the difference is under its
blur.

**What it changes**, measured by skinning on the CPU both ways in a crouch,
the fifth to eighth weights against the top four renormalised:

| mesh | vertices using more than four | moved, mean / max |
| --- | --- | --- |
| Sunchaser core | 702 of 22,842 (3.1 %) | 2.8 / 12.4 mm |
| Sunchaser arms | 49 of 21,362 (0.2 %) | 0.15 / 0.6 mm |
| utility heavy suit (Pembroke) | 3,083 of 64,550 (4.8 %) | 2.8 / 16.6 mm |
| male body | 36 of 12,356 (0.3 %) | 0.3 / 1.1 mm |
| male head | 86 of 5,584 (1.5 %) | 0.6 / 1.7 mm |

The shares are exactly the survey's under "Eight-influence skinning is a small
effect". Rendered eight-way against four-way on the utility suit, 0.62 % of
the frame changes by more than 12 levels, all of it along the collar, strap
edges and shoulder seams. The harness's scored views are the idle pose, where
it moves nothing measurable.

## Boundaries

These hold for every phase. Changing any of them is Noel's decision, not a
step in this plan.

- **No game data served from the host.** `WEB-LEGAL.md`'s go decision rests on
  it. Every asset below is read from the visitor's own `Data.p4k`, as today.
- **No decompiling the executable or the shader cache.** The EULA prohibits
  "reverse engineer, derive source code from, … disassemble, decompile" of Game
  Material. Reading data files is how this project has always worked; decoding
  `ShaderCache_D3D11.pak` or reading constants out of `StarCitizen.exe` is a
  different act. Behaviour is derived from data plus measurement against CIG's
  own published renders, which is how the blend table, the palette specular and
  the wear direction were all settled.
- **No copying their code.** It is theirs. It is used here as a pointer to
  where the differences are, never as a source.

## What SC Dressing Room does

Read from their public client bundles and network traffic on 2026-09-23.

| area | theirs | ours |
| --- | --- | --- |
| delivery | pre-converted GLBs (2,516 meshes, ~2.5 GB) and webp textures on their own server, content-hashed manifests, 512 px previews first | read from the visitor's archive, no host |
| renderer | three.js r185, WebGPU default, WebGL fallback, node materials | three 0.169, WebGL2 |
| tone mapping | the game's HDR curve, constants read out of `StarCitizen.exe` | **none** |
| environment | procedural studio env with area-light lobes, plus the game's probes (inventory, look-dev) | **none** |
| lights | presets incl. the character customizer rig (spot lights with gobos) | key 2.2 + rim 0.6 + ambient 1.3 |
| post | TAA, optional 4x MSAA, GTAO, bloom, render scale to 200% | 4x MSAA only |
| materials | LayerBlend **per pixel on the mesh**, full-res maps, tiled layers with mips | baked to one 1024 atlas per piece, grain added back per pixel |
| decals | decal UVs unpacked from vertex colour | none (closed in `CLAUDE.md`) |
| skinning | 8 influences via a sidecar, optional dual quaternion | 4 |
| character | body, head, eyes, hair, `.chf` import, idle loop, emotes, cloth | armour only; body only from an undersuit; single frames |
| delivery cost | 38 requests, 10.9 MB for one Sunchaser core | 0 bytes from any host |

Where they got their tone curve and shader behaviour (decompiling) is outside
the boundaries above. Everything else in the table is reachable from data.

## What the data says

Measured today, on this archive and this machine.

### The game's own lighting probes are in the archive

The `Engine/` tree is inside `Data.p4k` (1,306 entries), and it carries:

| probe | path | format |
| --- | --- | --- |
| inventory screen | `Data/Textures/cubemaps/inventory_setup/cm_inventory_probe_cm.dds` | cube 256², 7 mips, BC6H UF16, 524 KB, single file |
| look-dev ×5 | `Engine/EngineAssets/Textures/LookDevelopmentMode/envprobes/environmentprobe_{SOL,idris_hangar,idris_medical_room,stanton2b_sunny,stanton2c_sunny}_cm.dds` | cube 256², 7 mips, BC6H UF16, split `.dds` + `.dds.1-4` |
| diffuse (irradiance) | the same names with `_cm_diff` | cube 32², BC6H |

**StarBreaker decodes BC6H only to 8-bit**, with its own Reinhard curve, which
throws away exactly the range IBL needs. `bcdec_rs::bc6h_float` (already a
dependency) returns floats, so a half-float decode is one small function in the
core. The face order and the Z-up to Y-up remap are untested; a sunny probe's
sun direction is the check.

### The customizer's light rig is readable data

`Data/ObjectContainers/Frontend/CharacterCustomizer/charactercustomizer_pu.socpak`
(95 KB) holds a `.soc` naming light entities with gobo textures
(`textures/lights/generic/spot_075.dds`, `spot_050`, `spot_100`, `rect_full_*`)
and projector parameters. StarBreaker's `socpak.rs` already extracts `LightInfo`
from containers like this (it scales authored intensity by 1500 to candela), so
reading the rig is a wrapper over existing code, not a parser.

### The layer library is small, and compressed

All **375** layer textures under `Data/Textures/layers/` are **512²**: 173
diffuse in BC1, 201 `_ddna` in BC5 SNORM, each with a gloss alpha stream.
101 MB compressed, the whole library. The armour's own maps are **2048²**:
`_ddn` BC5 SNORM, `_blend` and `_hal` BC1, `_wear` BC4.

This machine (Chrome, ANGLE Metal, Apple M1 Pro) exposes
`WEBGL_compressed_texture_s3tc` but **not** `EXT_texture_compression_rgtc` or
`_bptc`: BC1 can go to the GPU still compressed; BC4/BC5 must be decoded, to
R8/RG8 rather than RGBA8. 16 texture units per fragment shader, 2,048 array
layers, 4x MSAA.

Resident cost, with mips:

| | this Mac | with RGTC (typical Windows) |
| --- | --- | --- |
| entire layer library | ~240 MB | ~135 MB |
| one piece's own maps at 2048 | ~22 MB | ~14 MB |
| today: one Sunchaser torso bake | 46 MB | 46 MB |

So shading per pixel at full resolution is **cheaper in memory** than the bake
it replaces, because a loadout touches a few dozen of the 375 layers.

### Eight-influence skinning is a small effect

Counted on the archive's `IVOBONEMAP32` streams:

| mesh | vertices | >4 influences | weight dropped on those, mean / worst |
| --- | --- | --- | --- |
| `m_clda_utility_heavy_suit_01` | 64,550 | 3,083 (4.8%) | 5.5% / 14.9% |
| `m_slaver_heavy_armor_01_core` | 22,842 | 702 (3.1%) | 3.6% / 16.9% |
| `m_cds_undersuit_armor_02` | 44,244 | 1,147 (2.6%) | 1.7% / 7.8% |
| `m_slaver_heavy_armor_01_arms` | 21,362 | 49 (0.2%) | 1.8% / 6.7% |
| `m_cds_heavy_armor_01_legs` | 13,524 | 4-wide only | -- |

The CLDA count is exactly the 3,083 SC Dressing Room's sidecar declares for the
same mesh, which cross-checks both readers.

### Vertex colour is data, not a paint mask

Every armour mesh interleaves an RGBA colour with its UV in `IVOVERTSUVS`. On
the Sunchaser core it is plainly structured: **red is 160-161 on 99% of 22,842
vertices**, green spans the whole range, and blue and alpha sit in the top
eighth (224-255) on 99% and 100%, over 577 distinct values. SC Dressing Room's
shader notes say decal atlas coordinates are packed here. That is the first
evidence against `CLAUDE.md`'s closed "Decals and the Detail map" entry, whose
strongest argument was that no armour mesh has a second UV set. The packing is
**not** decoded: Phase 6 found the decal geometry and the coordinate it
carries, but not the mapping into the atlas.

### A body and a default head are data too

`male_v7/body/m_body.cdf` binds five skins (torso, arms, hands, legs, feet)
with 15 skin-tone materials `m_body_01..15.mtl`. The customizer's default
character, `Libs/CharacterCustomizer/MasculineDefault.xml` (and `Feminine…`),
names `body_01_noMagicPocket`, `PU_Protos_Head` (head, eyes, teeth under
`heads/male/pu/protos_human_male_face_t1_pu/`) and `hair_31`, plus a DNA
string that morphs the face. We would render the base head unmorphed.

### Clips carry every frame

`starbreaker-3d`'s `AnimationClip` holds `fps` and per-bone rotation and
position keyframes; the core currently asks it only for the final frame
(`clip_final_pose`). The unarmed idle we use, `nw_stand_idle_turn360_planted`,
turns a full circle, so it cannot loop as it is.

### Our renderer today

`ui/Viewer.tsx`: no tone mapping, no environment map, key 2.2 casting (PCF
soft, 2048), rim 0.6, ambient 1.3 (0.85 on a light theme), MSAA 4x, pixel
ratio capped at 2. `three/surface.ts`: albedo + ORM baked at 1024 from 512
layers, grain from a 256 detail library; normal maps fetched at 1024.
Everything post-processing we would want ships in three 0.169
(`GTAOPass`, `SMAAPass`, `TAARenderPass`, `OutputPass`, `NeutralToneMapping`,
`AgXToneMapping`). App bundle: 157 of 400 KB brotli.

## Phases

Ordered by what a visitor sees per unit of work. Each phase ships on its own.

| phase | what | size |
| --- | --- | --- |
| 0 | a render harness that scores every later phase | small |
| 1 | tone mapping, the game's probes as IBL, light presets | medium |
| 2 | ambient occlusion, better AA, quality presets | small |
| 3 | LayerBlend per pixel on the mesh | large |
| 4 | a body and a default head | medium |
| 5 | the idle loop | medium |
| 6 | decals from vertex colour (spike first) | spike, then medium |
| 7 | eight-influence skinning | small |

### Phase 0 -- the harness

Everything after this changes how armour looks, so first make "better" a
number. A fixed set of pieces, camera and lighting, rendered headless from the
built package and scored with the measures `CLAUDE.md` already trusts:

- Defiance Sunchaser: gold-to-non-gold contrast against the store renders
  (2.48-2.95 band) and gold fraction on the silhouette;
- Corbel Halcyon, Beacon Undersuit Orange, Lynx Arms Blue: hue against CIG's
  studio references (hue, not luminance);
- the Defiance Tactical capture: torso mean/median/p95 (34 / 29 / 68);
- frame time with the 23-item loadout, GPU memory by our own accounting.

**Exit:** a baseline table for today's renderer, reproducible to the unit.

### Phase 1 -- tone, environment and lights

1. **Tone mapping.** `NeutralToneMapping` (hue-preserving) with exposure
   calibrated on the harness. Not the game's curve: ours must come from the
   data or a standard operator, not the executable.
2. **The game's probes as image-based lighting.** A core function decodes a
   BC6H cube to half-float (`bcdec_rs::bc6h_float`), remaps faces from Z-up,
   and hands six faces to the app; `PMREMGenerator` does the rest. Default: the
   **inventory probe**, which is the lighting the game presents items in.
   Options: the five look-dev probes. `scene.environmentIntensity` calibrated.
3. **Light presets as data**, per `LIGHTING.md`'s table: `{ probe, exposure,
   key, fill, rim, ambient, shadow }`. "Inventory" is the reference and is
   pinned for Phase 0 scoring. A **Character creator** preset reads the spot
   rig from `charactercustomizer_pu.socpak` through StarBreaker's socpak light
   reader; gobo textures are archive `.dds` too. One or two casters, not ten.

**Exit:** metal reads as metal (a visible environment reflection on the Lynx
arms); Sunchaser contrast inside the reference band; the floor shadow and
theme handling unchanged; probe decode under 100 ms.

### Phase 2 -- occlusion, anti-aliasing, quality presets

`EffectComposer` with `GTAOPass` (contact shading under straps and plates),
SMAA or `TAARenderPass` (the scene is static between interactions, which is
where TAA converges best), `OutputPass` for tone and colour space. Render
scale 100-200%. Low / Medium / High presets, detected from the GPU and
stored per visitor, the way theirs are.

**Exit:** High at 60 fps with the 23-item loadout on this machine, Low at 60 on
integrated graphics; app bundle still under 400 KB.

### Phase 3 -- LayerBlend on the mesh

The largest change and the largest visual gain: detail stays sharp at any zoom,
the bake and its atlas budget go away, and so does the grain workaround for
moire.

- The composite moves into the mesh's fragment shader via `onBeforeCompile`
  on `MeshStandardMaterial`, so lights, shadows, IBL and AO keep working. The
  rules are `web/gpu/layerblend.js`'s, which `check.html` already scores
  against the Python bakes.
- **Texture residency in the main context**: a shared layer pool as texture
  arrays (diffuse, normal, gloss), keyed by path and reference-counted per
  piece; BC1 uploaded compressed where `s3tc` exists, BC4/BC5 decoded to
  R8/RG8. The armour's own maps at their native 2048.
- **Sampler budget**: blend, wear, hal, normal, three layer arrays, environment
  and one or two shadow maps -- about ten of the sixteen units.
- **Wear becomes a slider**, since it is a uniform now, not a re-bake.
- The bake stays for listing swatches and as the Low preset's path.

**Exit:** rendered to UV space, the shader matches the current bake within the
tolerance the port already holds; no moire at any zoom; memory per piece at or
below today's 46 MB; 55+ fps with the full loadout; equip latency no worse.

### Phase 4 -- a body and a head

When nothing covers a slot, draw the base body from `m_body.cdf` with a skin
tone material, and the customizer's default head, eyes and teeth, unmorphed.
Hide body parts an armour piece covers, rather than trusting depth (the local
viewer's coverage rule is the starting point). Hair (`hair_31`, alpha cards,
`HairPBR`) is optional within the phase; skin gets a standard material with its
normal map first, subsurface later if the harness says it matters.

**Exit:** both bodies render with a head; no body poking through any piece of
the three reference sets; the base body hides under a full undersuit exactly as
it does today.

### Phase 5 -- the idle loop

A core call that samples a whole clip into a compact per-frame array of
retargeted local rotations; the app plays it and seats the feet per frame. The
turn-in-place idle does not loop, so the first task is choosing looping idles
from `stand.dba`'s 189 clips (and the weapon sets'), by measuring start-to-end
pose distance. An Animated / Still toggle; still stays the default for
screenshots and share links.

**Exit:** a seamless loop at 60 fps for unarmed, rifle and pistol, male and
female; feet stay on the floor throughout.

### Phase 6 -- decals from vertex colour

A spike first, because it reopens a closed item. Derive the packing from our
own data, not from anyone's code: try candidate decodings of `IVOVERTSUVS`
colour and score each with the test that closed decals in the first place
(decal-atlas alpha landing on the piece's geometry against chance, which was
1.04x on UV0). A decoding that is right should land text where CIG's store
renders show it and leave the Sunchaser shoulder pad clean, as the in-game
photograph does.

**Proceed** if a decoding beats chance by a wide margin and reproduces a decal
visible in a CIG render. **Otherwise** close it again with the new numbers.
Either way the pipeline's "strip vertex colours" note gets an addendum: the
data means something, even if glTF would multiply it into base colour.

### Phase 7 -- eight influences

A second `skinIndex`/`skinWeight` pair and a vertex-shader patch for the
0.2-4.8% of vertices that need it. Last, because the measured weight lost is
small; do it if the harness or a visitor shows a joint artefact.

## Not planned

- **Hosting converted assets**, pre-baked composites or previews: the boundary.
- **WebGPU and a three.js upgrade**: nothing above needs them.
- **Face DNA, `.chf` import, cloth, emotes, dirt/frost weathering**: real
  features of theirs, each its own project; revisit after Phase 5.
- **The local Blender viewer**: out of scope, as it was for `LOADOUT.md`.

## Risks

- **Every colour measurement in `CLAUDE.md` was taken under today's lights.**
  Phase 1 changes them; the harness pins the reference preset so old and new
  numbers stay comparable, and the reference band is re-checked, not assumed.
- **The inventory probe may be dark** (it is an indoor capture), so exposure
  and the key will need calibrating against it, not just switching it on.
- **Per-pixel LayerBlend costs up to ~28 texture fetches a pixel.** At 200%
  render scale on integrated graphics that may not hold; the Low preset keeps
  the bake.
- **Decoding BC4/BC5 in the worker** at 2048 is new work on the load path;
  measure it before assuming it is free.
- **Hidden body parts** are a per-set judgement the data may not state; the
  coverage rule can misfire on partial pieces, as it did before.

## Open questions

Each has a default this plan takes if nobody says otherwise.

- **Default lighting:** the game's inventory probe (default), or a neutral
  studio environment.
- **A body by default:** yes when a slot is empty (default), or only on request.
- **Hair in Phase 4:** attempt it, and drop it if it costs more than the head.
- **Quality default:** detected, High on a discrete GPU, Medium otherwise.
