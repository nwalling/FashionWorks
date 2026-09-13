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
