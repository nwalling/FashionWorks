# FashionWorks → Hangarworks: integration contract

Everything the Hangarworks site needs in order to host the FashionWorks armour
kitbasher as a sub-page. Written to be handed to the agent that builds the
Hangarworks site; it assumes no knowledge of this repo.

Architecture and reasoning live in `WEB.md`. This file is only the boundary.

---

## 1. The shape of it, in one paragraph

FashionWorks is a **client-only** React component. The visitor points it at
their own `Data.p4k` (the Star Citizen game archive, ~158 GB on their disk) and
everything — reading the archive, extracting armour, compositing textures,
rendering — happens in their browser, in web workers. **The site serves no game
data, runs no server code for this page, and stores nothing.** Hangarworks
provides a route, the page frame, and its theme; FashionWorks provides the rest.

---

## 2. What Hangarworks builds

### 2.1 One route

Suggested `app/fashionworks/page.tsx` (final URL is an open question, §8).

```tsx
// Server component. Prerendered, static, ~no bytes beyond the site's usual CSS.
import { FashionWorksLauncher } from './launcher';

export const metadata = {
  title: 'FashionWorks — armour kitbasher for Star Citizen',
  description:
    'Browse and combine Star Citizen FPS armour. Runs entirely in your browser, using your own game files.',
};

export default function Page() {
  return (
    <main>
      {/* Your copy, your components. Keep this section light — it is all a
          bouncing visitor downloads. */}
      <h1>FashionWorks</h1>
      <p>
        Browse and combine Star Citizen armour sets. It runs entirely on your
        PC and reads your own game files — nothing is uploaded.
      </p>
      <FashionWorksLauncher />
    </main>
  );
}
```

```tsx
// app/fashionworks/launcher.tsx
'use client';
import { useState } from 'react';
import dynamic from 'next/dynamic';

// ssr:false is required — the component touches WebGL, workers and the file
// system access APIs, none of which exist on the server. It also keeps the
// heavy bundle out of the initial page.
const FashionWorks = dynamic(
  () => import('@fashionworks/web').then((m) => m.FashionWorks),
  { ssr: false, loading: () => <p>Loading…</p> },
);

export function FashionWorksLauncher() {
  const [started, setStarted] = useState(false);
  if (!started) {
    return (
      <button className="<your primary button class>" onClick={() => setStarted(true)}>
        Get started
      </button>
    );
  }
  return (
    <FashionWorks
      className="<your full-bleed panel class>"
      supportHref="/support"
      onLoadoutChange={(hash) => history.replaceState(null, '', `#${hash}`)}
      initialLoadout={typeof location !== 'undefined' ? location.hash.slice(1) : undefined}
    />
  );
}
```

**Do not render the component until the visitor asks for it.** That single
`useState` gate is what keeps the landing page inside its 60 KB budget.

### 2.2 The dependency

```
npm i @fashionworks/web
```

Not yet published — see §7 for status. It is MIT, ships its own worker and
WebAssembly as bundler-resolved assets, and has exactly one peer dependency:

```json
"peerDependencies": { "react": ">=18", "react-dom": ">=18" }
```

If the bundler objects to the `.wasm` asset, add to `next.config.js`:

```js
webpack: (config) => {
  config.experiments = { ...config.experiments, asyncWebAssembly: true };
  return config;
},
```

### 2.3 Layout requirements

The component fills its container and manages its own internal scrolling.

**Give the parent a definite height, not a minimum.** The component's root
carries `min-height: 100%` inline, and a percentage minimum resolves against a
parent that has a *height* — against a parent that only has a `min-height` it
resolves to nothing, so the root collapses to its content. Use
`height: 72vh; min-height: 520px`, or a flex child with a resolved basis.

> An earlier version of this section said "`min-height: 70vh` or a flex child
> that grows", which is wrong and cost the Hangarworks side real debugging: the
> panel collapsed to 243 px of welcome screen with a 3D viewport still to come.
> Corrected here rather than left as folklore.

**Do not** place it inside a container that scrolls vertically; the 3D view
captures wheel events for camera zoom, and a scrolling ancestor fights it for
every turn.

---

## 3. The component API

```ts
export interface FashionWorksProps {
  /** Applied to the root element. Use it to hand down your panel styling. */
  className?: string;

