from __future__ import annotations

from sc_extract import geometry
from sc_extract.manifest import Geometry, Item


def item(sources: list[str], materials: list[str] | None = None) -> Item:
    return Item(
        id="i",
        class_name="c",
        name="n",
        slot="helmet",
        geometry=[Geometry(source=s) for s in sources],
        materials=materials or [],
    )


def test_common_prefix_filter() -> None:
    assert geometry.common_prefix_filter(["a/b/c/x.skin", "a/b/c/y.skin"]) == "a/b/c/**"
    assert geometry.common_prefix_filter(["a/b/c/x.skin", "a/b/d/y.skin"]) == "a/b/**"
    assert geometry.common_prefix_filter(["a/x.skin"]) == "a/x.skin"
    assert geometry.common_prefix_filter([]) == ""


def test_asset_sources_implies_matching_mtl() -> None:
    sources = geometry.asset_sources(item(["a/b/helmet.skin"]))
    assert "a/b/helmet.skin" in sources
    assert "a/b/helmet.mtl" in sources


def test_asset_sources_does_not_duplicate_declared_material() -> None:
    sources = geometry.asset_sources(item(["a/b/helmet.skin"], ["a/b/helmet.mtl"]))
    assert sources.count("a/b/helmet.mtl") == 1


def test_textures_referenced(tmp_path) -> None:
    mtl = tmp_path / "x.mtl"
    mtl.write_text(
        "<Material><Textures>"
        '<Texture Map="Diffuse" File="tex\\\\a_diff.dds"/>'
        '<Texture Map="Bumpmap" File="tex/a_ddna.dds"/>'
        "</Textures></Material>"
    )
    assert geometry.textures_referenced(mtl) == ["tex/a_diff.dds", "tex/a_ddna.dds"]


def test_textures_referenced_missing_file(tmp_path) -> None:
    assert geometry.textures_referenced(tmp_path / "nope.mtl") == []
