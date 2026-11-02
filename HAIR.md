# Hair and facial hair -- the gap, the data, and the methods

Research, 2026-11-02, on branch `character-shine`. Noel's verdict on that
branch's hair work: better, still below the quality he wants. This file is
what was found when the question was put properly: what the game's hair is
made of, what its shader does with it, what we do instead, and which of the
published methods would close the distance. §1-§8 are the research as it
stood before anything was built; §9 is the build, the same day, and what it
measured. §3 describes the shader before §9.

The companion files: CHARACTER.md "Hair, brows and skin, held to the
customizer" (the colour model, the dye gradient, the highlight width);
CLAUDE.md "A player's character". The probes are
`web/core/examples/hair_frame.rs` (vertex streams and the tangent frame),
`strand_units.rs` (the vertex red's unit) and `hair_streams.rs` (colour
channels against depth).

## 1. The gap, looked at closely

Noel's in-game captures (`data/reference/ilucide/`) beside our branch render
under the hangar probe, the hair cropped and magnified (session scratch
`chr/final/normals-prototype-hairzoom.png`):

| what the game shows | what we show |
| --- | --- |
| **Strand contrast.** Near-white strands lie over a mid grey-brown base; dark separations between clumps. Luminance in the hair spans p10 46 to p90 232 (background included, so an overestimate -- but the bright strands are real). | One warm brown; strands visible as lines about 10% lighter or darker than their neighbours. Hair luminance p10 12, p50 21, p90 76 under the hangar light. |
| **A broad sheen** across the whole crown, near white at the top, and from the back (`back.png`) a sheet of it over the upper head. | A faint band. |
| **Tone.** Ash: desaturated, cool. | Saturated, warm. |
| **Volume.** From the back the interior is dark and the outer strands bright: the mass reads as deep. | Flat. Head hair draws without its baked occlusion (CHARACTER.md: applying it went 20% darker against the skin). |
| **Edges.** Thin, separated, soft; flyaways at the silhouette; the nape ends in single hairs. | Slightly clumpy; cut-out edges. |
| **Beard.** Dense dark mass, grey through the moustache and chin as a soft blend, soft edges on the cheek. | Dark, with high-contrast white specks; thinner at the cheek edge. |
| **Brows.** Hairs visible, soft. | A solid dark shape with a hard edge. |

The tone and the sheen are partly lighting (the capture has a strong top light
and a teal cast none of our presets have). The strand contrast, the volume
and the edges are not.

## 2. What the archive carries

Measured on the 4,095 head materials under `Objects/Characters/Human/heads/`
(session scratch `chr/xml/`), Ilucide's three meshes, and their textures.

### 2.1 Three generations of hair material

| | shader | where | submaterials | flags | colour from | textures |
| --- | --- | --- | --- | --- | --- | --- |
| gen 1 (2018) | `Hair` (CryEngine's own) | `heads/shared/hair/`, 89 styles + `mtl_var/` colourways | 4,233 | `%ANISO_SPECULAR` all, `%NORMAL_MAP` 2828, `%DIRECTION_MAP` 1916, `%VERTCOLORS` 1861, `%HAIR_CAP` 1572, `%OIT` 886 | a `_diff` texture | TexSlot1 `_diff` (RGB + alpha mask), TexSlot4 `_spec`, TexSlot2 `_ddn`, TexSlot6 `_dirm` |
| gen 2 (2019-20) | `HairPBR` | `hair_v2/` (500 skins, 230 cdf), `facialhair/` (106), `brows/` (37) -- **Ilucide's** | 3,564 | `%HAIR_CARDS` 1886, `%PIXEL_DEPTH_OFFSET` 1880, `%HAIR_CAP` 1555, `%CARD_ID_MAP` 1495, `%DIRECTION_MAP` 830, `%HAIR_COAT` 198 | `BaseMelanin`, `BaseMelaninRedness`, `BaseMelaninVariation`, `DyeColor/Amount/Shift/Fadeout`, `DyePigmentVariation`, `BaseTintColor` | TexSlot1 `_opac`, TexSlot4 `_id`, TexSlot6 `_dir` -- no normal, no AO, no spec |
| gen 3 (2022+) | `HairPBR` + `%MELANIN_MODEL` | a handful re-authored under `heads/shared/hair/mtl_var/` (`m_parting_hair_01`, `f_pixie_hair_02/03`, `f_bun_hair_01`) and `brows/` | 384 | plus `%VIEW_ALIGNED_STRANDS`, `%BAKED_VERTEX_DATA`, `%CUSTOM_TANGENTS`, `%SCALP_TEX_COORDS` | `MelaninBase/Redness/Variation/Graying`, `BleachAmount/Variation`, `DyeShiftSoftness`, `TintColor`, `SpecularBreakup`, `AmbientOcclusionRescale`, `ShadowAlphaTest` | TexSlot1 `_card_a_diff` / `_card_b_diff` |

CIG's own record matches (public monthly reports, found by the survey in
§6): cards, pixel depth offset and edge masking joined the PBR hair shader in
early 2019; the melanin-and-dye colour model in January 2020; "greying
controls, variation tiling and melanin selection" in June 2022, which is gen
3's parameter set.

