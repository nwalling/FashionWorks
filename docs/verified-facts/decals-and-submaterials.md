# Decals and submaterial groups

How decals are placed through vertex color, and what happens when a mesh group points past its material's submaterial list.

### Decals, decoded (2026-09-24) -- and the Detail map, still inert

**Decals are real and are rendered.** `TexSlot9` on a submaterial compiled with
`%DECALS` is a decal sheet, and the mesh places it with a **second UV set
packed into its vertex colour** at ten bits a coordinate:

    U = ((R - 160) * 16 + (G >> 4)) / 1024
    V = (((G & 15) - 2) * 256 + B) / 1024        (V down the image)

A is not part of it: it is 255 minus the submaterial index. Neutral geometry --
R 160, G `16i + 5` -- decodes to the sheet's bottom-left corner, which the
sheets leave empty, and that is how a surface shows no decal.

**Derived on the Shogun Kiba helmet, confirmed on pieces it was not fitted
to.** Reported by Noel with an in-game capture: the helmet wears a purple
dragon painting on one side. Its sheet is that painting laid out as an unwrap,
and on `shogun_m` 23% of the vertices leave the neutral colour. Decoded, they
form a clean full-square UV layout whose islands the painting's edges follow
exactly; 99.4% of the painting falls inside the decoded footprint. On the
Sunchaser core and arms -- the pieces the earlier attempts failed on -- every
overlay patch decodes to a rectangle framing exactly one sticker on the sheet,
square to within 1% and at right angles, where every earlier reading was off by
16:1. Rendered, the Shogun's graffiti lands where the capture shows it and the
Sunchaser carries small stickers, with no metre-high text anywhere.

**Why the earlier attempts failed.** They scored the coordinate as 8- or 16-bit
fields and never split G, whose high nibble belongs to U and low nibble to V;
and they scored the Sunchaser's text stickers by how much of a patch is
opaque, which is low for letters even when the patch frames them exactly. A
sheet painted as an unwrap was what made the layout legible.

`web/core/src/mesh.rs` `decal_uv` decodes it; `three/decal.ts` samples the
sheet in both the live and baked paths. StarBreaker's own `has_decal` looks for
the token `DECAL` and so misses LayerBlend's `DECALS` on every armour piece.

**The superseded reasoning, kept for the record.** Four findings once said no:

* No armour mesh has a second UV set. Sampling 25 `.skinm` files across 15
  manufacturers with `SB_DEBUG_STREAMS=1`, every one carries exactly
  `IVOVERTSUVS` at elem_size 20 and no `IVONORMALS2` at elem_size 4 and no
  `IVOVERTSUVS2`. StarBreaker parses secondary UVs and its GLB writer emits
  `TEXCOORD_1` when they exist, so this is the mesh, not the tooling.
* The atlas is not in UV0 space. Decal alpha landing inside the union of a
  piece's UV islands is **5.8%** where the islands cover **5.6%** of the square
  -- an enrichment of **1.04x**, which is chance.
* There is no decal geometry: zero `.skin`/`.cgf`/`.cga` matching *decal* in the
  whole male armour tree.
* **The in-game reference shows no decals on the piece.** A user photograph of
  the real Sunchaser shoulder pad has none of the atlas's text on it.

Sampled on UV0 anyway, it renders metre-high "WARNING" and "DEFENSE SYSTEMS"
across the chest. That was implemented, rendered and reverted.

**Addendum (2026-09-24): decal geometry does exist, inside the armour mesh.**
The third finding above searched *file names*, and the geometry is not in its
own file. The Sunchaser core carries 27 small islands (4-37 vertices, mostly
mirrored pairs) and the arms 22, lying 0.2-2.5 mm off the plates, and they are
the only places the vertex colour varies within an island: `R*256+G` is linear
across each to 3-4 parts in 65,536 and B to 0.2-0.3 in 255, the two at right
angles. The submaterials declare `%DECALS` in their `StringGenMask`. So the
patches are almost certainly the decals and the colour their coordinate.

**What was still missing was the mapping into the atlas** (found the same day,
above; this paragraph records the failed search). Sixteen decodings -- 8-bit pairs, `R*256+G` with B, a 12-bit split,
both axis orders, both V directions -- scored as atlas content under the
patches against the same patches placed at random: none beats its null by a
wide margin, and the best on each piece (1.8x on the core, 1.9x on the arms)
is a different decoding that fails on the other. The two coordinates differ in
scale by 16:1 per millimetre, so any mapping that keeps text square involves a
factor the vertex data does not carry -- a shader constant, most likely, and
the compiled shaders are outside what this project reads. It was closed a
second time on that basis, hours before the Shogun helmet settled it.
`web/core/examples/decal_probe.rs` and `decal_analysis.py` reproduce those
figures.

**The Detail map.** `DetailDiffuse`, `DetailBump`, `DetailGloss` and
`DetailTiling` appear on 475 of the 495 layer materials, but they are template
defaults, not authored intent: 458/495 sit at `DetailDiffuse=0.5`, 450/495 at
`DetailTiling=8`, 458/495 at `DetailGloss=0.5`. And **no detail texture is
bound** -- TexSlot7 appears on exactly one layer material in 495
(`weapon_parkerized_02`, pointing at `textures/unified_detail/metal/metal_006_detail.tif`).
A `unified_detail` library of 66 textures exists but almost nothing references
it. With no texture bound the parameters do nothing.

