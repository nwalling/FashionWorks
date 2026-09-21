# The LayerBlend shader

`tint.compose_layered` bakes armour surfaces on the CPU into 1024² albedo and
ORM PNGs: about half an hour for the catalogue and a 21 GB cache. In the browser
there is nowhere to put 21 GB and no time to spend half an hour, so the same
rules run per pixel instead.

That is not only cheaper. The palette becomes a **uniform**, so changing
colourway is a uniform update rather than a re-bake, and the user's own tint is
live.

| file | what it is |
| --- | --- |
| `layerblend.js` | the GLSL, the blend table, and the uniform packing |
| `bake.js` | WebGL2 plumbing: texture arrays, the MRT target, read-back |
| `check.html` | scores the shader against the Python's baked PNGs |
| `serve.mjs` | a static server rooted at the repo, for the check |

## What the shader implements

Every rule in `CLAUDE.md`'s LayerBlend sections, and each one is cited at the
line that implements it:

- the **blend table**, settled on the fourth attempt, with three refuted
  readings recorded so nobody tries them again
- **`PaletteTint`** as an absolute index, 1/2/3 to entry A/B/C, never a rank
- **a metal takes the palette entry's specular**, a dielectric its colour — the
  rule that made ten Lynx colourways stop rendering as the same grey arm
- the palette **modulates** a layer's own `TintColor`, it does not replace it
- **metal texture normalisation**: a metal's TexSlot1 is surface pattern, not
  albedo, so it modulates around 1.0 instead of scaling reflectance down by its
  own mean
- **wear pairs**, blended within a layer before the mask picks between layers,
  dark being worn
- **`_hal` green as occlusion**, mapped to 0.35–1.0
- everything on **texture arrays**, so a submaterial costs five samplers rather
  than the 19 a naive binding would need against WebGL2's guaranteed 16

Deliberately absent, both closed: **decals** (authored against a second UV
channel the mesh does not carry — sampling them on UV0 renders metre-high
"WARNING" across the chest, which was tried and reverted) and the **Detail
map** (template defaults with no texture bound on 494 of 495 layer materials).

## Running the check

```bash
extract/.venv/bin/scx golden --out data/interim/golden.json
node web/gpu/serve.mjs 8777
```

Then open
`http://127.0.0.1:8777/web/gpu/check.html?golden=/data/interim/golden.json`.
`?layerSize=1024` repacks the layer library at a different resolution.

It composites every submaterial in the golden that has a bake on disk and
compares mean albedo, the same measure `web/core/examples/composite_diff.rs`
scores the CPU port on, so both ports are held to one standard.

## The residual, and what it is not

The shader agrees with the bake on **every** submaterial within 3 sRGB units.
Inside 1 unit it is about a third of them, and the gap was worth chasing because
a systematic bias would mean a rule was wrong.

It is not a rule. Three hypotheses were tested and two were refuted:

- **Tiling quantisation — refuted.** The bake downsamples a layer to
  `round(size / repeat)` pixels and repeats it, so high tiling looked like the
  obvious suspect. Measured, the rows *within* 1 unit have a higher median
  effective tiling (200) than those beyond it (107), and the single worst row has
  the lowest tiling in the set.
- **The 512² layer-library cap — refuted.** Repacking at 1024² moved the count
  within 1 unit not at all, and the worst row from 2.44 to 2.15.
- **The bake's output quantisation — confirmed, and it is two thirds of it.**
  `compose_layered` writes `(linear_to_srgb(rgb) * 255).astype(np.uint8)`, which
  **truncates**; a GPU RGBA8 target rounds. Measured over two million samples
  that costs the bake **0.575 sRGB units** of mean brightness (0.496 from the
  truncation, 0.079 from the 4096-step LUT). The shader reads brighter than the
  bake on 94.4% of channels by a mean of 0.876, so the bake's own quantisation
  accounts for most of it.

The remaining ~0.30 is unexplained. It grows with surface brightness, which is
the opposite profile to the quantisation term, and it is well inside tolerance.

So the bake is the one that is 0.57 dark, not the shader — a 0.2% error, not
worth invalidating 21 GB of cache over, but worth knowing before anyone reads
the residual as a porting fault.