Which generation a figure wears is per style: Ilucide's `hair_75` is gen 2.
Whether the customizer still offers the 89 gen-1 styles is unverified (the
head item records would say; the scratch did not have them). It matters
because **our hair path misreads gen 1**: `material.rs` maps TexSlot4 to
`strand_id` and TexSlot6 to `strand_direction` by slot alone, and
`hairMaterial` takes a submaterial with no `%HAIR_*` flag as a cap when its
TexSlot1 is not named `_opac`. A gen-1 card material has neither flag and a
`_diff` in slot 1, so it draws as a cap, with its `_spec` read as an ID map.

### 2.2 A gen-2 card material, input by input

Ilucide's `hair_75_m`, `facial_hair_011` and `brows` share the shape;
`texture_6_1-25px_*` (hair), `hair_texture_01_*` (beard), `brows_texture_01_*`.

**`_opac` is two strand sets, BC5.** Red and green are each a sheet of strands
(11.3% and 8.8% of texels on, at 4096), 2-4 px wide; 31% of red's texels are
also green (correlation 0.29), so green is largely a second set rather than
an attribute of the first. Blue is BC5's missing channel (the decoder fills
128), alpha is 255. Coverage rises toward the bottom of the sheet: the roots
are at v = 1 and the tips at v = 0 (every card's red counts up as its v goes
down). The brows' sheet is BC4: five solid rounded bars -- **a brow card is one
hair**, not a sheet of them.

**`_id` is a random grey per strand, BC4**, filled everywhere (background
127). Mean on the strands 127-128, std 68-83: a uniform draw.

