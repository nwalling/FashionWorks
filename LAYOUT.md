# LAYOUT.md: The kitbasher's controls, rearranged

A plan for rearranging the controls around the kitbasher's viewport. It
replaces the single wrapping toolbar with a left column that holds everything
the mode switch changes, plus two small overlays on the viewport for the rest.
It is layout work only: **no engine change, no new state in `Kitbasher`
(the class), no change to the loadout encoding or the share fragment.**

The design was picked from three candidates, which were mocked up and compared
(option C, "Dressing room"): https://claude.ai/artifact/5Jne557wSEUsRGeARxK9xn.
The names, counts and colours in the mockup are sample data. Build from the
real catalogue and this document, and treat the mockup as a picture of the
arrangement, not as a pixel spec.

## Status

| phase | state | exit test |
| --- | --- | --- |
| 1: the column | done | Toolbar gone. Mode switch, slot tiles, listing and equip-set/clear all in the left column. All three modes, both bodies, driven through the real UI. |
| 2: the overlays | done | Scene cluster (top right), More popover and pose dock (bottom centre) on the viewport. Orbit and zoom still work in every gap between overlay controls. |
| 3: narrow | done | At 720px and below, stage over column still holds. Tiles become chips, the cluster folds into one Scene button, the dock wraps. Nothing scrolls sideways. |
| 4: verified in the host | here: done. host: waits on the release | `npm run check` green here. The host's `test-fashionworks-theme.mjs` finds no AA failures in any theme. The canvas keeps its size when the mode changes and when the hold group appears. |
| 5: one bar | released, 0.16.0 and 0.16.2 | The overlays leave the canvas for one bar above it (2026-11-05): pose, animate and hold on the left, the scene on the right. Nothing is drawn over the figure; only the More popover and the portrait and loadouts panels open over the canvas, and only while open. Since 0.16.2 the bar is one row at every width: the scene folds into Scene when it does not fit ("One row" below). |

## Why

What `Kitbasher.tsx` has today, and what goes wrong with it:

1. **One toolbar holds everything.** Mode, the slot tabs, body/figure/character,
   pose/animate, quality, light, hold, surface, equip set/clear and backdrop
   all share `.fw-kit-bar`. Controls you use every few seconds sit next to ones
   you set once.
2. **The mode switch is far from what it changes.** Armour / clothing / gear
   rewrites the slot tabs and the whole side column. But it sits at the top
   left of the toolbar, not on the column.
3. **You can't see the whole outfit.** The listing highlights only the current
   slot's piece. To see what the other slots hold, or which holsters are full,
   you have to look at the body.
4. **The viewport's top edge moves.** The toolbar wraps differently with window
   width, with the mode (armour has up to 8 slot tabs, gear has 7), and when the
   `hold` group appears after the first weapon goes on. Every change resizes
   the canvas under the camera.

## The layout

```
┌──────────────────────────┬──────────────────────────────────────────────┐
│ [ARMOUR][CLOTHING][GEAR] │               [M|F] [light ▾ quality ▾] [More]│
│ ┌──────────┬──────────┐  │                               ┌─────────────┐ │
│ │helmet 214│torso  188│  │                               │ More popover│ │
│ │Antium Hel│Antium Cor│  │                               └─────────────┘ │
│ ├──────────┼──────────┤  │                                              │
│ │ ...slot tiles, 2-up │  │                 viewport                     │
│ └──────────┴──────────┘  │                                              │
│ [search..............]   │                                              │
│ holsters (gear) / colors │                                              │
│ ┌ listing (scrolls) ───┐ │                                              │
│ │                      │ │   [rest idle raised crouch | ▶ animate |     │
│ └──────────────────────┘ │    hold: nothing P4-AR S-38]                 │
│ [ equip set ][ clear   ] │                                              │
├──────────────────────────┴──────────────────────────────────────────────┤
│ status                         Not affiliated with or endorsed by CIG.  │
└─────────────────────────────────────────────────────────────────────────┘
```

What decides where a control goes is how often it's used, and whether the mode
changes it:

- **The mode changes it:** it goes in the left column, under the mode switch.
- **Used constantly while looking at the model (pose, animate, hold):** it goes
  in the dock at the bottom of the viewport.
- **Set now and then (body, light, quality):** it goes in the cluster at the
  top right.
- **Set once, if ever (figure, character, surface, backdrop):** it goes behind
  More.

## Where every control goes

Every control keeps its current `role`, `aria-*` attributes, `title` text,
`disabled` logic and handler. Only its position in the DOM and its styling
change. **Move the JSX; don't rewrite what it does.**

