# Local viewer

The local React viewer under viewer/: binding, the base body, the GLB cache, undo history and downloads.

### Binding must put meshes back where it found them

Equipping a torso made the backpack disappear, permanently. Binding
reparents meshes out of the cloned GLTF scene and under the base character,
and `detach` only removed them, leaving the clone empty. The next bind
traversed that clone, found no meshes and attached nothing -- silently. It hit
socket pieces because their bind effect re-runs whenever the torso changes the
mount offset. `binding.rememberOrigin`/`restoreOrigin` record each mesh's
parent and local matrix at bind time and put it back on detach.

The same fault was latent for skinned pieces; their effect just did not re-run,
because only `offsetKey` was changing.

### Undersuits and the base body

The base GLB ships a default undersuit, so there is a body to look at and a
skinned mesh for the viewer to read the skeleton from. Equipping another
undersuit would stack two layers, so `BaseCharacter` hides the built-in body
when an undersuit covers it (the coverage test is in "The base body" below).
It captures the body meshes once at mount, because
armor pieces are reparented under the same root when they bind and re-traversing
would hide the armor too.

### The base body

The base GLB is built by `build_base_rig.py`, which for a long time never ran
the material pipeline, so the body kept Blender's placeholder materials and
rendered as a flat white mannequin under the armor. `scx rig --undersuit-item`
now passes real material descriptors, the same ones armor gets.

**Hiding the base body needs a coverage test, not the slot name.** Several
records in the undersuit slot are partial: a torso wrap, a necksock. Hiding the
whole body for those leaves a legless torso. Height alone does not separate
them either, since a waist-up piece measured 1.20 against a 1.64 body, or 73%.
What separates them is whether the piece reaches the feet: measured on real
items, full suits start at y=0.00 while a torso wrap starts at y=0.65. The
viewer hides the base only for a piece that reaches both the feet and the chest.

### The GLB cache needs a byte budget (2026-09-14)

Swapping really is free *on repeat*, exactly as the 2026-09-13 note says. What
that note could not see, because it was measured on 30 synthetic placeholders
with trivial geometry and no textures, is that the cache never releases
anything. On real assets the first sight of an item costs **13.6 MB and keeps
it**.

Measured by equipping 12 different helmets, one slot, one visible mesh at a
time:

| swaps | geometries | textures | JS heap |
| --- | --- | --- | --- |
| 0 | 13 | 9 | 56 MB |
| 6 | 19 | 26 | 116 MB |
| 12 | 25 | 44 | 220 MB |

Linear, never plateauing. At that moment the scene held **2 meshes, 1 skeleton,
3 draw calls** -- so 23 of those 25 geometries belonged to helmets that were no
longer in the scene at all. The binding is not what grows; the cache is.

The catalog has **471 distinct GLBs** (helmet 138, torso 91, arms 83, legs 81,
undersuit 47, backpack 31), averaging 7.3 MB on disk and about 1.8x that
resident once decoded. Browsing all of them wants ~6.4 GB against a 4.19 GB tab
limit, so the tab dies around **304 distinct items, roughly two thirds of the
way through**.

`viewer/src/three/gltfCache.ts` puts a ceiling on it: a byte budget over the
`useGLTF` cache, evicting least-recently-used GLBs. Default **768 MB**, about 25
items. With it, 30 swaps hold flat at 25 entries, 741-766 MB, 38 geometries and
77 textures, and repeat swaps stay instant.

Two things make eviction safe, and both are load-bearing:

* **Equipped pieces are pinned.** `ArmorPiece` reparents *clones* that share
  geometry, materials and textures with the cached original, so a piece on
  screen still owns its cache entry. A full loadout reports `pinned: 6`.
* **The `retain` effect is declared last in `ArmorPiece`.** React runs cleanups
  in declaration order, so release happens *after* the bind effect's `detach`
  and after the tint effect restores the shared materials. Declared earlier, it
  would dispose geometry still parented into the scene.

`useGLTF.clear()` only drops the suspense entry and frees no GPU memory, so the
module disposes textures, materials and geometries itself before clearing.
Size is measured from the decoded buffers, not the file, because that is what
stays resident. `window.__gltfCache` exposes `stats()` and `setBudget()` in dev.

### One colour drag was 40 undo steps (2026-09-14)

`setTint` ran through `withHistory` on every `onChange`, and a colour picker
fires those continuously while dragged. One gesture produced **40 history
entries** against a `HISTORY_LIMIT` of 50: the whole undo stack gone, and 40
undos needed to reverse one drag.

The store never sees a `pointerup`, so the gesture boundary is inferred from the
gap between events (`TINT_COALESCE_MS`, 600 ms). Coalescing on the item key
alone was not enough -- every drag of one swatch for the rest of the session
folded into a single undo step, which is worse than the bug. Now 75 tint events
across three gestures produce three entries.

### Object URLs cannot be revoked on the next line (2026-09-14)

`exporters.download` revoked the blob URL immediately after `anchor.click()`.
`click()` only queues the navigation; the browser takes its reference after the
event is dispatched, so the URL could be gone before the download started. The
combined GLB is the one that loses that race -- a six-piece loadout exports at
**43.3 MB**. Revocation is deferred by `OBJECT_URL_TTL_MS` (60 s), and the
anchor is appended to the document first, because Firefox ignores `click()` on a
detached anchor.