**`_dir` is a tangent-space direction, BC7**, and on hair it is nearly
constant: on the strand texels x -0.002 +/- 0.111, y +0.987 +/- 0.052,
z +0.015 +/- 0.117. The strand runs down v, and the map says so almost
everywhere. The coat's (`m_hair_75_coat_dir`) does vary, the scalp's short
hairs lying in every direction. The brows' is a binary green. The slot order
differs on the brows: `m_brows_002` puts the `_dir` in TexSlot4 and the
`_id` in TexSlot6 -- 11 materials in the archive do, all brows -- and our
slot-keyed reading **swaps them**: the brows' per-strand id is a flat 0.5
(from the direction map's red) and their anisotropy direction is random
grey. The suffix is the reliable key, the slot the fallback.

**The parameters, and which we read.** Counts over gen-2 card submaterials
(`cards`), the median where it is informative, and what the viewer does:

| parameter | cards carrying it | median (p10-p90) | Ilucide's hair / beard / brows | viewer |
| --- | --- | --- | --- | --- |
| `Smoothness` | 1525 | 0.48 (0.05-0.65) | 0.57 / 0.50 / 0.65 | read: lobe width |
| `SpecularMultiplier` | 1485 | 0.67 (0.20-1.0) | - / 1.0 / - | read |
| `BaseMelanin*` | 1497-1695 | | 0.60 / 0.79 / 0.95, variation 0.29 / 0.25 / 0.21 | read; **variation scaled by a chosen 0.15** |
| `Dye*` | 1458-1792 | | beard: amount 0.38, brown, fadeout 0.074 | read (CHARACTER.md) |
| `BaseTintColor` | 1984 | 1,1,1 (1285); 0.188 grey (190) | 0.78 / 1 / 1 | read, as a multiplier |
| `AmbientOcclusion` | 1882 | 2.59 (0.58-3.24) | 2.58 / 3.24 / 2.0 | read as a power on vertex green -- **beards only** |
| `ShadowDensity` | 1007 | 2.85 (2.0-3.6) | - / 3.71 / - | read as a power on vertex blue -- beards only |
| `OpacityMipScale` | 734 | 1.10 (1.0-3.5) | 3.20 / 2.70 / 1 | read: lifts the mips |
| `PixelDepthOffset` | 1802 | 0.007 m (0.001-0.018) | 2.7 / 9.2 / 9.7 mm | **not read** |
| `SpecularVariation` | 599 | 0.25 (0.21-0.95) | 0.24 / - / 1.0 | **not read** (a fixed shift jitter of 0.3 stands in) |
| `SpecularRootOcclusion` | 401 | 0.09 (0-0.79) | 0.58 / - / 0.65 | **not read** |
| `RadialShadowFadeout` | 401 | 0 (0-0.59) | 0.40 / - / 0 | **not read** |
| `OpacityMapGamma` | 198 coats | 1.0 (0.66-1.30) | coat 1.09 | **not read** |
| `SpecularBreakup`, `AmbientOcclusionRescale`, `ShadowAlphaTest`, gen-3 set | 290-384 | | - | **not read** |

**How grey is authored says two things.** `m_hair_75_grey` is melanin **0**
with `BaseMelaninVariation` **0.86** under a `BaseTintColor` of 0.66; the
grey beard is melanin 0 under a tint of 0.19. So the tint really is a
multiplier on the colour (read, correctly), and a grey head is white strands
spread *up to 0.86 of melanin* -- salt and pepper, as the April 2020 report's
"salt and pepper slider" says. Our spread is `variation x 0.15` of melanin:
at 0.86 that is 0.13, and every strand stays near white. **The variation is
in melanin units** (inferred from this one family; a render of `_grey` would
confirm it), which also means Ilucide's hair at 0.60 +/- 0.29 should carry
strands from 0.31 to 0.89 -- the per-strand contrast the capture shows.

**A cap is a shadow, not hair.** The beard's cap submaterial is named
`facial_hair_011_scalp_shadow`: `%HAIR_CAP`, `Diffuse` 0,0,0, `Smoothness`
0, `SpecularMultiplier` 0, no melanin, one `_scalp` texture that is white
with an alpha peaking at 0.28. 994 caps carry a black `Diffuse`, 156 a dark
brown. Read as the cap's colour, black is a darkening of the skin under the
beard, brown a stain -- and our cap draws the hair's colour through its
density instead (`hairCap`). Invisible on a dark beard; wrong on a blond one.

### 2.3 The mesh

`m_hair_75.skinm` (60,473 vertices, 4,464 cards), `m_facial_hair_011`
(46,422; 3,028 cards + a 2-card cap), `m_brows_002` (8,810; 574 cards + a
79-card coat). Streams: positions + one UV (`IVOVERTSUVS`), a **second UV
set** (`IVONORMALS2` at element size 4, which StarBreaker documents as the
dual use of that stream), tangent frames as quaternions (`IVOTANGENTS`),
packed normals (`IVONORMALS`, beard and brows only), colours (`IVOCOLORS2`)
and eight-wide bone maps.

**Vertex colour.** Red is the step from the root (CHARACTER.md; 2.1 mm a
step). Green and blue on head hair spread widely -- p10 104, p50 170, p90 248
and p10 98, p50 133, p90 218 -- and both rise with distance from the head's
centre (correlation +0.33, +0.42): baked occlusion, dark at the roots and
deep in the mass, as `AmbientOcclusion` and `ShadowDensity` expect. On the
beard and brows they sit near white (p10 231 / 226 on the beard). Alpha is
255 throughout the cards and 1 on the cap and coat submeshes.

**The second UV set** is a different mapping on every vertex (hair_75: u
0.22-0.77, v 0.17-0.80). Its meaning is not established; gen 3's
`%SCALP_TEX_COORDS` is the obvious reading -- the card's root projected into
the scalp's UV, so a head of hair can take its root colour or occlusion from
one scalp texture. Unused here.

**The normal stream is the strand, not the card's normal.** On all three
meshes the vertex "normal" the reader returns lies along the card, root to
tip (|n . root->tip| median 0.97, 0.96, 0.95), is perpendicular to the
tangent (|n . t| = 0.00), and is *not* the triangle's normal (|face . n|
median 0.12, 0.22, 0.12). The triangle's normal is the cross product of the
two (|face . t x n| median 0.86, 0.87, 0.74). The beard and brows carry a
packed `IVONORMALS` stream and hair_75 only the quaternion frame, and both
routes give the strand, so this is the data, not a decoding slip: CryEngine's
own `Hair.cfx` never reads a normal stream either -- it builds the normal as
`cross(tangent, bitangent)` in the vertex shader and takes the hair direction
from the bitangent. The viewer binds that stream as three.js's `normal`
(`geometry.ts`), so **every hair card has been lit with its normal pointing
along the strand**, and `HAIR_SPHERE` 0.8 -- the bend toward a sphere round
the head that made the hair "shade as one volume" -- has been standing in
for the normal that was never there.

