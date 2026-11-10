# Measuring against references

How to compare renders with references without fooling yourself: reference sources, contrast ratios, accent coverage and known bake offsets.

### cstone.space is a reference corpus, and its ids are ours

`finder.cstone.space` keys every item by the **same GUID the DataCore uses**, so
it joins to `manifest.items[].id` exactly -- no name matching. 2402 of our 2615
items are in their index, and `https://cstone.space/uifimages/<id>.png` is a
reference photo for about 78% of those. Their item pages also carry the class
name, and their names disambiguate 134 of our duplicate display names, including
some we have as `unnamed` (`doom_combat_medium_arms_01_01_01` is "Clash Arms").
There is no index route -- `/FPSArmors1/` is a 404 -- but `GET /GetSearch`
returns the whole 7807-item list as JSON.

**Most of those images are player screenshots, not studio renders, and that
limits them.** Only about 3% have a uniform dark background; the rest are shot
in hangars with machinery, signage and coloured lighting in frame. Scoring a
reference against its *own* name, which should be easy, gives a median named-hue
mass of 0.62 on the studio subset and 0.19 on the rest -- and blue scores 0.95
because hangars are blue-lit while olive and gold score 0.01. So the cluttered
ones are for eyeballing a suspicion, never for an automated verdict. Segment on
a uniform dark border before trusting one.

**Compare in hue, not luminance.** Our viewer runs about twice as contrasty as
these references (Odyssey II Tan/Black: light/dark median ratio 4.48 against the
reference's 2.27, matching the 4.09-vs-2.48 gap already recorded for Sunchaser),
so any luminance comparison flags every item. HSV hue and saturation are ratios
of channel extremes and survive that gap intact; that is why the comparator in
this work is built on them. A first eyeball reading of Odyssey as a tan/black
*inversion* was wrong -- measured, we render **more** light area than the
reference (35% against 25%), and the excess contrast was crushing mid-tan to
near-black.

### The bake truncates, and is 0.57 sRGB units dark

`compose_layered` writes `(linear_to_srgb(rgb) * 255).astype(np.uint8)`, and
`astype` **truncates**. Measured over two million samples that costs the baked
albedo **0.575 sRGB units** of mean brightness: 0.496 from the truncation and
0.079 from the 4096-step `linear_to_srgb` LUT. Anything that composites the
same rules and rounds instead -- a GPU RGBA8 render target does -- reads
brighter by that much, on 89% of channels.

This is 0.2% and not worth invalidating 21 GB of cache over. It is recorded
because it is **most of the residual any port shows against the bake**, and
reading that residual as a porting fault sends you looking in the wrong place.
Two better-sounding explanations were tested against 357 submaterials and both
are refuted:

* *Tiling quantisation.* The rows **within** a unit have a higher median
  effective tiling (200) than the rows beyond it (107), and the worst row has
  the lowest tiling in the set. An earlier note in `WEB.md` claimed the
  opposite, fitted to 40 rows.
* *Layer-library resolution.* Repacking the library from 512 to 1024 changed
  the count within a unit not at all.

### Measuring an accent: three ways to take it at the wrong level

All three were done wrong first, and each produces a confident wrong number.

**A piece's contrast is not the mean of its submaterials' contrasts.** A render
pools every material into one image and compares gold against everything else. A
single submaterial compares its gold against *its own* non-gold, which for a
mostly-dark bracket with a gold edge is a different and much higher number. The
Sunchaser's eight gold-bearing materials read 0.78 to 3.50 individually; pooled,
the core reads 2.49. Pool the texels, then take one ratio.

**An albedo atlas is not a lit render, so the 2.95-3.47 reference band does not
apply to it.** The atlas reads 2.44-2.77 -- for the pipeline's own bake as much
as for any port. A metal's specular response, occlusion, and UV space no camera
sees all separate the two. Holding an atlas against that band reports a failure
of the renderer as a failure of the compositor.

**A ratio of almost nothing is not a measurement.** Two pieces looked like large
regressions purely because one side found no accent at all -- `Reading::contrast`
returns 0.0 for "undefined" and that reads as a drift of 1.21. Require a minimum
accent coverage before comparing.

**And a surface whose accent sits on the hue band's boundary cannot be scored on
coverage.** The Ana set's accent has a median hue of **exactly 30.0** against a
band starting at 30, with 31% of one atlas in a single uniform region right
there, so a sub-unit colour difference moves the lot across at once: 9.4
coverage points of apparent disagreement on surfaces whose mean albedo agrees to
under 3 units. The band was defined for the Sunchaser gold at hue 37 and nothing
says it discriminates elsewhere. Detect the edge case and report it apart.

### Sunchaser, measured on screen against the in-game reference

Both figures measured the same way, as a percentage of lit body pixels:

| region | in-game | viewer |
| ------ | ------- | ------ |
| core / torso | 24.5% | 25.5% |
| helmet | 50.1% | 52.9% |
| arms | 8.9-11.8% | 2.9-3.3% |
| legs | 5.3% | 14.2% |

**Core and helmet are right, so the palette index mapping is not globally
wrong.** If `PaletteTint 1 -> entryA` were off by one, every piece would be
wrong together, and two of the four match to within a point.

What is wrong is per material: the arms carry about a third of the gold they
should, and the legs nearly three times too much. The legs were 0% before the
slot-matching fix, so that fix moved them in the right direction and overshot.

Measure this on screen, not on the texture atlas. An atlas fraction counts
unused UV space and is not comparable to what the eye sees: the arms read 7.7%
of their atlas but only 3% of their silhouette, which is the difference
between "slightly low" and "clearly wrong".

### Compare contrast, not absolute luminance

Two in-game captures of the same armour disagree on absolute brightness
because their scenes differ: the Sunchaser reference reads a non-gold median of
32.7 on one sheet and 42.3 on the store render. Absolute comparisons against a
viewer tuned to a third capture are therefore meaningless.

The lighting-invariant measure is the ratio of gold median to non-gold median
within one image:

| source | ratio |
| ------ | ----- |
| reference, user sheet | 3.47 |
| reference, store render | 2.95 |
| viewer, before the blend-table fix | 2.33-2.55 |
| viewer, after | **3.81** |

Use this ratio for any future comparison, and measure it against a real
silhouette: masking the body by "brighter than the backdrop" counts the
backdrop too and reported 4% gold over 442k pixels where the truth was 17.5%
over 105k. Render the scene twice, once with the armour hidden, and take the
pixels that changed.

The blend-table fix moved the ratio from 25% under the reference band to about
10% over it, so the residual is now non-gold being slightly too dark relative
to gold rather than much too light. That is a smaller and opposite error.
