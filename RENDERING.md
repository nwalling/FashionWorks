# RENDERING.md — Closing the gap to a studio render

A plan, scoped against build 1.0.191.55227 on 2026-09-24, for the web
kitbasher (`web/`). **Nothing here is built yet.** Everything under "What the
data says" was measured against the real archive or this machine's browser
today; everything under "Phases" is a proposal with an exit test.

It follows a teardown of SC Dressing Room (`scdressingroom.gamers-fix.com`),
the one public tool that renders the same assets visibly better than we do.
The teardown is summarised first because it decides what is worth copying and
what is not.

`LIGHTING.md` is the older plan for the **local** viewer's lighting. Its
preset-table idea carries over to Phase 1 here; its downloaded CC0 HDRs do not,
because the archive ships the game's own lighting probes.

## Status

Built on the `rendering` branch, not merged or pushed.

| phase | state | what it measured |
| --- | --- | --- |
| 0 -- harness | done | `npm run harness -- <label> [--compare <old>]`; two runs agree on every scored figure, render time within 0.1 ms. Baseline below. Found and fixed an eviction bug on the way. |
| 1 -- tone, probes, presets | done | Contrast 2.19 -> **2.88** (band 2.48-3.47); Corbel hue error 13.2 -> 3.9 degrees, Lynx 5.5 -> 3.3, its saturated share 7.7 -> 27.7 % (the blue specular now reads); Beacon 0.2 -> 2.5 (the one that moved away). Probe decode 24-43 ms. Render 6.4 -> 7.5 ms. Details under "Phase 1, as built". |
| 2 -- AO, AA, quality | done | Post chain on medium/high: multisampled half-float target, GTAO, `OutputPass`. High: contrast 2.88 -> **2.95**, tactical median 26.7 -> 28.1 (in-game 29), 61 fps with the 23-item loadout, render 7.5 -> 11.2 ms, app 170 of 400 KB. Low is the old direct path, unchanged. Details under "Phase 2, as built". |
| 3 -- LayerBlend on the mesh | done | UV-space against the bake on the Sunchaser core: mean difference **0.32-0.84** sRGB units, **99.6-100 %** of texels within 6. No moire at any zoom. Refined pieces 31-35 MB (bake: helmet 58.6, torso 44.2). Heavy loadout 958 -> **393 MB**, 60 fps, render 12.5 ms. Cold equip faster than the bake once warm (4.1 s against 4.6-4.7 s for four pieces). Contrast 3.31, still in band; tactical torso mean 33.9 against the in-game 34. |

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
**not** decoded.

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