### 2.4 The ancestor: CryEngine's `Hair.cfx`

The engine's hair shader (CryEngine V, from a public mirror; session scratch
`cry/Hair.cfx`, `shadeLib.cfi`) is what gen 1 runs on and what HairPBR grew
from. What it does:

* **Three passes, one technique.** `opaque_pass` writes depth, no culling;
  then `front_pass` (cull front, i.e. the back faces, depth test `Less`, no
  depth write, blended) and `back_pass` (the front faces, likewise). The
  blended passes `clip(alpha - 0.05)`. `%THIN_HAIR` replaces this with a
  depth-only pass at `ThinHairThreshold` and one blended pass. Alpha is
  `saturate(mask * AlphaBlendMultiplier)`, and `SoftIntersection` fades it
  by `saturate(depthDiff * 100)` against the scene depth -- the hairline.
* **`%VIEW_ALIGNED_STRANDS`**: each vertex moves along
  `cross(bitangent, toCamera) * (u - 0.5) * StrandWidth` -- a ribbon turned
  to face the camera, for single-hair cards like the brows'. StrandWidth
  0-0.04 m.
* **Lighting.** Diffuse is wrapped, averaging the per-pixel and per-vertex
  N.L: `saturate(((NdotL + NdotLvertex) / 2 + wrap) / (1 + wrap)^2)`, plus a
  scatter term. Two Kajiya-Kay lobes on the half vector, `pow(sqrt(1 -
  (T.H)^2), e)`: the primary at `exp2(10 gloss + 1)` with its colour capped
  at **0.045**, the secondary at `exp2(10 max(gloss / SecondaryWidth, 0.4) +
  1)` times `SecondaryColor` times the hair's colour; both scaled by
  `saturate(N.L)`. Gloss is clamped to 0.5-0.9. The tangents are
  `normalize(dir + shift * N)` with `shift` from the direction map's blue by
  `ShiftVariation` plus the secondary's own offset.
* **Occlusion.** On the opaque pass, a screen-space bent-normal buffer gives a
  per-light direction occlusion floored at 0.3, and ambient is scaled by
  `max(1 - occ/2, 0.5)`. Ambient comes from the tiled probes on the geometric
  normal, or a mip-7 lookup of the environment cube. `%VERTCOLORS` multiplies
  the diffuse by the vertex RGB.
* **Shadows** are generated with the alpha test, back faces culled.

So the viewer's lobes, wrap, clip and two-pass structure are the ancestor's.
What HairPBR added on top is in §2.2's unread column and in §6's record.

