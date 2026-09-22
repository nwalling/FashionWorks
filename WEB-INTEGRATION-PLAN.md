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

## 1. ~~The blocker~~ — fixed in 0.2.0

`@fashionworks/web@0.1.0` shipped **no WebAssembly and no worker**. The worker
was reachable from `index.ts` only through type-only imports, which the bundler
erases, so a dropped `Data.p4k` validated, moved to `indexing`, and stayed
there forever: a spinner with nothing behind it.

**0.2.0 carries the pipeline.** Measured from the built package against the
real 147.59 GB archive:

| | |
| --- | --- |
| entries indexed | 1,365,842 |
| catalogue | 2,475 items, 2,439 wearable |
| app JavaScript | 122 KB brotli (budget 400) |
| core, separate asset | 203 KB brotli (budget 2048) |

Three things had to be true at once, and each failed differently before it was:

* **The worker is inlined** (`?worker&inline`), so no consumer bundler has to
  resolve a worker URL out of `node_modules`.
* **The wasm-bindgen glue is a static import.** As a dynamic one, Rollup split
  it into its own chunk and the blob worker tried to
  `import('./fashionworks_core-<hash>.js')` against a blob URL, which is
  nothing.
* **Every URL crossing into the worker is absolute.** This is the one that
  would have shipped: webpack rewrites the core's asset reference to a
  *root-relative* path, and a blob URL has an opaque path, so `fetch` rejects
  with "Failed to parse URL" before a byte is requested. Under Vite the URL is
  already absolute, so no amount of local verification would have shown it —
  it took a real Next production build.

**Verified in a Next 15 production build**, not only under Vite: webpack emits
the core to `static/media/fashionworks_core_bg.<hash>.wasm`, and a blob module
worker fetches and compiles it (657,794 bytes, 31 exports).

`npm run build` is now gated on `scripts/check-package.mjs` — twelve assertions
about the built artefact, including both budgets and the absolutisation above.

**And `ready` is the kitbasher now, not a bare viewport.** The listing,
colourway swatches, equip-a-set, poses, worn-versus-factory and the backdrop
were ported out of `try.tsx` into the component (`src/three/kitbasher.ts` is
the orchestration, `src/ui/Kitbasher.tsx` the shell), and `initialLoadout` /
`onLoadoutChange` are implemented: the ids of what is worn, comma-separated,
which is what goes in the fragment. Verified from `dist/` in
`web/app/kitbasher.html`: equip-set filled helmet, arms and legs with the
Sunchaser colourways, and a theme switch to Dolomite drove the WebGL clear
colour to the page white along with the DOM.

**For Hangarworks:** vendor the new tarball and the route works unchanged. No
code change on your side; §2.3's layout advice was the only thing that was
wrong, and you had already worked around it.

---

## 2. Then: Windows and Firefox, on a default install

The old step 5, still open, and still the one nobody has run. It was described
as the top blocker; with the package fixed it is now the first, and the only
thing between this and going public.

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
  size; over the wire 0.2.0 is **122 KB brotli** (plus 644 bytes of CSS), with
  the 203 KB core fetched separately and only once the visitor drops an
  archive. The click gate is still right, but the number understates how well
  the budget is being met.

---

## 4. Launch gates

Unchanged, except that the first one is new and dominates:

- [x] The package can actually open an archive — 0.2.0, measured against the
      real archive and inside a Next production build.
- [ ] The 0.2.0 tarball is vendored into the Hangarworks repo.
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