So the flatness of a painted plate is faithful to the source. `paint_01`'s own
diffuse texture has a std of **2.8** and its `_ddna` is a flat (127,127,254) at
std 2.3. Surface interest comes from the wear blend and the armour's own `_ddn`
(std 30/24/18), not from the layer and not from a detail map.

### A mesh names no materials, and can reference one that does not exist

The mesh carries a numeric material id per group plus one `MTL_NAME` chunk
naming the `.mtl` **file**. The submaterial names -- `coated_metal_m`,
`mouthplates_m` -- live in that file. The pipeline arrives at the same mapping
via Collada, which derives its names from the same place.

**The id can point past the end of the list.** The Sunchaser helmet declares
seven groups against a `.mtl` with six submaterials; the seventh holds 28 of its
27,938 triangles. The pipeline emits six primitives for this mesh, so it drops
the orphan somewhere in Collada or Blender without saying so.

**The game does not draw it either (2026-11-07).** Reported by Noel with CIG's
render: the GCD-Army arms and legs wore flat grey plates on the shoulder,
forearm and thigh. Their meshes are the ORC-mkX XenoThreat v2's -- each names
`m_cds_medium_armor_03_01_01` as its own material, fifteen submaterials, with
the xeno overlay plates on 12 and 13 (8,909 and 2,524 vertices on the arms) --
and GCD-Army's record overrides that with a material of nine. The web port
clamped 12 and 13 onto the last submaterial, an unlit lamp (`helmet_light_m`,
Illum, Specular 0.503 read as metal), which drew the overlay as bright grey
metal. The game's icon and CIG's render show the armour's own plates beneath,
painted dark like the rest; reading the missing slots from the mesh's own
material would draw the xeno overlay, which neither shows. So a group past
the list of a material the record or the definition names is not drawn
(`three/geometry.ts`). Agrees with the icons on the Lynx colourways (their
materials drop the canonical's `cushion_*` slot, and the clamp drew a tan pad
under the chest plate).

**Under a material the kitbasher chose, it still clamps**, because there a
group past the list says the choice is wrong. Discovered: the Aponte Explorer
Goggles (class `rmb_goggles_02_01_01` on a `goggles_03` mesh that names
`m_rmb_goggles_03_01_01`; the strap the icon shows sits past the discovered
material's two submaterials), and the "Payback" Killshot and Pulverizer, where
one part's class-name discovery is reused for every part and leaves 90% of
each weapon past a four-submaterial cosmetic material. Borrowed from the other
body's node (`f_` material on an `m_` mesh): the FBL-8a Core (Modified), whose
icon shows no canisters where the clamp draws them, and a Martel Dress whose
male mesh is a Navy jumpsuit, which hidden would show holes. The figure's
materials are the kitbasher's choice too. In 4.10.200 the rule moves 110
looks on the male body: the GCD-Army arms and legs, 90 Lynx colourways, the
damaged Venture helmets (`..._helmet_dmg_...`, whose shattered visor sits past
a plain Venture material) and two Aril Red Alert helmets -- plus the eight
Defiance helmets' 28 triangles and 18 on six Pyro multi-tools.

**The damaged Venture's icon shows the visor the rule hides, and is not the
record's render.** `rsi_explorer_armor_light_helmet_dmg_01_01_20` puts
`m_rsi_explorer_01_helmet_damage.skin` under the plain Venture Olive material
(six submaterials); the mesh's seventh group, 17,901 vertices painted for
slot 7, is the shattered visor, and its icon (a 2560x1440 scene, a face behind
cracked glass) draws it. The only material with that slot is
`explorer/glass-break/m_rsi_explorer_helmet_break_01_01_{01,20}.mtl`, slot 7
`glss_break`, one per damaged colourway. Nothing in the DataCore names either
(0 occurrences of `helmet_break`, `glass-break` or `glss_break` in 4.10.2's
`Game2.dcb`), and the mesh's own `MTL_NAME` is a bare
`m_rsi_explorer_helmet_break_01_01_01`, which beside the mesh does not exist.
So the icon was drawn with that material applied by hand, a still from a
scene, and says nothing about the item as the game builds it; the rule stands
on the GCD-Army's references.

**A single material is never short of a slot (0.17.4).** A `.mtl` with no
`SubMaterials` block is one material, and the engine draws it on every group
of the mesh whatever the id. 0.17.3 read it as a list of one and hid the rest:
the display mannequins (`mannequin_undersuit`, listed as a Beacon Undersuit,
and the `mannequin_display*` core and helmet) name `default_grey.mtl` on
meshes of several groups, and drew 73%, 60% and all but one triangle of
them as holes (undersuit, helmet, core). The core's material payload says
`single` (`material::is_single`) and `geometry.missingFor` clamps under it.
Found by scanning every look for the Item DB's redraw list, which counted 113
where the rule meant 110.
`examples/material_alpha.rs` reads which submaterial each group was painted
for (vertex alpha), which agrees with the group's id on every mesh checked.