## 3. What the branch does now

`materials.ts` `hairCards`, `hair.ts`, `kitbasher.ts`: a cut-out pass at
alpha 0.5 with alpha-to-coverage on a 4x MSAA target, then a blended fringe
pass of the same buffers, inner cards first; coverage-preserving mips lifted
by `OpacityMipScale`; two Kajiya-Kay lobes at d'Eon's width for the
material's smoothness, scaled by `SpecularMultiplier`, plus the same lobes
on the environment as one light along the normal; a wrapped diffuse; the
normal bent 80% toward a sphere; melanin and dye per strand from the ID map,
**averaged to the mean strand where a pixel spans more than two texels**
(`resolved`); root-to-tip shade and tip fade; vertex occlusion on beards
only; shadows cast by the cut-out.

Against §1, the pieces that produce each gap:

* *Strand contrast*: the melanin spread is a tenth of what the data says
  (§2.2), and the `resolved` average removes per-strand variation at exactly
  the distance a portrait is seen from. The game keeps its strands at that
  distance by resolving them temporally, not by averaging them.
* *Sheen*: a lobe lit by a normal that is the strand direction, then bent
  toward a sphere; no per-strand `SpecularVariation`; no `SpecularRootOcclusion`.
* *Volume*: head hair ignores its baked occlusion.
* *Edges*: no pixel depth offset, no temporal resolve; the fringe pass is
  clipped at 5% and gained 1.5x.
* *Beard speckle*: the dye is per strand either-or, and the `resolved`
  average turns it into a uniform grey only beyond the portrait's distance.
* *Brows*: the id/dir swap (§2.2); single-hair cards drawn as sheets.

## 4. The methods, assessed against this data

From the survey (§6) and the engine source, each against what the archive
gives us and what three.js r169 can do. Cost is relative; "fixes" names the
row of §1.

| # | method | fixes | inputs | cost | verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | **The card's real frame**: the strand stream as the tangent, the normal from the triangles (or `cross`) | sheen, volume; a prerequisite for 2-5 | in the mesh already | small (prototyped, §7) | do first |
| 2 | **Per-strand variation kept at distance**: melanin spread in melanin units; `SpecularVariation` jittering each strand's lobe and shift by its id; `SpecularRootOcclusion` fading the lobes toward the root; drop the `resolved` average and let the MSAA resolve carry the strands | strand contrast, sheen, beard | `_id`, the params, vertex red | small | the largest visible change on offer |
| 3 | **Occlusion on head hair** by `AmbientOcclusion` and `ShadowDensity` as on the beard, with `RadialShadowFadeout` easing it by distance from the head's centre -- and if it still reads 20% too dark, that is the normal (1), not the occlusion | volume | vertex G/B, params | small | do with 1 |
| 4 | **Pixel depth offset**: `gl_FragDepth` pushed back by `(1 - alpha) * PixelDepthOffset` | edges, hairline, card intersections | the param (2.7-9.7 mm) | small; disables early-Z on hair only | yes; it is what the game does |
| 5 | **Temporal resolve**: `alphaHash` with `TAARenderPass` accumulating while the camera is still, a hashed `customDepthMaterial` for the shadow, and the fringe pass dropped | edges, strand contrast | - | medium; grain while orbiting | yes, after 2; CIG's own cards are "temporally dithered" |
| 6 | **Transmission (TT) and fake scatter**: a backlight term through the card, tinted `sqrt(albedo)`, gated by alpha and shadow; Karis's wrapped lambert on a view-derived normal with absorption by shadow depth | tone (ash, blond, grey), rim light | shadow map, albedo | medium | yes for light hair; CIG added "scattering for blonde" in 2020 |
| 7 | **Self-shadow with filtering**: wide PCF / VSM on the key for hair, then deep opacity maps (3 layers from the light) | volume, sheen | shadow pass | medium-large | later; 3 first |
| 8 | **View-aligned strands** for one-hair cards (brows, gen 3) | brows | tangent frame, `StrandWidth` | small | with the brows fix |
| 9 | **Cap as shadow**: black `Diffuse` darkens the skin, brown stains it | beard edge, blond beards | `_scalp` alpha | small | yes |
| 10 | **Gen 1 and gen 3 materials** read for what they are | other characters | §2.1 | medium | after Ilucide is right |
| 11 | WBOIT, depth peeling, per-frame card sorting | edges | - | large | no: the opaque core plus 4-5 covers it |
| 12 | Full dual scattering, Marschner R/TT/TRT per fibre | - | - | large | no: cards average the azimuth already; 6 is the card-sized version |

