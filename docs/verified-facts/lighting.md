# Lighting, exposure and shadow

Scene lighting, metered exposure and the tone curve, the floor shadow, and backdrops.

### Lighting is matched to an in-game capture (2026-09-14)

Measured against a capture of Defiance Tactical with an Artimex helmet. Over
the torso the game reads **mean 34, median 29, 95th percentile 68**: dark, and
more to the point flat.

The scene used to stack a full image-based light at full strength with a 1.1
directional and a 0.25 ambient, giving mean 67, median 52, p95 157. Now
`Scene.ENV_INTENSITY` 0.25, `EXPOSURE` 0.85, directional 0.15, ambient 2.2,
which lands mean 33.6 and median 28.1.

**Ambient was the knob, not exposure.** The problem was the width of the tonal
range, not its level: lowering exposure matches the highlights but crushes the
midtones, and lowering the environment does both at once. Ambient fill lifts
the darks without adding highlights, which is what reads as matte. A sweep over
environment, directional, ambient and exposure confirmed no combination of the
first and last alone gets there.

**p95 still sits near 89 against 68, and no lighting value fixes it.** That
residual is specular response and wants lower metalness or higher roughness in
the bake. Left alone deliberately rather than compensated for in the lighting.

### The floor shadow, and poses that floated (2026-09-23)

The web kitbasher never had a shadow -- the local viewer's `ContactShadows`
blob did not come across. What it has now is the **key light's own shadow
map**: every worn and carried mesh casts and receives, and `three/ground.ts`
draws a floor that takes it. 23 carried items on a full set, 398k triangles
plus the shadow pass: 60 fps.

**The floor filters the shadow itself (PCSS).** The engine's PCF uses the same
few-millimetre kernel everywhere, which drew a hard black cut-out under armour
lit mostly by ambient fill. A blocker search gives the occluder's height above
the floor and the kernel widens with it, at `PENUMBRA_PER_METRE` 0.05: crisp at
the boot, about 12 cm at the helmet's shadow. The armour keeps the engine's
filter for its self-shadowing, where occluders are centimetres away. How dark
a full shadow is comes from the lights -- blocking a 2.2 key at 45 degrees
against 1.3 ambient and the rim leaves half -- not from taste.

**Blend the floor premultiplied.** Mixing colour and alpha separately between
"shadowed" and "lit" put a half-lit texel at half the *text* colour and a third
opacity, which drew every penumbra as a pale halo brighter than the floor.

**A shadow on a near-black page is invisible**, so on a dark theme the lit floor
is lifted 7% toward the text colour -- a pool the shadow is cut out of. On a
light theme and over a backdrop only the shadow draws. All three fade out
radially so there is no edge.

**The shadow showed that poses floated.** Clips apply rotations only, so the
hips stayed at their standing 1.0 m while a crouch bent the knees: the boots
were **30 cm** off the floor, and the raised stance, which flexes the knees,
**10 cm**. The grid never gave it away. `setPose` now seats the feet the way
the local viewer's `applyPose` always did -- the hips drop until the lowest foot
or toe bone is back at its rest height. Measured: crouch head **0.988** against
the pipeline's 0.99, hips 0.393; raised head 1.542, hips 0.900; idle unchanged.

### Backdrops

`viewer/src/components/Backdrop.tsx` puts a photographic plate behind the
character, cropped to cover rather than stretched. Lighting still comes from the
HDR environment: a screenshot is a perspective image, not an equirectangular
map, so using it to light the scene would be wrong. The reference grid is hidden
whenever a backdrop is active, since it reads as floating debris over a photo.

Backdrop images live in `data/out/backgrounds/` and are served through the same
`/assets` mount as everything else, which also means they are gitignored like
any other extracted asset.

### The Neutral curve's toe, and exposure metered (2026-11-02)

Reported by Noel: the RSI Zeus Exploration Backpack Starscape drew near-black
and glossy under `hangar` where the game shows a matte warm grey. The pack
was not at fault; the light was, on every piece.

**three.js's Neutral curve squares what falls below 0.08.** Khronos PBR
Neutral subtracts a 4% floor meant to cancel the Fresnel a dielectric gains
under unit light, eased in as `6.25 x^2` below 0.08 linear. The presets were
fixed at exposure 0.63-0.7, tuned to one dim capture's absolute levels, which
put an 18% grey card at the figure at 0.27-0.5 of the curve's design point.
Dark-to-mid surfaces came out squared and their highlights did not: the Zeus
shell at sRGB 9 against the game's 52, Ilucide's hair at 0.28 of his forehead
against 0.45. A plain grey material on the shell drew the same 9, so it was
not the layer shader; switching off the normal map, the decal sheet, the
shadow and the occlusion pass each changed nothing. The key delivered what
its angle says (0.153 linear on a 0.5 grey, 0.120 computed).

**Exposure is metered now** (`lighting.ts` `StudioLighting.meter`): an 18%
grey sphere at the figure, rendered from six sides with nothing else drawn,
sets the exposure so the card shows as 18% grey; a preset's `exposure` is a
mood either side of that. The shell reads 35-47, the hair 0.51 and 0.15 at
p10 against 0.07. Neutral stays the curve: both alpha solves need it affine
between their backdrop greys. **The Hangarworks item renderer's `--exposure
2` and its weapon and ship environment scales were compensating for the
toe**; against a metered preset its exposure wants to be 1. `LIGHTING.md`
has the review and the presets, which are now the game's own scenes.

The lesson is the one "Compare contrast, not absolute luminance" (`measurement.md`) already
states: an absolute level fitted through a non-linear curve fits the curve.
Sunchaser contrast moves from 3.22 to 2.38 (band 2.48-3.47) and the Defiance
torso from mean 34 to 54 against the dim capture's 34; the old figures were
read through the toe, which squares ratios. Gold coverage is unchanged.

**A capture backdrop is a display level, not light.** The portrait and the
Hangarworks item renderer solve alpha from two flat greys, 0.2 and 0.8
linear, which at exposure 0.7 sat on the curve's straight part. Metered
exposure runs 1.3-2.6 and put the light grey on the shoulder (0.8 x 1.41 shows
as 0.91, not 1.13), where a half-covered pixel solves as a third covered. A
flat backdrop now goes through the curve at 0.7 whatever the preset
(`Viewer.tsx` `BACKDROP_EXPOSURE`). The portrait barely noticed -- it averages
hashed frames whose pixels are mostly whole -- but single-frame captures,
edges and visors, would.

**Neutral's shoulder starts at 0.6** (2026-11-03, `three/toneCurve.ts`,
LIGHTING.md). Metered, white paints reached Khronos's nearly flat top and
drew paper white (Monde Legs 247 of 255); now 238, with nothing below 0.6
moved. It cannot go below the light capture backdrop's 0.52 without bending
the alpha solves, and `sceneTheme.neutral` mirrors it, so a change to one is
a change to both.
