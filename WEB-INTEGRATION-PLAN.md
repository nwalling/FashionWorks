# Integration plan — for the Hangarworks website agent

**Read `WEB-INTEGRATION.md` first.** That file is the contract: the component
API, the tokens, the hosting rules, the budgets. This file is the plan for
carrying it out — what to do, in what order, and which steps have a trap in
them.

Nothing here asks you to understand the FashionWorks pipeline. The whole of it
is behind one React component.

---

## The shape of the work

Seven steps. Steps 1–4 are an afternoon; step 5 is where the real effort is,
because it is the one that has to be done on Windows.

| # | Step | Blocked by |
| --- | --- | --- |
| 0 | Answer four decisions | nothing |
| 1 | Add the dependency | decision 4 |
| 2 | Build the route and the launcher | 1 |
| 3 | Write the copy and the legal notice | 0 |
| 4 | Confirm the theme reaches it | 2 |
| 5 | Verify on Windows, Chrome and Firefox | 2, 3 |
| 6 | Hosting, headers, budget alarm | 2 |
| 7 | Launch gates | all |

---

## Step 0 — Four decisions, before any code

These are §8 of the contract, restated as things to settle rather than
questions to ponder. One of them changes the route file's path, so settle it
first.

1. **Route and name.** `/fashionworks`, `/tools/fashionworks`, something else.
   Our suggestion is `/fashionworks`, because the name is the thing people
   will be told in Discord and a nested path is harder to say out loud.
2. **Placement.** Main nav, or Features only. This decides how much traffic the
   budget in step 6 has to absorb.
3. **Distribution.** Public npm, GitHub Packages, or a git dependency. It is
   MIT and has no private code in it, so public npm is the simplest and is what
   we would default to; say if you would rather it were not public.
4. **`supportHref`.** Where an error state should send someone — `/support`, a
   Discord invite, whatever exists. The component renders the error itself and
   only needs the destination.

A fifth, later: saving loadouts to a Hangarworks account. Not now. It is the
only part of this that would ever need server storage, and everything below is
written on the assumption that nothing does.

**Already answered, so do not re-open:** paid themes reaching this page is
intended and is how it is built (§4.1). The legal review is done and the answer
is go, with conditions — step 3.

---

## Step 1 — The dependency

```
npm i @fashionworks/web
```

Not published to a registry yet; until decision 3 lands, install it from a path:

```
npm i file:../FashionWorks/web/app
```

Peer dependencies are `react >=18` and `react-dom >=18`, and that is all. The
worker and the WebAssembly core ship inside the package as bundler-resolved
assets — you do not copy anything into `public/`.

If the bundler objects to the `.wasm`:

```js
// next.config.js
webpack: (config) => {
  config.experiments = { ...config.experiments, asyncWebAssembly: true };
  return config;
},
```

---

## Step 2 — The route and the launcher

Two files, both in §2.1 of the contract, copy them from there.

The route is a **server component** and stays prerendered and static. The
launcher is a client component that does two things:

```tsx
const FashionWorks = dynamic(
  () => import('@fashionworks/web').then((m) => m.FashionWorks),
  { ssr: false, loading: () => <p>Loading…</p> },
);
```

**`ssr: false` is not optional.** The component touches WebGL, workers and the
File System Access API, none of which exist on the server.

**Gate it behind a click.** A single `useState` that renders a button until the
visitor presses it. This is the whole reason the landing page stays inside 60
KB: someone who bounces downloads the copy and nothing else.

Layout: give it a height. `min-height: 70vh`, or a flex child that grows. **Do
not** put it inside a vertically scrolling container — the 3D view captures
wheel events for camera zoom, and the two fight.

---

## Step 3 — Copy, and the legal notice

The notice is a **condition of the legal go-ahead**, not a nicety. `WEB-LEGAL.md`
in the FashionWorks repo records the review. What it requires:

- The fan-site notice, **verbatim and prominent** — reuse the site's existing
  wording, it already has one.
- A link to the official Star Citizen site.
- **No ads, no paywall, no accounts on this page.** Advertising or a paid tier
  would make this Commercial use, which CIG prohibits outright. That would be a
  new decision, not an extension of this one.

For the surrounding copy, five things visitors get wrong (§6 has the detail):

1. **Say "drag the file onto the page", never "click browse".** Star Citizen
   installs under `C:\Program Files\…` by default and Chromium's File System
   Access blocklist covers `Program Files` and everything under it — so the
   modern file picker **fails on a default install**. Drag-and-drop and the
   classic file input are not blocklisted and work from any path.
2. **Nothing is uploaded.** A 158 GB file opens instantly because only a few
   megabytes are ever read. Visitors will assume the opposite; say so plainly
   and make sure no other copy on the page contradicts it.
3. **Returning visitors may have to re-drop the file.** Only Chromium remembers
   a file handle, and not from `Program Files`. The catalogue and anything
   already viewed stay cached, so this only affects loading *new* pieces.
4. **Desktop only.** Phones and tablets get a clear explanation from the
   component itself; the surrounding copy should not promise otherwise.
5. **Not affiliated with CIG.**

---

## Step 4 — Confirm the theme reaches it

