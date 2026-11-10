# Lighting

The web kitbasher's lighting: what the 2026-11-02 review found, what it is
now, and what it was measured against. The local viewer's older, deferred
plan is kept at the end. `RENDERING.md` Phase 1 is where the presets came
from: the game's own probes, decoded from the visitor's archive.

## The review (2026-11-02)

Noel's report: the RSI Zeus Exploration Backpack Starscape drew near-black,
glossy and chipped under `hangar`, where the game shows a matte warm grey.
Taken apart, it was two systemic faults and no fault in the backpack.

**1. Every preset sat in the tone curve's toe.** three.js's Neutral curve
(Khronos PBR Neutral) subtracts a 4% floor meant to cancel the Fresnel a
dielectric gains under unit light, and below 0.08 it eases that in as a
square: `6.25 x^2`. The presets were fixed at exposure 0.63-0.7, calibrated
against one dim in-game capture, and that put an 18% grey card at the figure
at **0.27-0.5 of the curve's design point** -- inside the toe. A dark-to-mid
surface came out squared; its highlights did not. That is "darker and
shinier", and it was everywhere:

| | game | before | after |
| --- | --- | --- | --- |
| Zeus Starscape shell, back view (sRGB median / p10 / p90) | 52 / 32 / 81 | 9 / 3 / 24 | 35 / 16 / 66 (hangar), 47 / 15 / 83 (inventory) |
| Ilucide's hair against his forehead (p50 / p10) | 0.45 / 0.26 | 0.28 / 0.07 | 0.51 / 0.15 |
| hair luminance spread (std / median) | 0.40 | 1.37 | 0.67 |

A plain grey material on the pack's shell, same albedo and roughness, drew
the same sRGB 9: the layer shader, the normals, the decals and the shadow
were each ruled out by switching them off. The key light delivered what its
angle says (0.153 linear on a 0.5 grey against 0.120 computed); the curve
took it away.

The Hangarworks item renderer had been compensating from outside: it
re-exposes every card x2 through the Neutral curve's inverse ("the
game-calibrated preset reads too dark on the site's cards"), and scales the
environment x1.5 for weapons and x4 for ship parts. Its notes describe the
old `hangar` as "a standard weapon black with hot highlights" -- the toe.
Studio x2 is 0.98 of the design point: Noel's eye had found it.

**2. Wear was on by default.** See `docs/verified-facts/layerblend.md`, "A piece is drawn as it
left the factory".

**Also found:**

* The character creator's rig sat at **2.5 times** the design point and
  clipped -- why portrait captures under it came back byte-identical.
* `studio` lights from the game's own item-preview probe
  (`Data/UI/Textures/ItemPreview/EnvironmentProbes`, the Idris medical room),
  whose cool cast shows on a neutral grey (saturation 0.36 on the Zeus
  shell). Kept: it is how the game previews an item. It now loads that copy.
* `hangar` aims its key at the Idris probe's brightest patch, a bright wall
  behind the figure. An overhead key matched Ilucide's capture a little
  better (hair p10 0.19 against 0.15) and halved the light on the pack's back
  (13 against 35); the two captures are different hangars at different
  angles, so the probe's own direction stays.
* The archive ships more of the game's light than the presets used: a
  player hangar's probe (the asteroid hangar, teal), station interiors, and a
  planet time-of-day set (morning to night, overcast).

## What it is now

**Exposure is metered** (`StudioLighting.meter`). After a preset's lights
are set, a rough 18% grey sphere at 1.45 m is rendered from six sides into a
small float target with everything else hidden and no tone curve, and the
mean is the light the preset puts on the figure -- key, rim, ambient, probe
and the customizer's spots alike, whatever the outfit. Exposure is set so the
card shows as 18% grey, the Neutral curve's design point, times the preset's
`exposure`, which is now only a mood either side of it. Incident, not
reflective: a black suit is not brightened. `classic` alone is unmetered.

Neutral stays the curve. Both alpha solves -- the portrait's and the item
renderer's -- rely on it being affine between their two backdrop greys, and
at its design point it reproduces a base colour as authored, which is what
the palette work in `docs/verified-facts/` is measured in.

**Its shoulder starts at 0.6, not 0.76** (2026-11-03, `three/toneCurve.ts`).
Metered, a white paint under the key reaches 1.2-1.6, where Khronos's
shoulder is nearly flat: the Monde Legs' white plates drew paper white, 247
median and 249 at p90 under `inventory`. From 0.6 they read 238 and 241
(`hangar` 235 to 227); skin, a black suit and the gold's median do not move,
the brightest gold and Beacon's orange lose 5 of 255, and hue holds within
half a degree. The light capture backdrop sits at 0.52, so the solves stay
straight; that is also why it goes no lower. The lit face of a white plate
still has little form -- the light across it varies by a third, which no
curve keeping white under 1 spreads far.