Two of the survey's recommendations are already in place (the two-pass
cut-out-and-fringe, coverage-preserving mips) and one -- transferring the
cap's normals onto the cards -- is what `HAIR_SPHERE` approximates and what 1
makes unnecessary.

## 5. The order

Each step is verified the way the branch was: Ilucide loaded in the studio
page, `engine.portrait()` captured under the hangar probe, cropped and set
beside `three-quarter-left.png` (`chr/bin/sheet.py`), with the hair's
luminance percentiles and -- for strand contrast -- the std of luminance
within the hair region as the figure to move.

1. **Frame and occlusion** (methods 1, 3; the brows' slot swap; the cap as
   shadow). Strand to tangent, normal from the triangles, `HAIR_SPHERE` to 0
   or near it, occlusion on head hair with `RadialShadowFadeout`. Measure:
   the hair's p10 and the back view's interior.
2. **Strands** (2). Melanin spread in melanin units, `SpecularVariation`,
   `SpecularRootOcclusion`, the `resolved` average gone. Render `m_hair_75_grey`
   and `_blonde` beside the customizer's swatches as the check that the
   spread is in the right units. Measure: luminance std in the hair.
3. **Depth offset** (4). Then the fringe pass is reconsidered: with the
   cut-out pushed back by its alpha, the fringe may be doing less.
4. **Temporal resolve** (5), behind a flag at first, since the kitbasher is
   orbited constantly and the portrait is captured still.
5. **Transmission** (6), judged on `_blonde` and `_grey` against the
   customizer's rendering of them, not on Ilucide.
6. Self-shadow (7), brows as ribbons (8), the other generations (10).

## 6. What the public record adds

Gathered by two surveys (session agents, 2026-11-02; primary sources where
they exist).

**CIG, in order.** Feb 2019: "initial hair mask, support for edge masking,
and pixel depth offset". Mar 2019: "an experimental option for custom
tangents, removed the temporary scatter model, moved the hair mask to
variation map alpha ... added card support for the hair PBR shader". Apr-May
2019: "enhanced the temporal dither pattern for reduced noise on hair cards".
Jan 2020: "a hair color model with base melanin and bleach/dye layers". Feb
2020: "hair AO ... now coupled with color, and dye shift softness". Apr 2020:
"a new slider for creating a 'salt and pepper' look and improved scattering
for blonde and bright hair". Dec 2020: "improved boundary occlusion at
hairlines, support for ambient lights in forward shading". May 2021: "fixed
shadow map generation of view-aligned strands and a new experimental
scattering model for better looking blonde hair". Jun 2022: "greying
controls, variation tiling, and melanin selection". 2024 customizer: a
root-to-tip gradient, full-RGB dye, separate dye slots for hair, brows, beard
and **stubble** (`StubbleDye` in the `.chf` key table); no per-strand colour.
The wiki's engine page lists "order independent transparency for specific
shaders such as hair", which is gen 1's `%OIT` flag. Hair is forward-shaded.

