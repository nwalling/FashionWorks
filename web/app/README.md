# `@fashionworks/web`

A React component that lets a visitor browse and combine Star Citizen FPS
armour **from their own `Data.p4k`**, entirely in their browser.

The host serves no game data, runs no server code for this page, and stores
nothing. `WEB-INTEGRATION.md` at the repository root is the contract this
implements and the file to read first if you are building the Hangarworks side.

```tsx
'use client';
import { FashionWorks } from '@fashionworks/web';
import '@fashionworks/web/style.css';

export function Launcher() {
  return <FashionWorks className="my-panel" supportHref="/support" />;
}
```

`react` and `react-dom` are peer dependencies; nothing else is. Give the
component a height — it fills its container and manages its own scrolling.

## Theming

It owns **no colours**. Every one comes from the host's `--sc-*` custom
properties, so a theme switch restyles it with no code and no reload.

CSS gets that for free. The 3D view does not: a WebGL scene's background, grid
and outlines are numbers held by a renderer, and nothing re-reads them when
`data-theme` changes. So the tokens are read through `getComputedStyle` and
re-read when a `MutationObserver` sees the attribute change.

Two things that has to survive, both of which are the normal case on the live
site rather than edge cases:

- **A token may be a `color-mix()` or a `var()` chain.** `--sc-surface` is
  `color-mix(in srgb, var(--sc-card), var(--sc-text) 7%)`, and
  `getComputedStyle` returns custom properties *unresolved*. Resolving one needs
  the browser: assign it to a real colour property on a probe element and read
  that back.
- **A theme may define only some tokens.** `dolomite` overrides four and
  inherits the rest, so anything missing falls back to the base value rather
  than to black — which would render an invisible scene.

Measured across four themes, switching with no reload, reading the canvas back:

| theme | `--sc-dark` | canvas pixel | AA failures |
| --- | --- | --- | --- |
| hangarworks | rgb(10, 18, 25) | 10, 18, 25 | none |
| dolomite (light) | rgb(244, 246, 248) | 244, 246, 248 | none |
| keystone | rgb(23, 19, 15) | 23, 19, 15 | none |
| navy | rgb(7, 13, 28) | 7, 13, 28 | none |

**Only `hangarworks` is the site's real palette.** It is public in full;
`dolomite` exposes four tokens (enough to know it is light-leaning) and
`keystone` and `navy` are names only. The other three above are representative
stand-ins, so what this demonstrates is the *mechanism* across dark, light and
tinted themes. `checkContrast` is exported so the host can re-run it against the
real values.

## Accessibility

- WCAG AA on every pairing the component draws: 4.5:1 for body text, 3:1 for
  large text and the accent.
- Keyboard focus is always visible, using the accent and falling back to the
  text colour — which a theme guarantees is readable against its own background.
- `prefers-reduced-motion` is respected.

## Checks

```bash
npm run check      # typecheck, stylelint (no hex allowed), unit tests
npm run build      # the library
npm run verify     # the dev server, for the browser-only checks
```

The browser-only pages, which need a real GPU and a real archive:

| page | what it proves |
| --- | --- |
| `/try.html` | **all of it, to poke at**: a loadout, orbit, poses, wear, themes |
| `/theme.html` | a theme switch restyles the page *and* the canvas, and AA passes |
| `/verify.html` | OPFS eviction, storage quotas, capability detection |
| `/demo.html` | every onboarding screen, including the failure ones |
| `/archive.html` | index and catalogue a real `Data.p4k` |
| `/render.html` | armour on screen: mesh, armature, materials, socket, pose |

`/archive.html` and `/render.html` need an archive:

```bash
FW_ARCHIVE="/path/to/Data.p4k" npm run verify
```

That serves the file over HTTP byte ranges for the dev server only. The
production path is `FileReaderSync` over a `File` the visitor drops, and no game
data ever reaches a server.

## Bundle

107 KB brotli against the 400 KB budget in `WEB.md`, plus a 2 KB stylesheet.
The WebAssembly core is a separate asset, 0.20 MB brotli against 2 MB.