| control (today, in `.fw-kit-bar`) | new home | notes |
| --- | --- | --- |
| mode radiogroup "What to browse" | top of `.fw-kit-side` | Full width, three equal segments. Same disabled rule (`busy && name !== 'gear' && mode !== name`), same `choose()`. |
| slot tablist "Slot" | `.fw-kit-side`, under the mode switch, as tiles | See "Slot tiles". Same `tabs` array, same click handler. |
| body male/female | scene cluster | Two-segment control. |
| figure toggle | More popover | Same `rememberFigure`. |
| character… / × | More popover | Same hidden `.chf` input. The × sits beside the button, as now. |
| pose buttons + animate | dock | Same `poses`, same `POSE_TITLES`. |
| quality select | scene cluster | Still only rendered when `quality` is non-null. |
| light select | scene cluster | Still only rendered when `lighting.length > 0`. |
| hold radiogroup "In hand" | dock, after animate | Still only when `holdable.length > 0`. Because it's now in an overlay, its appearance no longer resizes the canvas, which fixes problem 4. |
| surface worn/factory | More popover | |
| equip set, clear | foot of `.fw-kit-side` | Two equal buttons, pinned below the listing. Same titles and disabled rules. |
| backdrop choose… / none | More popover | Same hidden image input. |
| status + attribution | unchanged | `.fw-kit-status` stays under the stage. **The attribution never moves into an overlay and never hides** (WEB-LEGAL.md condition). |

The search box, holster chips (`.fw-kit-ports`), colour row (`.fw-kit-ways`)
and listing (`.fw-kit-items`) keep their current order and markup. They just
come after the tiles.

## Slot tiles

The slot tabs become a two-column grid of tiles. Each tile works as the tab
for its slot and also shows what's worn there, which fixes problem 3 without
adding a column.

Each tile is still a `role="tab"` button in the same `role="tablist"
aria-label="Slot"`, with `aria-selected` as now. Its content has two lines:

```
┌───────────────────────┐
│ torso             188 │   slotLabel(name)   countOf(name)   (label + .fw-kit-count)
│ Antium Core           │   what's in the slot, or "empty"
└───────────────────────┘
```

- **Second line, armour and clothing:** `titleOf(wearing.get(name))`, the same
  line title the listing rows use. When nothing is worn it says `empty`, in
  `--sc-subtle`.
- **Second line, gear:** the gear carried for that slot, found as
  `[...carrying.values()].filter((i) => i.slot === name)`. Show the first one's
  `titleOf`, plus ` +N` when more than one is carried (magazines often are). Say
  `empty` when there's none.
- **Long titles** get one line with an ellipsis (`text-overflow: ellipsis`).
  Put the full `displayName` in the tile's `title` attribute. Clipping is
  acceptable here because the full name is one hover away and on the listing
  row.
- **Selected tile:** use an accent outline and `--sc-accent-soft`-style fill,
  **not** the solid accent fill the toolbar tabs used. A solid accent block
  behind two lines of text reads as a warning, and makes the subtle second line
  fail contrast.
- **Odd tile count:** the last tile spans both columns
  (`:last-child:nth-child(odd) { grid-column: 1 / -1 }`). No lonely half-row.
- **Hat and eyewear under a helmet:** the engine doesn't expose whether a
  worn hat is hidden by the helmet. Show the hat's name like any other slot.
  Don't add engine state for this in this change.
- **Accessible name:** give each tile an `aria-label` of the form `torso,
  188 pieces, wearing Antium Core` (or `, empty`). That way the tile doesn't
  read as a run-on of three numbers and a name.

**Height budget.** The tiles cost vertical space the listing used to have.
Tiles are 2 lines at 11/12px with 6px vertical padding, about 42px each.
Armour with both head slots is 8 tiles, or 4 rows: about 180px including gaps.
Clothing shows at most 8 of its 9 slots today (accessory is filtered out when
empty, as now). Gear is 7 slots, 4 rows. Widen the column from 260px to
**300px** so the titles fit. At a 1280x800 host window the listing should
still show at least 8 rows. If it doesn't, check that the tiles aren't taller
than the numbers above before changing anything else.

Optional, and only if it costs one line: under the tiles, a subtle note built
from `state.aside`, such as "clothing kept aside: 5 pieces", in armour and
clothing modes. It explains the exclusive-outfit model better than the mode
button's `title` does. Leave it out if it crowds anything.

## The overlays

The overlays are two positioned groups inside `.fw-kit-stage`, siblings of the
`<Viewer>`, over the canvas.