**There is nothing to build here, and that is the point.** There is no theme
prop. FashionWorks reads `--sc-*` off `<html>` and re-reads them when they
change, so `ThemeProvider` is already driving it.

Two things must be true, and both are easy to break by accident:

- **It is rendered in the normal site layout, not an iframe.** A cross-origin
  iframe cannot read the tokens, and would double the page weight.
- **The palette is applied to `document.documentElement`.** That is what
  `ThemeProvider` does today, with `style.setProperty` plus a `data-theme`
  attribute. If it ever moves to `<body>`, or to a stylesheet keyed off the
  attribute, tell us — it is one line here and a silently unthemed 3D viewport
  if it goes unsaid.

To check it: switch theme in the site's own settings and watch the viewport
background, grid and selection outline follow with no reload. Preview mode
works too, because `previewTheme` changes `appliedId` and therefore both the
palette and the attribute.

One warning from our own development page, because it is the kind of thing that
looks like a design choice rather than a bug. A CSS rule written as
`[data-theme="dolomite"] { … }` matches **any** element carrying that
attribute, not just `<html>`. Our theme chips carried it, inherited that
theme's whole palette, and painted themselves in a light theme's text colour on
a dark page — about 1.3:1, which reads as a disabled button. If you have any
per-theme CSS anywhere, scope it to `html[data-theme="…"]`.

If you want to assert this in your own tests, the package exports the contrast
helpers:

```ts
import { checkContrast, readTokens } from '@fashionworks/web';
const failures = checkContrast(readTokens()).filter((r) => !r.passes);
```

They composite translucent tokens over their backing before measuring, which
matters: `--sc-field` is `rgba(255,255,255,0.07)` on the dark themes, and taken
at face value white text on it scores 1.0:1.

---

## Step 5 — Verify on Windows, in Chrome and Firefox

**This is the real work, and it is the one open technical risk in the whole
project.** Everything so far was verified on macOS against a 147.59 GB archive
on an external volume. What has never been run is the combination that every
actual visitor will have: Windows, a default `Program Files` install, and
Firefox.

Test, on a real Windows machine with the game installed:

| check | why it is the one that fails |
| --- | --- |
| Drag `Data.p4k` from `C:\Program Files\Roberts Space Industries\StarCitizen\LIVE\` onto the page | the blocklist; this is the default install path |
| The same in Firefox | no File System Access API at all — the classic input path has to carry it |
| Indexing completes and reports an item count | budget is under 2 minutes; we measure 8.3s on macOS |
| Equip a full set, orbit, switch pose | WebGL2 and memory under a real GPU driver |
| Close the tab, reopen, load a piece not seen before | the cache path, and whether the handle survived |

Report what you find rather than working around it. A failure here changes the
onboarding copy, and possibly the design; it is not a bug to patch in the host.

---

## Step 6 — Hosting, headers, budget

From §5 of the contract, which exists because the site cannot absorb a large
bandwidth bill.

**Must:**
- Keep the route **fully static** — no API routes, no server actions, no ISR.
- **Exclude it from middleware.** Middleware is billed per request and this page
  needs none.
- Leave `_next/static` on its default immutable caching.

**Must not:**
- **Host any game asset**, ever — no meshes, textures, catalogues or extracted
  screenshots. This is a copyright rule as much as a bandwidth one, and the
  whole design exists so that CIG content never touches your server.
- Use `next/image` on this route; it is billed per transform. Plain `<img>` or
  SVG.
- Add analytics beyond what the site already runs.

**CSP**, if the site sets one: this route needs `'wasm-unsafe-eval'` in
`script-src` and `worker-src 'self' blob:`. It does **not** need COOP/COEP —
the design deliberately avoids `SharedArrayBuffer`, because cross-origin
isolation would break reCAPTCHA and other embeds site-wide.

**Budget alarm.** Roughly 8 GB/month at 10,000 visitors with 30% completing
onboarding. Set a Vercel usage alert anyway.

---

## Step 7 — Launch gates

Do not go live until all of these are true:

- [ ] Step 5 passes on Windows in both browsers, or its failures are understood
      and the copy reflects them.
- [ ] The fan-site notice is on the page, verbatim, and visible without
      scrolling to the footer.
- [ ] No ads, no paywall, no account requirement on this route.
- [ ] Zero game assets served from the host — verify by loading the page with
      the network panel open and confirming nothing game-derived comes from
      your domain.
- [ ] The landing page, before "Get started", is inside 60 KB beyond the site's
      already-cached CSS and fonts.
- [ ] Theme switching restyles the 3D view with no reload, in a light theme as
      well as a dark one.
- [ ] A shared loadout URL opens to the same loadout — and the loadout is in the
      **fragment**, never the query string, so it never reaches the server and
      every share is served from one cached HTML document.

---

## What not to do

- **Do not put it in an iframe.** It breaks theming and doubles the weight.
- **Do not add a theme picker** to this page, or pass a theme in. There is no
  prop for it. The account's theme is the theme, and that is what keeps the
  premium entitlement enforced in exactly one place.
- **Do not host game data** to "speed it up". That is the one line the whole
  design is built around.
- **Do not render the component on the landing page** without the click gate.
- **Do not add ads or a paid tier** to this route without a fresh legal
  decision.