**The literature, as it applies to cards.** Scheuermann 2004 is the shape of
`Hair.cfx` (two shifted Kajiya-Kay lobes, a shift texture and a noise texture
per strand, per-vertex AO, the opaque-then-blended passes). Marschner 2003
gives the lobe placement (R shift -5 to -10 degrees, TRT at -3/2 of it,
widths 5-10 degrees); Karis 2016 reduces it for games and says the missing
piece on light hair is multiple scattering, faked with a wrapped lambert on a
fake normal and absorption by shadow depth, with filtered shadows "vital".
Chiang 2016 is the melanin model we use. Castano 2010 is the coverage mips we
have. Wyman & McGuire 2017 is hashed alpha, their own figure a bearded man.
Yuksel 2008 is deep opacity maps. three.js r169: `alphaHash` hashes
object-space position at scale 0.05 (patchable), the shadow depth material
does not inherit it, `GTAOPass` cannot see cut-outs (hair is already kept out
of it), `MeshPhysicalMaterial.anisotropy` is one GGX lobe (its data
convention is a flow map; its BRDF is a step down from the Kajiya-Kay pair).

## 7. The prototype, and what it measured

Method 1 was tried on the branch for an hour and reverted. In `kitbasher.ts`,
for any mesh whose materials carry `hairPigment`: the `normal` attribute was
copied into a `tangent` (w = 1), deleted, and `computeVertexNormals()` run;
in `materials.ts` the anisotropy map was dropped and the rotation set to 0,
so three.js's `vTangent` -- skinned for free -- became the lobes' direction
and the triangles' normal the shading normal, `HAIR_SPHERE` left at 0.8.

Ilucide under the hangar probe, hair region of the portrait: luminance p10
12.1 -> 14.0, p50 21.5 -> 24.0, p90 unchanged at 76.2; the crown a little
lighter and the band a little broader. **Subtle, as it should be**: with the
sphere bend at 0.8 the normal was already four-fifths synthetic, and the
derivative tangent along v was already close to the strand. The value of
the fix is in what it allows (`HAIR_SPHERE` off, per-card shading that is
right, the strand exact), not in this number.

Two harness notes. The character load is still raced by the saved-outfit
restore: the first prototype capture showed another head in armour, and only
a second `loadCharacter` after the engine went quiet gave Ilucide. And every
capture under the `creator` preset came back **byte-identical** to the first
one taken (4,960,228 bytes, three times, across a reload of the character),
so the creator-light captures in this session are not evidence; the hangar
ones are.

## 8. Not to repeat

* Reading the vertex colour's green as a selector of which strand set to draw:
  both sets are drawn and green is baked occlusion (§2.3).
* Taking `BaseMelaninVariation` as a small fraction of melanin: `_grey` says
  otherwise (§2.2).
* Treating the normal stream as a normal on hair, then compensating with a
  sphere (§2.3).
* Mapping `_id` and `_dir` by slot: the brows swap them (§2.2).
* A per-frame sort of cards or an OIT pass before the cut-out core is right:
  the engine's own order is opaque, back faces, front faces, and it ships
  `%OIT` only on gen 1.

## 9. Built (2026-11-02, the same day)

The §5 order, built on `character-shine` and measured the way §5 says:
Ilucide under the hangar probe, the hair masked by a second capture with it
hidden, ratios against the forehead (`hair p50` below). The game's forehead
reads 244 and is clipped, so its ratios are overstated; the order holds.