  /** Linked from error states, e.g. "/support" or your Discord invite. */
  supportHref?: string;

  /** Loadout to restore, from the URL fragment. Opaque string. */
  initialLoadout?: string;

  /** Fires when the loadout changes, debounced. Write it to the fragment. */
  onLoadoutChange?: (encoded: string) => void;

  /** Fires once the visitor has a working catalogue. Safe to log. */
  onReady?: (info: { itemCount: number; buildFingerprint: string }) => void;

  /** Fatal errors. Never contains file paths or anything identifying. */
  onError?: (error: { code: FashionWorksErrorCode; message: string }) => void;
}

export type FashionWorksErrorCode =
  | 'unsupported-browser'   // no WebAssembly, or not a desktop browser
  | 'no-webgl2'             // GPU or driver cannot run the renderer
  | 'not-a-p4k'             // the chosen file is not a Star Citizen archive
  | 'archive-unreadable'    // truncated, mid-download, or permission lost
  | 'unsupported-build'     // game build newer/older than this release handles
  | 'storage-denied'        // no room, or the visitor blocked storage
  | 'out-of-memory';        // usually a 32-bit browser or a tiny machine
```

The component renders **all** of its own states: capability checks, the file
picker, indexing progress, every error above, and the kitbasher itself. The
host is never asked to render a spinner or an error page.

**Use the loadout string as an opaque token.** Put it in the URL *fragment*,
never the query string — a fragment never reaches the server, so every shared
loadout is served from the same cached HTML.

---

## 4. Theming: it inherits, it does not define

The component hardcodes **no colours, fonts or radii**. It reads the site's own
custom properties at runtime, including inside the 3D view (canvas background,
grid, selection outline, shadow tint), and re-reads them when `data-theme`
changes on `<html>`. Switching theme restyles it live, with no reload.

### 4.1 The theme is the account's, and FashionWorks never asks

**There is no theme prop and no theme picker in this component, by design.**
`FashionWorksProps` has no `theme` field and never will. The visitor's theme is
whatever `ThemeProvider` has already put on `<html>`, which on a signed-in
session is the theme saved against their account together with the premium
themes they own — `syncFromProfile(themeId, ownedIds)` applies both in one
update. FashionWorks reads the resulting tokens and follows.

This matters beyond tidiness, because **the premium tier is an entitlement**.
A picker inside FashionWorks would be a second path to applying a theme, one
that does not know what the account owns, and `canUse` would not be guarding
it. Reading tokens off `<html>` means there is exactly one place a theme
becomes visible, `ThemeProvider`'s pre-paint layout effect, and one place the
entitlement is enforced. A visitor who does not own Lovestruck cannot reach it
through FashionWorks, because FashionWorks has no way to apply a theme at all.

Two consequences for the Hangarworks side:

* **The preview path works for free.** `previewTheme` sets `appliedId` without
  persisting, and the palette and `data-theme` both change, so a theme being
  previewed in the settings drawer restyles the 3D view live along with
  everything else.
* **Tokens arrive as inline style on `<html>`**, written with
  `root.style.setProperty`, not as a stylesheet keyed off `data-theme`. The
  component's `watchTheme` observes `data-theme`, `class` *and* `style` for
  that reason. If the provider ever moves to a stylesheet, or applies the
  palette to `<body>` rather than `<html>`, tell us — it is a one-line change
  here and a silently unthemed viewport if it goes unmentioned.

The `try.html` development page does have theme buttons. They are a stand-in
for an account that page does not have, and they render the two premium themes
as locked rather than hiding them, because that is what a signed-out visitor
sees. Nothing in `src/` has an equivalent.

### 4.2 Tokens consumed

All already defined on the live site:

| token | used for |
| --- | --- |
| `--sc-dark` | page and 3D viewport background |
| `--sc-card`, `--sc-surface`, `--sc-surface-2`, `--sc-field` | panels, item rows, inputs |
| `--sc-border`, `--sc-border-bright` | dividers, focus rings |
| `--sc-text`, `--sc-subtle` | body and secondary text |
| `--sc-accent`, `--sc-accent-soft`, `--sc-accent-line`, `--sc-accent-ink` | selection, primary actions |
| `--sc-badge` | informational chips |
| `--sc-shadow` | panel elevation |
| `--font-display` | headings |

**Nothing new is required from Hangarworks.** Requirements on your side:

1. Render the component inside the normal site layout, so it inherits
   `<html data-theme>` — **not** in an iframe. A cross-origin iframe cannot read
   these tokens and would double the page weight.
2. If a token is ever renamed **or its resolved value corrected**, tell us. The
   component maps names in one place, but a value change is the more dangerous
   of the two: it fails silently, looking like a design choice rather than a
   bug. Corrections so far:
   - **2026-09-20** — `--sc-surface-2` and `--sc-shadow` were fixed on the
     Hangarworks side. Before that, `--sc-surface-2` resolved to the default
     theme's teal and `--sc-shadow` to the dark-theme shadow on *every* theme.
     Nothing here was written against the old values: no component exists yet
     (§7), so the fix lands before the first line that reads them.
3. Tabler Icons is assumed available (the site already loads it). The component
   ships no icon font of its own.

It is tested against **all seven** registered themes — `hangarworks`, `dark`,
`navy`, `dolomite`, `nightrunner`, `lovestruck` and `keystone` — at WCAG AA
contrast, with keyboard navigation and `prefers-reduced-motion`. Three of the
seven are light, so a light theme is the common case here rather than the edge
case, and two details of the real registry shape the checks:

* **`--sc-accent-text` is a separate colour from `--sc-accent`.** Dolomite's
  fill orange reads 2.65:1 as type on its page, which is why the site ships
  both. Holding the *fill* to a type threshold reports a failure the site has
  already solved; darkening the one accent to fix the type turns the buttons
  brown. The checks use `--sc-accent-text` for type and `--sc-accent-ink` on
  `--sc-accent` for fills.
* **Several tokens are translucent.** `--sc-field` is
  `rgba(255, 255, 255, 0.07)` on the dark themes. Taken at face value that is
  white, and white text on it "fails" at 1.0:1; composited over the card it is
  a lifted navy and passes. The checks composite first.

---

## 5. Hosting rules — the ones that protect the bandwidth bill

The FAQ says Hangarworks cannot absorb a large hosting bill, so these are hard
constraints, not preferences.

**Must:**
- Keep the route **fully static**. No API routes, no server actions, no ISR.
- **Exclude the route from middleware** — middleware invocations are billed per
  request, and this page needs none.
- Let `_next/static` keep its default immutable caching (already the case).

**Must not:**
- **Host any game asset.** No meshes, textures, catalogues or screenshots
  extracted from the game, ever. This is a bandwidth *and* a copyright rule —
  the tool is built so CIG content never touches your server.
- Use `next/image` optimisation on this route (billed per transform). Plain
  `<img>` or SVG only.
- Add analytics beyond what the site already runs.

**Budget** (enforced by CI on our side, listed so you can verify):

| item | budget |
| --- | --- |
| landing page, beyond already-cached site CSS/fonts | ≤ 60 KB |
| app JavaScript, loaded only after "Get started" | ≤ 400 KB brotli |
| WebAssembly core | ≤ 2 MB brotli (archive layer measures 0.10 MB today) |
| first full session | ≤ 2.5 MB |
| return visit | ≈ 0 (immutable assets + service worker) |
| game data from your server | **0 bytes** |

Rough scale: 10,000 visitors a month with 30% completing onboarding is about
**8 GB/month**. Worth setting a Vercel usage alert regardless.

**Content Security Policy.** If the site sets one, this route needs
`'wasm-unsafe-eval'` in `script-src`, plus `worker-src 'self' blob:`. It does
**not** need `COOP`/`COEP` — the design deliberately avoids `SharedArrayBuffer`,
because cross-origin isolation would break reCAPTCHA and other embeds site-wide.

---

## 6. Things to know when writing the surrounding copy

These shape the FAQ and support answers, so they matter to the site, not just
to us.

1. **Star Citizen installs to `C:\Program Files\Roberts Space Industries\StarCitizen\LIVE\`
   by default, and Chrome refuses to open files there.** Chromium's File System
   Access blocklist covers `Program Files` and all its children (verified in
   `chrome_file_system_access_permission_context.cc`). So the modern file picker
   **fails on a default install**. The component therefore leads with
   drag-and-drop and a classic file input, which are not subject to that
   blocklist and work from any path. Support answers should say "drag the file
   onto the page", not "click browse".
2. **Nothing is uploaded, and a 158 GB file opens instantly.** Visitors will
   assume otherwise. The component says so up front; the surrounding copy should
   agree rather than contradict it.
3. **Returning visitors may have to re-drop the file.** Only Chromium can
   remember a file handle, and only outside `Program Files`. The catalogue and
   anything already viewed are cached, so this only affects loading *new* pieces.
4. **Desktop only.** Phones and tablets get a clear explanation, not a broken
   page.
5. **Not affiliated with CIG.** Reuse the site's existing wording.

---

## 7. Status — what exists today

Built and verified in this repo:

- `web/core/` — the Rust WebAssembly core. Reads a P4K archive over byte ranges
  instead of a file handle, which is what makes a 158 GB file usable in a
  browser; also parses the DataCore and decodes split DDS textures.
  **0.07 MB brotli.**
- `web/spike/` — Phase 0 feasibility, **run against the real 147.59 GB archive**
  rather than against a compiler: 1,365,842 entries indexed in 8.3s from two
  range reads (0.29% of the file), `Game2.dcb` parsed to 116,921 records in
  0.1s, a 2048² texture decoded in 383ms, peak RSS 1.45 GB. A file extracted
  through the core is byte-identical to the native StarBreaker CLI's output.
  The browser page, worker and wasm all run; **Windows, Firefox and
  Program Files drag-and-drop are still untested** and remain the open risk.
- `web/patches/0001-starbreaker-p4k-browser-support.patch` — 20 lines against
  the vendored StarBreaker checkout: gates the filesystem-only API away from
  wasm, and exposes `P4kArchive::entries_from_reader`, which already existed
  internally. Additive and MIT; it should go upstream rather than live as a
  fork. `tools/build.sh` must apply it after `clone_or_update`.

- `web/app/` — the `@fashionworks/web` package: the `<FashionWorks />`
  component, ES and CJS with types. **110 KB brotli** against the 400 KB
  budget, plus 644 bytes of stylesheet. Onboarding, capability checks, archive
  validation, error states and the themed 3D viewport.
- `web/app/try.html` — a development page that exercises the **whole** pipeline
  against a real archive: 2,439 wearable pieces across six slots, colourways as
  swatches, equip-a-whole-set, poses, worn-versus-factory surfaces and a
  visitor-supplied backdrop.

**The gap between those two lines is the current state of the project, and an
earlier version of this section papered over it.** The pipeline works; the
*package* does not carry it. `@fashionworks/web@0.1.0` ships no WebAssembly and
no worker — `archive.worker.ts` is reached from `index.ts` only through
type-only imports, which the bundler erases, and the built `dist/fashionworks.js`
contains zero references to either. So the component validates a dropped
`Data.p4k`, moves to `indexing`, and stops there forever, because nothing emits
`indexed` and `stage === 'ready'` is unreachable.

**What this means for §3:** the API surface is implemented and stable. The
behaviour behind it is not, for the archive path. `WEB-INTEGRATION-PLAN.md` §1
has the detail and is the thing to read before building against this.

Phases 0 through 5 of `WEB.md` are closed against their stated exit criteria —
which were about theming, bundle size and the mechanism, and did not include
"the packaged component opens an archive". That is Phase 6 work, alongside the
female skeleton and the Windows/Firefox half of the Phase 0 spike.

The package is not published to a registry yet, so §2's snippets need a local
install (`npm i file:../FashionWorks/web/app`) until it is. That is a release
step, not a build one.

---

## 8. Decisions needed from Hangarworks

1. **Route and name.** `/fashionworks`, `/tools/fashionworks`, or something
   else? Is it called FashionWorks on the site?
2. **Placement.** Main nav, or linked from Features only?
3. ~~**Paid themes.** The component follows `data-theme` automatically, so
   owners of paid themes get them here too. Intended?~~ **Answered: yes, and
   it is the design.** The theme is the account's, resolved by `ThemeProvider`
   on sign-in; FashionWorks has no theme prop and no picker, so an account that
   owns Lovestruck sees Lovestruck here and one that does not cannot reach it
   through this page at all. §4.1 has the reasoning.
4. **Distribution.** Public npm, GitHub Packages, or a git dependency?
5. **Later:** save loadouts to a Hangarworks account? That is a few kilobytes of
   JSON per loadout and the only thing that would ever need server storage.
