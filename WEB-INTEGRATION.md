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
Give it a height — `min-height: 70vh` or a flex child that grows. **Do not**
place it inside a container that scrolls vertically; the 3D view captures wheel
events for camera zoom.

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

Tokens consumed (all already defined on the live site):

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
2. If a token is ever renamed, tell us; the component maps names in one place.
3. Tabler Icons is assumed available (the site already loads it). The component
   ships no icon font of its own.

It is tested against `hangarworks`, `dolomite`, `keystone` and `navy`, at
WCAG AA contrast, with keyboard navigation and `prefers-reduced-motion`.

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
  browser. Compiles clean to `wasm32-unknown-unknown`: **0.50 MB raw,
  0.10 MB brotli**.
- `web/patches/0001-starbreaker-p4k-browser-support.patch` — 20 lines against
  the vendored StarBreaker checkout: gates the filesystem-only API away from
  wasm, and exposes `P4kArchive::entries_from_reader`, which already existed
  internally. Additive and MIT; it should go upstream rather than live as a
  fork. `tools/build.sh` must apply it after `clone_or_update`.

Not built yet: DataCore/catalogue port, geometry, the GPU material shader,
onboarding UI, and the `@fashionworks/web` package itself. `WEB.md` has the
phase plan and exit criteria. **The API in §3 is a contract to code against,
not a description of shipped code.**

Nothing in §2's snippets will run until the package is published.

---

## 8. Decisions needed from Hangarworks

1. **Route and name.** `/fashionworks`, `/tools/fashionworks`, or something
   else? Is it called FashionWorks on the site?
2. **Placement.** Main nav, or linked from Features only?
3. **Paid themes.** The component follows `data-theme` automatically, so owners
   of paid themes get them here too. Intended?
4. **Distribution.** Public npm, GitHub Packages, or a git dependency?
5. **Later:** save loadouts to a Hangarworks account? That is a few kilobytes of
   JSON per loadout and the only thing that would ever need server storage.
