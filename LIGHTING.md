# Lighting model — deferred plan

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
