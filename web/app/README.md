# `@fashionworks/web`

Phase 4: getting a visitor from a landing page to a catalogue, and keeping what
was built so the second visit is instant.

| file | what it is |
| --- | --- |
| `src/capabilities.ts` | what the browser can do, split into blocking and warning |
| `src/archive/validate.ts` | is this file a usable `Data.p4k`, and what to say when it is not |
| `src/storage/db.ts` | IndexedDB: the catalogue, settings, a file handle |
| `src/storage/cache.ts` | the OPFS piece cache, under a byte budget |
| `src/onboarding.ts` | the flow, as a pure state machine |
| `src/ui/Onboarding.tsx` | that state machine, rendered |
| `demo.tsx` | every screen side by side, and the live flow |
| `verify.ts` | the half a headless test cannot reach |

```bash
npm --prefix web/app test        # 37 tests
npm --prefix web/app run verify  # then open /verify.html and /demo.html
```

## Why the flow is a state machine

The exit criterion is *"a first-time tester on a default install gets from
landing to a rendered set without help"*, and what decides that is not the
visuals. It is whether every way the flow can go wrong has somewhere to go.

So the failures are states, and the machine is pure — events in, state out, no
fetching, no IndexedDB, no workers. Every error path is then reachable in a test
instead of being discovered by a visitor. `demo.html` puts all fifteen screens
on one page for the same reason: the failure screens are rare by definition,
which makes them the ones that ship broken.

## Three things the platform dictates

**Drag-and-drop is the primary path, not a nicety.** Chromium's blocklist
refuses every File System Access picker under Program Files
(`DIR_PROGRAM_FILES` with `kBlockAllChildren`), which is exactly where Star
Citizen installs. `showOpenFilePicker()` therefore *fails on the default
install*. Drag-and-drop and a plain `<input type="file">` are not subject to
that list. The same fact makes "drop it again" the normal return visit for most
people, so it is worded as normal rather than as a failure.

**Say it does not upload, before asking for the file.** A visitor asked to hand
over a 158 GB file will assume an upload and stop. `File.slice()` reads ranges
on demand; the promise is on the landing page and again under the drop zone.

**The fingerprint is the entry index, not the timestamp.** WEB.md suggested size
plus `lastModified` plus a hash of the central directory. `lastModified` is a
property of the *copy*: moving the archive, restoring a backup or a launcher
touching the file would each throw the catalogue away and force a needless
re-index. Size and the entry list are properties of the build. It is computed in
Rust from the index already in memory, so it costs no extra read.

## The bug the browser found and the tests could not

`vitest` covers the flow, the validation and IndexedDB, because all three are
pure or have a faithful fake. OPFS has neither, and the behaviours that matter —
whether eviction really deletes files, whether a cleared directory handle still
works — are the ones a fake gets wrong by construction.

So `verify.ts` runs in a real browser, and on its first run it failed: **the
cache index did not survive a reopen.**

The cause was a race. `get()` touches an entry's timestamp and fired an
*unawaited* index write on every read. `createWritable` truncates and commits on
`close`, so one of those writes landing across `loadIndex`'s read leaves a
half-written file; `JSON.parse` throws; and `loadIndex` responds to an
unreadable index by **clearing the cache**, because it cannot budget entries
whose sizes it does not know.

That is destructive out of all proportion to its cause — a visitor clicking
through pieces quickly could lose everything they had cached. Index writes are
now serialised through one promise chain, touch-on-read is debounced into a
single write, and `flush()` exists for callers that need the index on disk
before reopening.

A second, quieter one came from the same page: `clear()` removed the pieces
directory without replacing the handle, so every later write threw into its own
`catch` and silently cached nothing. A cache that works until the visitor
presses "Clear cache" once, and never again until they reload.

## What is not done

The index step is **stubbed**. Everything before it is real — the capability
check, the drop, validation, the failure screens, the caches — but the worker
that drives the WebAssembly core through indexing, catalogue, geometry and
materials is not wired up yet. Until it is, the flow cannot actually reach a
rendered set, so the exit criterion is not met however well the onboarding
behaves.

That assembly is the next piece of work, and it is what WEB.md's Phase 2 note
meant by *"what remains for a renderable result is assembly rather than format
work."*
