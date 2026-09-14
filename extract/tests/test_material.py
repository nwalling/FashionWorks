from __future__ import annotations

from pathlib import Path

from sc_extract.material import LAYER_BLEND_SHADER, classify, normalize, parse

MTL = """<Material MtlFlags="256">
  <SubMaterials>
    <Material Name="helmet" Shader="LayerBlend_V2" Diffuse="1,1,1" Specular="0,0,0" Shininess="10">
      <Textures>
        <Texture Map="TexSlot3" File="objects\\\\a\\\\textures\\\\x_ddn.tif"/>
        <Texture Map="TexSlot12" File="objects/a/textures/x_blend.tif"/>
        <Texture Map="TexSlot11" File="objects/a/textures/x_wear.tif"/>
      </Textures>
    </Material>
    <Material Name="glass" Shader="Illum" Diffuse="0.5,0.5,0.5">
      <Textures>
        <Texture Map="TexSlot1" File="objects/a/textures/x_diff.tif"/>
      </Textures>
    </Material>
  </SubMaterials>
</Material>
"""


def test_classify_prefers_the_slot_over_the_filename() -> None:
    """CryEngine addresses textures by numbered slot; suffixes are a fallback."""
    assert classify("anything.tif", "TexSlot3") == "normal"
    assert classify("x_ddn.tif") == "normal"
    assert classify("x_ddna.tif") == "normal"
    assert classify("x_blend.tif") == "blend"
    assert classify("x.tif") is None


def test_normalize_paths() -> None:
    assert normalize("a\\\\b//c.tif") == "a/b/c.tif"
    assert normalize("/a/b.tif") == "a/b.tif"


def test_parse_submaterials_in_order(tmp_path: Path) -> None:
    path = tmp_path / "x.mtl"
    path.write_text(MTL)
    subs = parse(path)
    assert [s.name for s in subs] == ["helmet", "glass"]

    helmet = subs[0]
    assert helmet.shader == LAYER_BLEND_SHADER
    assert helmet.tintable, "LayerBlend_V2 has no albedo; colour comes from the palette"
    assert helmet.textures["normal"] == "objects/a/textures/x_ddn.tif"
    assert helmet.textures["blend"].endswith("x_blend.tif")

    glass = subs[1]
    assert not glass.tintable
    assert glass.textures["base_color"].endswith("x_diff.tif")


def test_parse_missing_file_is_empty(tmp_path: Path) -> None:
    assert parse(tmp_path / "nope.mtl") == []


def test_parse_bad_xml_is_empty(tmp_path: Path) -> None:
    path = tmp_path / "bad.mtl"
    path.write_text("<Material><oops>")
    assert parse(path) == []


LAYERED_MTL = """<Material MtlFlags="256">
  <SubMaterials>
    <Material Name="core_plate_m" Shader="LayerBlend_V2" Shininess="255">
      <Textures>
        <Texture Map="TexSlot12" File="objects/a/textures/x_blend.tif"/>
      </Textures>
      <MatLayers>
        <Layer Name="BaseLayer1" Path="materials/layers/synthetic/paint_01.mtl"
               TintColor="0.04,0.04,0.04" GlossMult="0.44" UVTiling="20" PaletteTint="0" />
        <Layer Name="BaseLayer2" Path="materials/layers/metal/aluminum_dirty.mtl"
               TintColor="1,1,1" GlossMult="0.83" UVTiling="20" PaletteTint="0" />
        <Layer Name="BaseLayer3" Path="materials/layers/synthetic/nylon_02.mtl"
               TintColor="1,1,1" GlossMult="0.77" UVTiling="90" PaletteTint="2" />
        <Layer Name="BaseLayer4" Path="materials/layers/synthetic/rubber_01.mtl"
               TintColor="0.05,0.05,0.05" GlossMult="0.73" UVTiling="137" PaletteTint="0" />
        <Layer Name="WearLayer1" Path="materials/layers/metal/aluminum_dirty.mtl"
               TintColor="1,1,1" GlossMult="1" UVTiling="20" PaletteTint="0" />
      </MatLayers>
    </Material>
  </SubMaterials>
</Material>
"""


def _layered(tmp_path: Path):
    path = tmp_path / "layered.mtl"
    path.write_text(LAYERED_MTL)
    return parse(path)[0]


def test_parses_the_matlayers_stack(tmp_path: Path) -> None:
    """LayerBlend_V2 gets its surface from <MatLayers>, not from an albedo.

    Ignoring this block was why armour rendered flat and untextured.
    """
    sub = _layered(tmp_path)
    assert [layer.name for layer in sub.base_layers] == [
        "BaseLayer1",
        "BaseLayer2",
        "BaseLayer3",
        "BaseLayer4",
    ]
    assert [layer.name for layer in sub.wear_layers] == ["WearLayer1"]


def test_palette_tint_selects_the_colour_source(tmp_path: Path) -> None:
    """PaletteTint 0 means "keep my own colour"; 1/2/3 index the palette.

    87% of layers in the male armour set are 0. Applying the palette to all of
    them repainted surfaces the artist had already coloured.
    """
    base = _layered(tmp_path).base_layers
    assert [layer.palette_tint for layer in base] == [0, 0, 2, 0]
    assert base[0].tint_color == (0.04, 0.04, 0.04)
    assert base[2].tint_color == (1.0, 1.0, 1.0)


def test_layers_under_metal_are_metallic(tmp_path: Path) -> None:
    base = _layered(tmp_path).base_layers
    assert [layer.metallic for layer in base] == [False, True, False, False]


def test_layer_tiling_and_gloss_survive_parsing(tmp_path: Path) -> None:
    base = _layered(tmp_path).base_layers
    assert [layer.uv_tiling for layer in base] == [20.0, 20.0, 90.0, 137.0]
    assert base[0].gloss_mult == 0.44


WEAR_MTL = """<Material MtlFlags="256">
  <SubMaterials>
    <Material Name="hardsurf_m" Shader="LayerBlend_V2" Shininess="255">
      <MatLayers>
        <Layer Name="BaseLayer1" Path="materials/layers/synthetic/painted_metal_11.mtl" />
        <Layer Name="BaseLayer2" Path="materials/layers/fabric/jersey_04.mtl" />
        <Layer Name="WearLayer1" Path="materials/layers/metal/aluminum_scratched_02.mtl" />
        <Layer Name="WearLayer2" Path="materials/layers/fabric/jersey_04.mtl" />
      </MatLayers>
    </Material>
  </SubMaterials>
</Material>
"""


def test_wear_pairs_match_on_slot_number(tmp_path: Path) -> None:
    """WearLayerN is what BaseLayerN looks like worn through.

    The RSI utility suit is unambiguous: painted metal over bare metal, index
    for index.
    """
    path = tmp_path / "wear.mtl"
    path.write_text(WEAR_MTL)
    sub = parse(path)[0]
    pairs = sub.wear_pairs
    assert len(pairs) == 2
    assert pairs[0] is not None
    assert pairs[0].path.endswith("aluminum_scratched_02.mtl")


def test_a_wear_layer_equal_to_its_base_is_a_no_op(tmp_path: Path) -> None:
    """Artists disable wear by pointing the wear entry at the base material.

    29% of all pairs do this, and the cloth body of the RSI suit sets all four
    that way. Treating those as real wear would blend a material with itself
    and waste the work.
    """
    path = tmp_path / "wear.mtl"
    path.write_text(WEAR_MTL)
    assert parse(path)[0].wear_pairs[1] is None