**Pointer events are the part to get right.** `OrbitControls` is bound to
`renderer.domElement`, so any element over the canvas steals drag and wheel.
Give each overlay container `pointer-events: none` and each control inside it
`pointer-events: auto`. The gaps between buttons must still orbit and zoom.
Test that with a real drag in the gaps, not by reading the CSS.

**Scene cluster** (`.fw-kit-scene`, top right, 12px inset). Three small groups
in a row: body (male/female), light + quality selects with their `.fw-kit-label`
labels kept visible, and a **More** button.

- More is a disclosure: `aria-expanded`, `aria-controls` pointing at the
  popover's id.
- The popover (`.fw-kit-more`) opens under the cluster, right aligned, about
  240px wide. It holds figure, character (with its ×), surface and backdrop,
  one labelled row each, in that order.
- It closes on Escape (focus returns to More), on a click outside it, and on
  More again.
- **It doesn't close when a control inside it is used.** Someone flipping
  surface wants to see the result and flip it back.

**Pose dock** (`.fw-kit-dock`, bottom centre, 14px above the status strip).

- Content, in order: the pose buttons, a divider, animate, a divider, then the
  hold label and hold buttons (when present).
- Hold's button labels stay `titleOf(item)` as now.
- Give it `max-width: calc(100% - 24px)` and `flex-wrap: wrap`, so a long hold
  list wraps to a second row rather than running off the stage or scrolling.
- Frame the figure so the dock doesn't sit on the feet. Check whether the
  default camera framing already leaves room at the bottom. If not, note it for
  a follow-up rather than changing the camera in this change: the framing is
  measured work (`docs/verified-facts/pipeline.md`, "Verified by rendering real armor").

**Overlay surfaces, theme rules.** No colour literals, as everywhere in
`kitbasher.css`, and stylelint enforces it.

- **Background:** `color-mix(in srgb, var(--sc-card) 88%, transparent)`, with a
  1px `var(--sc-border)` border and a 10px radius.
- **No `backdrop-filter`.** Blurring a live WebGL canvas costs GPU every frame,
  and the machines that pay most for it are the ones already on `low`.
- **Why 88% and not glassier:** the host's contrast test composites
  backgrounds up the DOM chain. The canvas isn't a DOM background, so the test
  will measure overlay text against `--sc-card` (the `.fw-kit` fill), not
  against the scene. A mostly opaque overlay keeps the real contrast close to
  what the test measures, whatever lighting preset or backdrop image is behind
  it. Don't lower the percentage to make it look glassier without measuring
  text over the `space` preset and over a bright backdrop image.

## Narrow screens (720px and below)

The existing rule stands: the stage comes first and the column second, at
`minmax(0, 45%)`. Within that:

- **Tiles become chips.** They drop to one line (slot label + count, no worn
  name) and wrap, like today's toolbar tabs. At 45% of a phone's height, four
  rows of tall tiles would leave no listing at all.
- **The scene cluster folds into one "Scene" button.** It opens the same
  popover with every scene control in it: body, light, quality, then the four
  More controls.
- **The dock stays**, wrapping to two rows if it must.
- **Nothing scrolls sideways.** The existing comments in `kitbasher.css`
  explain why: a sideways scroll cut a chip in half and hid the rest.

## What doesn't change

- **`.fw-kit-body` keeps `grid-template-rows: minmax(0, 1fr)`.** Read the
  comment above it before touching the grid. Its absence once caused three
  bugs, including a black viewport.
- **Unchanged interfaces:** `KitbasherProps`, the engine API, `loadout()` /
  `restore()`, `onLoadoutChange`, the `data-fashionworks-kitbasher` and
  `data-fashionworks-view` attributes, and the `fashionworks:lighting` and
  `fashionworks:figure` storage keys.
- **The `busy` gating on every control stays exactly as it is.**
- **The host needs no code change.** `--fw-top` and the app-mode CSS in the
  Hangarworks page measure the site header, not the component, so a version
  bump is the whole host-side change.
- **Out of scope:** keyboard shortcuts for modes, rendered thumbnails,
  on-body callouts, and a large colour strip under the figure. The last is the
  planned follow-up if the column feels cramped after Phase 1. Moving the
  colour row out of the column into the viewport, above the dock, would give
  the listing back ~50px. Record the listing's measured row count at the end
  of Phase 1 so that decision has a number behind it.

## Verification

In `web/app`:

```
npm run check      # typecheck + stylelint (no colour literals) + vitest
npm run harness    # the headless UI drive
```

Then drive the real UI headless (as CLOTHING.md Phase 3 did) and record the
results in this file under "Phase N, as run":

1. **Each mode:** the tiles show the right slots (armour includes hat/eyewear
   only when their counts are non-zero; clothing omits empty slots). Picking a
   tile changes the listing. Equipping from the listing updates that tile's
   second line.
