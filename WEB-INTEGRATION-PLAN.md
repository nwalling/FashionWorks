# Integration plan — what is actually left

**Read `WEB-INTEGRATION.md` first.** That file is the contract. This one is the
plan, and it has been rewritten against the real Hangarworks repo rather than
against the contract, because the first version of it described work that was
already finished.

Hangarworks has `/fashionworks` built: the route, the launcher, the click gate,
the copy, the legal notice, a build-gating hosting test and its own
capability pre-flight. Steps 1, 2, 3, 4 and 6 of the old plan are **done**, and
done more carefully than the plan asked for. What follows is only what remains.

---

## 1. The blocker: the package cannot read an archive

**This is ours, not theirs, and everything else waits behind it.**

`@fashionworks/web@0.1.0` — the tarball vendored at
`vendor/fashionworks-web-0.1.0.tgz` — ships no WebAssembly and no worker. Not a
broken one: none.

Verified against the vendored tarball and the source it was built from:

| check | result |
| --- | --- |
| `.wasm` anywhere in the package | **none** |
| `new Worker(` anywhere in `web/app/src/` | **none** |
| `archive.worker` / `fashionworks_core` in `dist/fashionworks.js` | **0 references** |
| how `archive.worker.ts` is reached from `index.ts` | **type-only imports**, which Vite erases |
| `files` in `package.json` | `["dist", "README.md"]` — `dist` is JS, CSS and `.d.ts` |

The worker loads the core from `'../../../core/pkg/fashionworks_core.js'`, a
path **outside the package root** that is gitignored and was never in `files`.

**What a visitor gets.** `FashionWorks.tsx:100` reads:

```ts
// Indexing is the worker's job; this is the seam it plugs into.
emit({ type: 'validated', fingerprint: '' });
```

That moves the state machine to `indexing`. Nothing ever emits `indexed`, so
`ready` is unreachable — and `Viewer` only mounts at `stage === 'ready'`. So
someone who drags their `Data.p4k` onto the page reaches a progress screen that
**never completes**, and `onReady` never fires. It is a dead end with a spinner,
which is worse than a clean error.

Everything that genuinely works — 2,439 wearable pieces, colourway swatches,
equip-a-set, poses, backdrops — lives in `web/app/try.tsx`, a **development
page**, and none of it is in the packaged component.

**The README over-promises twice**, and should be corrected in the same pass: it
says the component lets a visitor browse armour from their own `Data.p4k`, and
it says "`react` and `react-dom` are peer dependencies; nothing else is" when
`three` is a real runtime dependency.

**The work:** move what `try.tsx` does into the component — construct the
worker, ship the wasm as a bundled asset, wire `indexed` and `catalogue` back
into the state machine — then cut a new tarball. Until that lands, `/fashionworks`
cannot do anything a visitor came for, on any platform.

---

## 2. Then: Windows and Firefox, on a default install

The old step 5, still open, and still the one nobody has run. It was described
as the top blocker; it is now the second, because it cannot be tested through a
package that never finishes indexing.

Everything to date was verified on macOS against a 147.59 GB archive on an
external volume. What every actual visitor will have is Windows, a default
`Program Files` install, and possibly Firefox.

| check | why it is the one that fails |
| --- | --- |
| Drag `Data.p4k` from `C:\Program Files\Roberts Space Industries\StarCitizen\LIVE\` | Chromium's File System Access blocklist covers that whole tree |
| The same in Firefox | no File System Access API at all; the classic input has to carry it |
| Indexing completes and reports an item count | budget is 2 minutes; macOS does 8.3 s |
| Equip a full set, orbit, switch pose | WebGL2 and memory under a real GPU driver |
| Reopen the tab and load a piece not seen before | the cache path, and whether the handle survived |

Report what this finds rather than working around it. A failure here changes the
onboarding copy and possibly the design.

The Hangarworks route is already correct about this: it is `robots: noindex`
and off the sitemap, and the page comment says exactly what it waits on.

---

## 3. Small things, none of them blocking

- **`docs/fashionworks-hosting.md` does not exist.** `src/app/fashionworks/page.tsx`
  cites it as "our side of it, including the answers to its section 8". The
  answers are real and are spread across the route's comments; the file they
  point at is not there. Either write it or drop the reference.
- **The contract's layout advice was wrong and has been fixed.** §2.3 said
  `min-height: 70vh`, and the component's root carries `min-height: 100%`, which
  resolves against a parent's *height* and not against its minimum — so the
  panel collapsed to 243 px. Hangarworks diagnosed it and used
  `h-[72vh] min-h-[520px]`, which is right. The contract now says so, with the
  reason.
- **`--sc-accent-text` is consumed by the component now** and is already emitted
  unconditionally by `paletteVars` with the same `accentText ?? accent`
  fallback, so nothing is needed on the Hangarworks side. Listed because the
  contract's token table did not previously mention it.
- **The launcher's comment says the package is "~600 KB".** That is the raw
  size; over the wire it is **110 KB brotli** (plus 644 bytes of CSS). The click
  gate is still right, but the number understates how well the budget is being
  met.

---

## 4. Launch gates

Unchanged, except that the first one is new and dominates:

- [ ] The package can actually open an archive, and a new tarball is vendored.
- [ ] Windows passes in Chrome and Firefox from a default install, or its
      failures are understood and the copy reflects them.
- [ ] `robots: noindex` dropped, route added to `src/app/sitemap.ts`, linked
      from Features. **Do not** disallow it in `robots.ts` instead — a crawler
      that cannot fetch the page never sees the noindex and can still list the
      bare URL. (Their comment already says this; it is repeated because it is
      the kind of thing that gets "tidied".)
- [ ] `scripts/test-fashionworks-hosting.mjs` still passes — it gates the build,
      so this is automatic.
- [ ] `scripts/test-fashionworks-theme.mjs` passes against a running server; it
      needs one on `localhost:3100` and currently cannot run without it.

---

## What Hangarworks got right, and should not be "simplified"

Recorded because a future pass might undo it:

- **The pre-flight check in front of the lazy import.** It answers on a phone or
  a machine with no WebGL2 *without* spending the bundle first. The component
  does its own checks, so this looks redundant and is not.
- **`mount.tsx` as a separate module**, so the package and its stylesheet land
  in the same dynamic chunk. Importing the CSS from the launcher would attach it
  to the landing page for visitors who never press the button.
- **A definite height with no scrolling ancestor**, for the reasons in §3.
- **The fan-site notice above the tool rather than in the footer**, which is a
  condition of the legal go-ahead and not a styling choice.
- **`test-fashionworks-hosting.mjs` gating the build.** It asserts contract §4
  and §5 against their own repo and has already caught two real token defects
  that were invisible on the site.
