# Blender pipeline

What the Python and Blender pipeline was verified to do on this host and on real armor: conversion, normalizing, material slots, normals, and what is still unverified.

Two lists. The first is verified. The second is what the Task 1 spike must fill
in and **must not be guessed at** — `fields.py` holds the current guesses, and
they are marked as such.

### Verified on this host (2026-09-13)

- **Joint order is stable across exports.** Every item GLB exported against the
  cached canonical armature carries an identical joint list to `base/male.glb`
  (23 joints, same order, 30/30 items). This is what makes PLAN.md §5.3
  Option A a pointer swap rather than a buffer rewrite.
- **Rebinding shares one skeleton at runtime.** With a full set equipped, the
  scene holds 1 distinct `THREE.Skeleton` and 23 bone objects total; posing a
  bone deforms the base mesh and every equipped piece together.
- **Socket pieces export unskinned.** Backpacks come out with no `skins` array
  and their origin baked to the socket rest transform, so
  `bone.add(mesh)` is all the viewer needs.
- **Swapping does not leak, on repeat.** Renderer geometry count rises while the
  `useGLTF` cache fills, then holds flat across hundreds of swaps, with tint
  changes interleaved. Only the handful of geometries actually in the scene are
  live; the rest is the cache, which is what makes swaps instant. Median swap
  latency is ~17 ms (one frame). Re-measure with `window.__kitbasher.gl.info`.
  This holds for swapping *between items already loaded*. It says nothing about
  the cost of each new one, which on real assets is 13.6 MB retained forever --
  see "The GLB cache needs a byte budget" in `local-viewer.md`.
- **Tinting has to work from the bound mesh list, not the loaded scene.**
  Binding reparents meshes out of the cloned item scene and under the base
  character, so traversing the clone afterwards finds nothing. This was a real
  bug; `ArmorPiece` now tints the list `bindSkinned`/`bindSocket` returns.
- **The batch normalizer isolates failures.** A batch containing a broken item
  writes the other items and records the failure in `errors.json`.
- **Blender on this host is 3.3.1**, not the 4.x PLAN.md §0 assumes. The export
  helper drops unsupported keyword arguments and logs which, so the same script
  runs on both.

Caveat: all of the above was proven with **synthetic placeholder geometry**
(`blender/make_synthetic.py`), not game assets. It validates the mechanism, not
the data.

### Verified by rendering real armor

The QRT "Bokto" heavy set (helmet, core, arms, legs, backpack) plus a CDS
undersuit renders on the shared 220-bone skeleton, with real tint colours and
normal-mapped detail, and deforms correctly when bones are posed. The scene
holds **one** skeleton and 220 bone objects across 10 skinned meshes.

**Use Collada for meshes, not glTF.** cgf-converter's glTF keeps skin weights,
but Blender does not apply its inverse bind matrices: one arms piece imported at
Z 2.60-3.21 on a 1.745 m skeleton, and the pieces stacked end to end instead of
overlapping the body. The same asset through `-dae` imports at Z 1.15-1.76,
which is correct. Collada files are much larger (16 MB versus 3 MB) and that is
the price. `normalize_armor.CONVERTED_SUFFIXES` prefers `.dae`.

**Scale and up-axis need no correction.** The skeleton is 1.745 m tall with hips
at 1.00 and head at 1.71, in metres, Z-up in Blender. `--scale` and `--up-axis`
stay at their no-op defaults.

**Strip vertex colours before export.** CryEngine stores layer-blend masks in
vertex colour. glTF multiplies `COLOR_0` into base colour and three.js honours
it, which rendered the whole character vivid magenta and yellow. `_common.strip_vertex_colors`
removes them in both Blender scripts.

The colour is data, not a paint mask, and stripping it for rendering is still
right. Measured on the Sunchaser core and arms (RENDERING.md Phase 6): **A is
255 minus the submaterial index**, exactly, on all 13 submaterials; B tracks
the island's V (Spearman 0.95 core, -0.88 arms); R sits at 160-161 and G at
16i + 5 on 99% of vertices, constant per island. Where a decal is placed the
colour is its UV instead -- see "Decals, decoded" in `decals-and-submaterials.md`.

**Option A is restored, but only because Blender does the remap.** Re-exporting
each item against the canonical armature makes every item GLB carry the same
220 joints in the same order, so the viewer binds by pointer swap. The runtime
name-remap in `viewer/src/three/binding.ts` is the safety net it was designed to
be. Two things make that work:

* unknown vertex groups are removed, but their weight is first moved onto the
  piece's dominant bone. Dropping it outright left 1080 of 30901 torso vertices
  unweighted, and Blender's exporter then invented a `neutral_bone`, pinning
  that cloth to the origin.
* the strays are of two kinds: `*_override` equipment attachment points, which
  carry no weight, and simulation chains (`CC_fabric_*`, `*_Skel_Sim`), which do.

**Armor has no albedo texture.** The shader is `LayerBlend_V2` and colour comes
from the item's tint palette. Textures are addressed by numbered slot, not by
role: `TexSlot3` is the normal map (`_ddn`/`_ddna`), `TexSlot9` a decal,
`TexSlot11/12/13` the wear, blend and "hal" layer masks. Filename-suffix
guessing alone misses all of them; `mtl_to_pbr.TEX_SLOTS` maps by slot first.

**Tint palettes give the real colours.** Each geometry node carries
`Geometry.Palette.RootRecord`, a `file://` ref to a `TintPaletteTree` whose
`entryA`/`entryB`/`entryC` each hold a tint colour, a specular colour and a
glossiness (0-255), plus a glass colour. 1183 of 2615 items resolve a palette.