**A flat capture backdrop is not lit, so it is not metered.** Those greys,
0.2 and 0.8 linear, were placed for exposure 0.7; at a metered 1.41 the light
one lands on the shoulder and shows 0.91 for 1.13, and a half-covered pixel
solves as a third covered. The viewer passes a flat backdrop through the
curve at 0.7 whatever the preset (`BACKDROP_EXPOSURE`), in its own capture
and in backdrop mode, which is how the item renderer draws.

**The presets are places the game lights things**, each by the game's probe:

| preset | probe | key | mood | metered exposure |
| --- | --- | --- | --- | --- |
| inventory *(reference)* | inventory screen, hue dropped | probe | 1 | 1.39 |
| studio | item preview (Idris medical room) | front right | 1 | 1.41 |
| hangar | Idris hangar | probe | 1 | 1.79 |
| asteroid hangar | a player hangar's own probe, teal | overhead, chosen | 1 | 1.72 |
| station | a station interior (`PU/cubemaps/lowtech`) | probe | 1 | 1.65 |
| daylight | Daymar, sunny | probe, warm | 1 | 1.34 |
| dusk | planet time-of-day set, dusk | probe, amber | 0.9 | 1.75 |
| night | the same set, night | probe, cool | 0.7 | 1.55 |
| space | Stanton, open space | probe | 1 | 2.57 |
| character creator | the customizer's ten spots | -- | 1 | 0.28 |
| classic | none: the original invented rig | fixed | -- | 1.0, unmetered |

The asteroid hangar's own brightest patch is low and behind, which left the
face at 0.42 of the Idris hangar's; its key is the ceiling floods instead.

## Measured

`npm run harness`, inventory, high quality (`RENDERING.md` Phase 0):

| measure | target | main | metered |
| --- | --- | --- | --- |
| Sunchaser gold, pooled | -- | 21.3% | 21.3% |
| Sunchaser contrast, pooled | 2.48-3.47 | 3.22 | 2.38 |
| Sunchaser back, gold | 33.0% | 42.6% | 43.2% |
| Corbel Halcyon hue | 46.8 | 46.3 | 45.4 |
| Beacon Orange hue | 30.2 | 31.5 | 27.5 |
| Lynx Arms Blue hue | 235.6 | 238.4 | 237.7 |
| Defiance Tactical torso mean / median | 34 / 29 | 34 / 28 | 54 / 49 |

Coverage and two of three hues hold. The contrast falls just under the band
because the toe was squaring it: a ratio read through `6.25 x^2` is the ratio
squared, which flatters an accent. The Defiance torso now reads brighter than
the dim capture it was once tuned to, an absolute level `docs/verified-facts/measurement.md` already
says not to trust. Beacon's bright orange (median 171 of 255) loses 2.7
degrees at the curve's shoulder.

Item renders, the 46-look render-review bench through the Hangarworks item
renderer, main at its default x2 against this branch at x1:

| | main, renderer x2 | branch, metered, renderer x1 |
| --- | --- | --- |
| median of the looks' median luminance | 77 | 73 |
| median shadow-to-highlight spread (p90 / p10, linear) | 34 | 34 |
| median share of blown pixels | 0.96% | 1.08% |
| looks over 2% blown | 16 | 15 |

The two draw items alike, so the renderer's x2 had been standing in for
exactly this exposure: **once this is on main the item renderer wants
`--exposure 1`**, or every card doubles. Its weapon and ship environment
scales are reflective, not exposure, and stay. What does change on the cards
is wear: painted armour loses its chips (the CDS Legacy arms' saturation 0.52
-> 0.59, the GSB boots 51 -> 55).

## Not done

* **Hair at full-figure distance reads light grey for Ilucide.** His `.chf`
  sets his hair's melanin variation to 1.0, and in melanin units a fifth of
  his strands carry none (`HAIR.md` §9); at portrait size it measures 0.51 of
  his forehead against the game's 0.45. Lighting does not decide it.
* **The local viewer** (`viewer/`) still lights with ACES at 0.85, calibrated
  on the same dim capture. ACES has no Fresnel floor, so the squaring above is
  Neutral's; its levels are the plan below.
* **The asteroid hangar's key** is chosen, not read.

---

# The local viewer: lighting model, deferred plan (2026-09-16)

Parked 2026-09-16 to work on the catalogue first. **Nothing here is
implemented.** The findings come from reading the current rig and drei's
internals, and they are where the work should start.

This plan is for the **local** viewer. The web kitbasher's lighting is planned
in `RENDERING.md` Phase 1, which keeps the preset table below but lights from
the game's own probes in the archive instead of downloaded HDRs.