2. **Gear:** carry a rifle and two magazines. The primary tile reads the rifle,
   the magazine tile reads `… +1`, and holster chips behave as today.
3. **Canvas stability:** read the `.fw-kit-view` bounding box at 1280x800
   - on load,
   - after switching armour → gear → clothing,
   - and after the first weapon makes the hold group appear.

   All three reads should be identical. Today they aren't; record the before
   numbers too.
4. **Orbit through the gaps:** a drag starting between two dock buttons
   rotates the camera, and a wheel over the cluster's gap zooms.
5. **More popover:** opens, stays open while toggling surface twice, closes
   on Escape with focus back on More.
6. **720px and 390px widths:** no horizontal scroll anywhere in the component,
   and the attribution is fully visible.

Then release as a minor version, install it in the Hangarworks site, and run
its `scripts/test-fashionworks-theme.mjs` (AA contrast across themes, with no
reload) and `scripts/test-fashionworks-archive.mjs`. Both must pass unchanged.

## Phases 1-4, as run (2026-09-25)

Built first on top of `character`, then rebuilt from `main` to ship on its
own: the character row of the More popover exists only with the character
work, so it is left out here and joins More when `character` lands (kept on
the `layout-character` branch). Everything below was measured with it in.

Driven headless through the real UI at 1280x800 on build 4.10.193.11644.

**Canvas stability, before and after.** `.fw-kit-view` as x, y, w, h:

| state | before | after |
| --- | --- | --- |
| on load (armour) | 260, 79, 1020, 690 | 300, 0, 980, 769 |
| gear | 260, 79, 1020, 690 | 300, 0, 980, 769 |
| clothing | 260, 79, 1020, 690 | 300, 0, 980, 769 |
| armour, hold group showing | **260, 112, 1020, 657** | 300, 0, 980, 769 |

The first weapon used to push the canvas down 33 px; nothing moves it now.
The canvas is 79 px taller, since the toolbar is gone.

**The listing keeps 8 rows** at 1280x800 in armour and gear, 9 in clothing
(12-14 before, when the tiles were a toolbar row). That is the brief's floor.
Tiles measure 44 px against the budgeted 42, so this is the number behind the
colour-strip follow-up.

**Tiles.** Armour shows its eight, hat and eyewear included; clothing shows
the eight slots with stock and omits the accessory. Gear, with a rifle and two
magazines carried: the primary tile reads the rifle, the magazine tile
`A03 Sniper Rifle M… +1` -- the `+N` is its own span, so the ellipsis never
eats it. Accessible names read `magazine, 59 pieces, wearing …` (and `1
piece`, singular). The selected tile is an accent outline over a 14% accent
wash on the field colour, since the theme has no `--sc-accent-soft`.

**Overlays.** A real mouse drag starting between the first two dock buttons
orbits the camera, and a wheel over the gap between the cluster's groups
zooms. More opens, stays open through two surface toggles, and closes on
Escape with focus back on More. Two things the brief did not say, found by
building it: the popover needs `[hidden] { display: none }` because its
`display: flex` overrides the attribute, and the dock is centred by auto
margins between `left: 0` and `right: 0` -- at `left: 50%` an absolutely
placed box can only grow into half the stage, and the dock wrapped for no
reason.

**Narrow.** At 720 and 390: no horizontal scroll in the page or the
component, and the attribution fully on screen (380-708 of 720, 74-378 of
390). Tiles are one-line chips; the cluster is one "Scene" button whose
popover holds body, light, quality, figure, character, surface, backdrop,
inside the screen (138-378 of 390). Narrowness is read with `matchMedia` at
the stylesheet's own 720px, so the controls are rendered once, not twice.

**Framing, for a follow-up.** The default camera frames the figure to the
bottom of the canvas, so the dock covers the lower legs: the shins at
1280x800, the knees on a phone. Left alone here, as the brief says -- the
framing is measured work.

**Checks.** `npm run check` green (143 tests, stylelint). `npm run harness`
runs through the new UI; its figures are render measures, unchanged in kind.
`studio.html`'s own fixed `#log` overlaps the attribution at the bottom
right on that dev page only -- it was there before, and it is not part of the
component.

**Not done here, by the brief's own order:** the minor release, and the
host's `test-fashionworks-theme.mjs` and `test-fashionworks-archive.mjs`.

## One bar (2026-11-05)

Noel, with a screenshot of the hosted kitbasher: the scene cluster sat over
the figure's head and the pose dock over its knees. He asked for the
controls out of the viewport, then for one bar rather than two.