| step | built | measured |
| --- | --- | --- |
| 1. frame | `hair.strandFrame`: where a card group's normal stream sits at less than half the triangles' normal, it moves to `tangent` and the normals come from the triangles. Decided per mesh: hair, beard and brows take it; the lashes carry a real normal and are left alone. `HAIR_SPHERE` 0 for framed cards. | frame alone: hair p50 0.23 (was 0.24) -- the sphere had been standing in |
| 1. occlusion | head hair takes its vertex occlusion like the beard; `ShadowDensity` only where declared (`hair_75` declares none) | p50 0.23 -> 0.16 under the hangar light, where ambient is most of it; kept, as authored |
| 1. brows | `material::hair_role`: `_id` and `_dir` by suffix, slot as fallback | affects the 11 NPC brow materials; Ilucide's `brows_002` was never swapped |
| 1. cap | a cap with no pigment draws its own `Diffuse` (the beard's black shadow); caps take their own `SpecularMultiplier` (0 on that shadow, which had a grey-blue sheen) | |
| 2. strands | melanin per strand in the shader, `BaseMelaninVariation` in melanin units, the far-distance average the strands' true mean colour; `SpecularVariation` as the shift jitter; `SpecularRootOcclusion` linear from the root (shape chosen) | hair saturation 0.91 -> 0.69 (game 0.27, under its teal light) |
| 3. depth offset | `gl_FragDepth` pushed back by `(1 - alpha) x PixelDepthOffset` | jaw and chin coverage -3 points; the beard's edge scatters into strands |
| 4. resolve | the portrait hashes hair per layer, steps the threshold through 16 jittered frames and averages them in linear light; the blended pass is off while it runs; hashed opacity is the authored density x 1.5, as the blended pass takes it | hair std/median 1.81 -> 1.26 (game 0.40); the beard's chin 0.86 of the bare skin against the cut-out's 0.81; a portrait takes 5-11 s against 1.7 |
| 5. transmission | Karis's TT lobe, `sqrt(albedo)`, width roughness^2 / 2, gated by the direction out from the head (the rim light casts no shadow) | hair p90 0.76 -> 0.97; a warm edge along the crown where the key comes from above and behind |
| 6. generations | `material::hair_kind`: a cap flag wins (2022 scalps carry both), CryEngine's `Hair` is cards unless a cap. TS: gen-1 colour is its `_diff` (sRGB) times `Diffuse` -- its 33 colourways set only that; gen-3 names folded into gen 2's (`MelaninBase` and the rest), `Shininess` for smoothness, `BleachAmount` as melanin taken out (inferred); a melanin-model scalp takes the hair's colour | `m_combedback_hair_01` default and `_10` dark brown, `m_spiky_fade_hair_01` gen 3: all draw as full heads of hair; before, gen-1 strands drew as a cap |
| 6. shadow | hair reads the key's shadow through a 16-tap Poisson disc of 6 texels (about 7 mm) | barely moves Ilucide under the hangar (612 pixels by more than 30 of 255) |

**Ilucide's `.chf` sets his hair's variation to 1.0**, the slider's top --
a full unit of melanin either way, a third of his strands at none. Read so,
at the game's head size his hair is the grey-brown ash of the captures,
where step 1's was a saturated brown; magnified, it is visibly salt and
pepper, which the back capture also shows. The grey colourway reading (§2.2)
and this one agree; a customizer swatch would still settle it.

**Not built, and why:**

* *View-aligned strands.* 97 materials carry `%VIEW_ALIGNED_STRANDS` and
  none sets `StrandWidth`, so all would take the engine's 1 cm default; the
  gen-3 cards already have width and draw as hair without it. Ilucide's
  brows are gen 2 and unflagged, so the game does not ribbon them either.
* *Deep opacity maps.* The filtered shadow barely moved Ilucide under the
  hangar; the next lever is the light, not the shadow.
* *A temporal resolve in the live view.* The kitbasher renders every frame
  and is orbited constantly; it keeps the cut-out and blended pass.
* *`BleachVariation`, `MelaninGraying`, `SpecularBreakup`,
  `AmbientOcclusionRescale`, `RadialShadowFadeout`.* Read nowhere; the
  first two want a strand id gen 3 does not ship.

**What is still short of the game.** Hair against skin: p50 0.28 against
0.45, p10 0.07 against 0.26 -- the base is still dark and the game's broad
grey sheen across the crown is only partly there. *Later the same day:* most
of that was the tone curve, not the hair. Every preset sat in the Neutral
curve's toe, which squares what falls in it, ratios included (`LIGHTING.md`);
metered, the same hair under `hangar` reads p50 0.51, p10 0.15 and a spread of
0.67 against the game's 0.45, 0.26 and 0.40. At full-figure distance it now
resolves to a light grey, from the fifth of his strands at no melanin. The moustache reads less
grey than before the build, though no thinner: coverage of the region was
36% before, 33% after steps 1-2, 32% with the depth offset and 34% resolved,
its top edge now single strands. The dye on the tips is unchanged; the old
grey was likely partly the environment's sheen on cards lit along the
strand. Not isolated. With the strand colour,
frame, occlusion and resolve now taken from the data, what is left is the
light: the capture's strong top light and teal cast are not any preset.