## What is true today

`viewer/src/components/Scene.tsx`:

- `ENV_INTENSITY = 0.25`, `EXPOSURE = 0.85`, ACES filmic
- `<directionalLight position={[3,5,2]} intensity={0.15} castShadow />`
- `<ambientLight intensity={2.2} />`
- `<Environment preset={preset} />`, `HDR_PRESETS = ['warehouse','city','sunset']`
- `<ContactShadows position={[0,-0.002,0]} scale={4} far={2.2} blur={2.6} opacity={0.65} />`
- `<Canvas shadows>` is already on

Those light values are **calibrated** against an in-game capture of Defiance
Tactical: torso mean 34, median 29, p95 68. Keep them as a named preset.

## Two facts that shape the design

**ContactShadows can never follow a light.** Its depth camera is orthographic,
sits at the group origin and looks straight up `+Y` with `near 0, far 2.2`. It
is a contact/occlusion term, not a cast shadow, and no parameter makes it
directional. Its group y must also stay `<= 0` — see the gotcha in CLAUDE.md.

**`castShadow` is already set on the directional light and does nothing**,
because nothing in the scene sets `receiveShadow`; there is no ground. A
shadow-only plane (`<mesh receiveShadow>` with `ShadowMaterial`) makes the
existing light cast a real, movable shadow for the cost of one mesh, and draws
nothing but the shadow so the photographic backdrop still shows through.

So the model is two terms: **ContactShadows for grounding, a shadow-mapped key
for the cast shadow that responds to light position.**

## The design issue

`warehouse / city / sunset` conflates *reflection environment* with *mood*.
Separate them:

- **Environment (HDR)** — reflections and specular character. A small neutral set.
- **Mood (light rig)** — key/fill/ambient colour and intensity, exposure.

Coloured moods do not want HDRs. There is no useful HDR of a green smoggy
planet, and one would fight the key light. Colour belongs in the lights, with
`environmentIntensity` pulled down.

A movable key is also invisible at today's ratio: ambient 2.2 against
directional 0.15 is roughly 15:1. Non-reference presets need that much closer.

## Proposed presets

| preset | key | ambient | env | intent |
| --- | --- | --- | --- | --- |
| In-game *(reference)* | 0.15 neutral | 2.2 | warehouse 0.25 | the calibrated match; do not retune |
| Hangar | 1.2 slightly warm | 0.5 | warehouse 0.4 | readable, directional |
| Cold vacuum | 1.0 blue-white, hard | 0.15 | city 0.3 | high contrast, crisp shadow |
| Golden hour | 1.4 amber, low elevation | 0.4 warm | sunset 0.5 | long raking shadow |
| Emergency | 0.9 red key + dim blue fill | 0.25 red | warehouse 0.1 | alarm lighting |
| Toxic / smog | 0.7 sickly green, high fill | 0.8 green | warehouse 0.1 | flat, murky |
| Studio | 3-point neutral | 0.6 | warehouse 0.35 | product shots |

A declarative table — `{ env, exposure, ambient, key, fill, rim, shadow }` — so
a new mood is a data edit, not a component change.

## Control surface

Azimuth + elevation + intensity, not XYZ: two sliders match how people think
about light and encode into the share URL beside the loadout. The preset gives
defaults, the user overrides. Shadow length and softness then follow elevation
for free, which is the cue that sells a movable light.

## Risks

1. **The CDN dependency gets worse with more presets.** `<Environment preset>`
   fetches from `raw.githack.com`. Twice in one session a network blip took the
   whole Canvas down (`ERR_INTERNET_DISCONNECTED` → "Could not load
   empty_warehouse_01_1k.hdr" → unmount). Vendor the HDRs (~1.7 MB each at 1k,
   CC0 from pmndrs) into `data/out/env/` at setup, served through the existing
   `/assets` mount like backgrounds, and wrap `<Environment>` in its own error
   boundary so a failed HDR costs reflections rather than the whole viewer.
2. **Adjustable lighting invalidates colour measurement.** Gold median, contrast
   ratio and every "measured against the store render" note depend on lighting.
   `scx audit` and any reference comparison must pin the In-game preset.
3. **ACES desaturates saturated light at high intensity.** Red and green moods
   wash toward white if the key is pushed; keep intensity moderate and carry the
   saturation in the fill.
4. **The ContactShadows `y <= 0` constraint stands.** A new ground plane must sit
   at or below it, or the contact shadow silently disappears again.

## Order

1. Shadow-only ground plane — makes the existing `castShadow` real
2. Vendor the HDRs + error boundary — before multiplying presets
3. Preset table + azimuth/elevation, In-game pinned as reference
4. The moods, which are then pure data