### Every piece rendered with one submaterial (2026-09-14)

Armour came out chrome instead of matte black because **the whole mesh was
being painted with its first submaterial's texture**. On the Artimex arms that
is `fingerarmor_m`, whose base layer is polished anodized metal at 89% coverage.
195 of 200 sampled items exported exactly **one** material no matter how many
their `.mtl` declared.

**`obj.data.materials.clear()` resets every polygon's `material_index` to 0.**
Blender clears the face assignment along with the slots. `apply_materials`
cleared and appended, so a mesh the Collada importer had loaded with ten
correctly assigned material groups came out with all 39546 polygons pointing at
slot 0. Slots are now replaced in place, matched by name (Collada names them
`<mtl stem>_mtl_<submaterial>`) so a mismatch between .mtl order and Collada
order cannot mis-assign them.

Worth knowing that nothing upstream was wrong: the `.dae` carries all ten
`<triangles>` groups, and Blender imports ten slots with indices 0-9 spread
correctly across the polygons. The damage happened in one line.

**Metalness comes from the layer's own reflectance, not its directory.**
CryEngine's Layer shader says it plainly: a metal carries `Specular` near its
F0 with `Diffuse` at black, a dielectric sits near 0.04. Across the 495-entry
layer library the populations separate cleanly, the `dielectric` category
topping out at 0.156, so `tint.METAL_F0_THRESHOLD` splits at 0.2. The old
directory rule missed the whole `metallic/` category (34 materials, 85% metal
by reflectance, and `/metallic/` does not contain `/metal/`) and promoted the
24% of `/metal/` entries whose own reflectance is dielectric. Measured impact
is small -- blend-weighted metalness over 31 armour submaterials moves from
0.25 to 0.23, with only 2 changing materially -- so this was not the cause of
the chrome look, just a correctness fix found while chasing it.

### Stray weight goes to the vertex's own bones, not one bone per mesh

Pieces floated off the body: a bracelet on the Defiance arms, a left
shoulderpad on the Antium set. `rebind` moved *all* stray weight to a single
dominant bone chosen for the whole mesh, so mirrored geometry was flung across
the body. The Defiance arms sent 1828 vertices to `LeftForeArm`, the right
wrist cuff among them; the Antium arms sent 8037 to `RightArm`, including the
left shoulder.

Stray weight is now redistributed to each vertex's own surviving bones,
renormalised, which is right whenever a cuff is also weighted to the forearm.
Only a vertex with no surviving bone needs a guess, and that one prefers a
same-side bone sharing a word, then the busiest bone on that side, then the
mesh's dominant bone.

**Side is the reliable signal, not the words.** Anatomy names barely overlap:
nothing in `LeftWrist_CuffTwist` matches `LeftForeArm`. Tokenising has to split
camelCase as well as separators, or `LeftWrist` stays welded together and
matches nothing.

### Match material slots by name before falling back to position

`apply_materials` assigned descriptors in one pass, taking a name match when
there was one and the descriptor's ordinal otherwise. That let an unmatched
descriptor take, by position, a slot that a later correctly-named descriptor
needed.

The Defiance legs are the case. The mesh is CDS, with slots `pads_straps_m`,
`clips_m`, `thighs_m`, `shoes_m`, `sole_m`, `thigh_panels_m`, `glows_m`. The
.mtl the record names is a whole-body **slaver** material that lists
`shoulderpads_m`, `arm_base_m`, `arm_exo_m`, `gloves_m`, `collar_m` and
`torso_base_m` in between the leg entries. So `shoulderpads_m` took the
`clips_m` slot, `arm_base_m` took `thighs_m`, and by the time the real
`thighs_m` descriptor came round its slot was gone. Arm and collar materials
were painted onto leg geometry, and the leg materials -- including the
palette-tinted gold accents -- landed on nothing.

Name matches are now assigned first and leftovers fill whatever slots remain.

Reusing one whole-body .mtl across separate meshes is normal here, so the
descriptor list routinely contains submaterials a given mesh does not use.
Positional assignment is only ever a guess; names are the real key.

### Shading, and why armor looked low-poly

Nothing was wrong with the geometry: pieces convert at LOD0 with 28-40k
triangles, and LOD variants are filtered by name. The problem was normals.
CryEngine hard-surface meshes depend on custom split normals, and **neither the
Collada nor the glTF import brings them across**: a mesh arrives with all
28,138 polygons smooth shaded and no auto-smooth, so Blender averages normals
straight over sharp panel edges. `_common.shade_auto_smooth` keeps edges above
`convert.smooth_angle` (default 40 degrees) hard, and the triangulate step
preserves custom normals where they do exist.

### Still unverified

- Only one set has been converted end to end. `scx convert` has not been run
  across the full catalog, so per-item failure rates are unknown.
- The socket bone is chosen from a per-slot table rather than read from the
  CDF's `CA_BONE` entry, which carries the real `BoneName` and relative
  transform. Fine for backpacks; other rigid pieces may need the CDF.
- 12 of 41 complete sets are converted. Running the full catalog through
  conversion has not been attempted, and Collada intermediates are large.
- Placeholder junk in the catalog (`<= PLACEHOLDER =>`, `Body`) is flagged
  and hidden; the unresolved names are explained under "A name key can carry
  `,P`" in `catalog.md`.
- 331 items have no manufacturer code.