**The bar sits above the canvas, in the page's flow.** Pose, animate and hold
on the left (`.fw-kit-dock`, the dock's old class), the scene on the right
(`.fw-kit-scene`): body, light, quality, Portrait, Save image, Loadouts and
More. Groups are divided by rules rather than by card surfaces, since nothing
is under them now. It wraps on a narrow stage, the scene side keeping to the
right, and at 720px and below the scene is still one Scene button.

**What this gives back, and what it costs.** The figure is never behind a
control, which also settles the framing follow-up above: the dock no longer
covers the shins. The cost is the overlays' reason for being: problem 4
returns in a small way. The bar is one line at a desktop width, but where it
wraps -- a narrow window, or the hold group appearing on one -- the canvas
shortens by a row. That trades a resize on a rare event for a control over
the figure all the time.

**What stays over the canvas.** The More popover hangs from the bar (the bar
is stacked above the canvas for it), and the portrait and loadouts panels sit
at the canvas's top right, 12px in -- no longer measured against the
cluster's height, since the cluster is not on the canvas. All three are open
only while used. The pointer rules the overlays needed (`pointer-events`
none on the containers) are gone with them.

## One row (2026-11-06)

Noel took the offer after 0.16.0: the bar wrapped to two rows at 1280 wide,
three at 1024 and four at 768, each row taken off the canvas.

**The scene folds whenever it does not fit, not at a breakpoint.** Body,
light, quality, Portrait, Save image and Loadouts go into the Scene button
whenever they would not fit on the bar's row beside the dock
(`useSceneFolded`, `Kitbasher.tsx`), as they always did at 720px and below.
A width cannot decide it, because the dock grows with what is held: the hold
group adds a button per carried weapon. Folded, the popover holds the scene
first, then Portrait, Save image and Loadouts on one row, then More's own
rows. Portrait goes with them, since above 720px the panel exists. The
popover is as wide as its widest row, never under 240px nor wider than the
window: at a fixed 240px, Hangarworks' larger buttons put Loadouts on a row
of its own (Noel, 2026-11-06).

**Folded there is nothing to measure,** so the scene is tried out again
whenever there is more room beside the dock than when it last folded: put
out, measured and folded back inside one layout effect, before a frame is
painted. That keeps no width of its own, which a cache would: one read
before the light list arrived, or while Save image said "saving…", would be
stale by the time it was used.

**A second fold, for the emote button (0.17.1).** 0.17.0 put *emote* in the
dock, and in Hangarworks the dock grew to 325px: at 768 and 390 it and the
Scene button no longer fitted one row, and the bar wrapped (Main App's check,
2026-11-06). So the fold has two levels (`useBarFold`): the scene first, then
*animate* too, which goes to the top of the Scene popover. Unfolding is tried
whenever there is more room beside the dock than when a level was reached,
and a level just unfolded to keeps unfolding while each fits, so one resize
from a phone's width to a desktop's goes all the way out. The emote menu
hangs from the bar's left edge, no wider than the bar; hung from its button,
the dock's third, it ran off the window's right edge at 768.

**Three more, for what is held (0.17.3).** A weapon adds *raised* to the
poses and a hold row to the dock, and with one in hand the Main App measured
three rows (157px) at 768 and 390: the 0.17.1 checks were run empty-handed.
At 768 the stage sits beside the column and the bar is 418px; poses, emote
and Scene take 385 of it, so no hold control fits beside them. The fold
gains three levels: **3** turns the hold buttons into one list, which is
enough at 1024 with larger buttons; **4** moves that list into the Scene
button, under *animate*; **5** moves *rest*, the least used pose, there too,
which the larger buttons need at 768 (20px short at level 4). With empty
hands levels 3 and 4 change nothing.

Measured in headless Chrome on the built package, inset as Hangarworks insets
it, with the package's buttons and with larger ones (7px 12px, 14px):
empty-handed, a pistol in the hand, and a pistol in hand with a rifle on the
back, at 1600, 1280, 1024, 768 and 390 -- one row in every case but one: a
weapon in hand at 390 with the larger buttons is two (85px). Empty-handed at
390 the larger buttons now fit one row, *rest* folded. The list holds and
puts down.

Measured in headless Chrome on the built package, the tool given the whole
window as Hangarworks gives it: one row, 41px, at every width from 390 to
1600. Unfolded at 1440 and above, folded from 1366 down; a 360px stand-in
added to the dock folds it at 1600 and removing it unfolds it again. The
canvas is 576px tall at a 900px window wherever the stage sits beside the
column. Measure it in a pane that is drawing frames: a hidden pane delivers
no `ResizeObserver` notices at all.

