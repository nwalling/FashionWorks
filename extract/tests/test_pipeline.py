from __future__ import annotations

from pathlib import Path

from sc_extract import pipeline
from sc_extract.config import load_settings
from sc_extract.manifest import Geometry, Item

CONFIG = """
[paths]
sc_root = ""
raw_dir = "raw"
out_dir = "out"
interim_dir = "interim"
[convert]
blender_batch_size = 3
"""


def settings_for(tmp_path: Path):
    config = tmp_path / "settings.toml"
    config.write_text(CONFIG)
    return load_settings(config, local_path=None, environ={}, root=tmp_path)


def test_batches_are_exact() -> None:
    assert pipeline._batches([1, 2, 3, 4, 5], 2) == [[1, 2], [3, 4], [5]]
    assert pipeline._batches([], 3) == []


def test_hash_changes_with_input_content(tmp_path: Path) -> None:
    settings = settings_for(tmp_path)
    source = settings.raw_dir / "a" / "helmet.skin"
    source.parent.mkdir(parents=True)
    source.write_text("one")

    item = Item(
        id="i", class_name="c", name="n", slot="helmet", geometry=[Geometry(source="a/helmet.skin")]
    )
    first = pipeline.input_hash(settings, item)

    source.write_text("a much longer body than before")
    assert pipeline.input_hash(settings, item) != first


def test_is_current_requires_glb_and_matching_hash(tmp_path: Path) -> None:
    settings = settings_for(tmp_path)
    item = Item(id="i", class_name="c", name="n", slot="helmet", geometry=[])

    assert pipeline.is_current(settings, item) is False

    out = settings.item_dir("i")
    out.mkdir(parents=True)
    (out / "item.glb").write_bytes(b"glTF")
    assert pipeline.is_current(settings, item) is False, "no hash sidecar yet"

    (out / ".hash").write_text(pipeline.input_hash(settings, item))
    assert pipeline.is_current(settings, item) is True

    (out / ".hash").write_text("stale")
    assert pipeline.is_current(settings, item) is False


# ---------------------------------------------------------------------------
# Colour variants: swatch colour and published textures
# ---------------------------------------------------------------------------


def _descriptor(layers: list[dict], name: str = "core_m") -> dict:
    return {"name": name, "layers": layers}


def test_dominant_colour_weights_the_palette_tinted_layer() -> None:
    """The swatch must read as the colourway, not as the average of the piece.

    Most layers carry a baked colour the artist chose once for every colourway;
    only the palette-tinted layer changes between them. Weighting them equally
    made every variant of a set land on nearly the same grey.
    """
    baked = {"name": "BaseLayer1", "tint_color": [0.0, 0.0, 0.0], "palette_tint": 0}
    tinted = {"name": "BaseLayer2", "tint_color": [1.0, 0.0, 0.0], "palette_tint": 1}
    colour = pipeline.dominant_colour([_descriptor([baked, tinted])])
    assert colour is not None
    red, green, blue = (int(colour[i : i + 2], 16) for i in (1, 3, 5))
    assert red > green and red > blue, colour


def test_dominant_colour_ignores_wear_layers() -> None:
    """Wear layers are the substrate under the paint, not the colourway."""
    base = {"name": "BaseLayer1", "tint_color": [1.0, 0.0, 0.0], "palette_tint": 0}
    wear = {"name": "WearLayer1", "tint_color": [0.0, 0.0, 1.0], "palette_tint": 0}
    with_wear = pipeline.dominant_colour([_descriptor([base, wear])])
    without = pipeline.dominant_colour([_descriptor([base])])
    assert with_wear == without


def test_dominant_colour_converts_linear_to_srgb() -> None:
    """.mtl colours are linear; a CSS swatch is sRGB.

    Mid grey 0.5 linear is 0xbc in sRGB, not 0x80. Skipping the conversion made
    every swatch far darker than the piece it stood for.
    """
    layer = {"name": "BaseLayer1", "tint_color": [0.5, 0.5, 0.5], "palette_tint": 0}
    assert pipeline.dominant_colour([_descriptor([layer])]) == "#bcbcbc"


def test_dominant_colour_without_layers_is_none() -> None:
    assert pipeline.dominant_colour([]) is None
    assert pipeline.dominant_colour([_descriptor([])]) is None


def test_publish_textures_symlinks_the_bake_cache(tmp_path: Path) -> None:
    """Variant textures are served from the bake cache, not copied.

    Copying them would duplicate about 11 GB for files that are already named
    by a content hash and shared between variants.
    """
    settings = settings_for(tmp_path)
    (settings.interim_dir / "tint").mkdir(parents=True)
    albedo = settings.interim_dir / "tint" / "x__abc_albedo.png"
    albedo.write_bytes(b"")

    entries = pipeline.publish_textures(
        settings,
        [{"name": "core_m", "composed": {"base_color": str(albedo), "orm": None}}],
    )
    assert entries == [{"name": "core_m", "base_color": "tint/x__abc_albedo.png"}]
    published = settings.out_dir / "tint"
    assert published.is_symlink()
    assert (published / "x__abc_albedo.png").is_file()


def test_publish_textures_skips_a_material_with_no_bake(tmp_path: Path) -> None:
    settings = settings_for(tmp_path)
    assert pipeline.publish_textures(settings, [{"name": "glass_m", "composed": {}}]) == []


def test_dominant_colour_prefers_the_baked_albedo(tmp_path: Path) -> None:
    """The bake is what the piece looks like; the layer list only approximates it.

    Averaging .mtl layer colours over-weights layers the blend mask barely
    shows, which is how twenty Odyssey undersuits ended up with the same chip.
    """
    from PIL import Image

    albedo = tmp_path / "red_albedo.png"
    Image.new("RGB", (4, 4), (200, 30, 30)).save(albedo)

    descriptor = {
        "name": "core_m",
        "composed": {"base_color": str(albedo)},
        # A layer list that would average to grey if it were used instead.
        "layers": [{"name": "BaseLayer1", "tint_color": [0.5, 0.5, 0.5], "palette_tint": 0}],
    }
    colour = pipeline.dominant_colour([descriptor])
    assert colour == "#c81e1e", colour


def test_dominant_colour_falls_back_to_layers_without_a_bake() -> None:
    """Glass and glow submaterials composite nothing, so the layers are all there is."""
    layer = {"name": "BaseLayer1", "tint_color": [0.5, 0.5, 0.5], "palette_tint": 0}
    assert pipeline.dominant_colour([{"name": "m", "composed": {}, "layers": [layer]}]) == "#bcbcbc"


def test_an_undeclared_material_is_found_by_class_name(tmp_path: Path) -> None:
    """Rigid backpacks share one mesh across a whole family of colourways.

    They declare no material and no palette, so pairing on the mesh name hands
    every colourway the same file -- which is how CSP-68L Forest Camo and Night
    Camo came to wear Cayman's surface. The material is in the archive under the
    class name instead.
    """
    settings = settings_for(tmp_path)
    packs = settings.raw_dir / "Data" / "Objects" / "backpack"
    packs.mkdir(parents=True)
    for stem in (
        "cds_combat_light_backpack_02",           # the shared, family-wide one
        "cds_combat_light_backpack_02_02_01",     # Forest Camo's own
        "cds_combat_light_backpack_02_03_01",     # Night Camo's own
    ):
        (packs / f"{stem}.mtl").write_text("<Material/>")
    (packs / "cds_combat_light_backpack_02.cga").write_text("")

    pipeline._mtl_index.cache_clear()
    mesh = "Objects/backpack/cds_combat_light_backpack_02.cga"
    forest = Item(
        id="f", class_name="cds_combat_light_backpack_02_02_01", name="Forest Camo",
        slot="backpack", geometry=[Geometry(source=mesh, side=None)],
    )
    night = Item(
        id="n", class_name="cds_combat_light_backpack_02_03_01", name="Night Camo",
        slot="backpack", geometry=[Geometry(source=mesh, side=None)],
    )
    assert [p.stem for p in pipeline.discover_materials(settings, forest)] == [
        "cds_combat_light_backpack_02_02_01"
    ]
    assert [p.stem for p in pipeline.discover_materials(settings, night)] == [
        "cds_combat_light_backpack_02_03_01"
    ]


def test_class_name_lookup_drops_trailing_tokens(tmp_path: Path) -> None:
    """Some colourways name the material with the last component removed.

    ``cds_combat_light_backpack_01_04_01`` pairs with ``..._01_04.mtl``.
    """
    settings = settings_for(tmp_path)
    packs = settings.raw_dir / "Data" / "Objects" / "backpack"
    packs.mkdir(parents=True)
    (packs / "cds_combat_light_backpack_01_04.mtl").write_text("<Material/>")

    pipeline._mtl_index.cache_clear()
    item = Item(
        id="s", class_name="cds_combat_light_backpack_01_04_01", name="Snow Camo",
        slot="backpack", geometry=[],
    )
    assert [p.stem for p in pipeline.discover_materials(settings, item)] == [
        "cds_combat_light_backpack_01_04"
    ]


def test_a_declared_material_still_wins_over_the_class_name(tmp_path: Path) -> None:
    """The class-name lookup only runs where the record declares nothing."""
    settings = settings_for(tmp_path)
    packs = settings.raw_dir / "Data" / "Objects" / "backpack"
    packs.mkdir(parents=True)
    (packs / "declared.mtl").write_text("<Material/>")
    (packs / "cds_combat_light_backpack_02_02_01.mtl").write_text("<Material/>")

    pipeline._mtl_index.cache_clear()
    item = Item(
        id="d", class_name="cds_combat_light_backpack_02_02_01", name="Declared",
        slot="backpack", materials=["Objects/backpack/declared.mtl"], geometry=[],
    )
    assert [p.stem for p in pipeline.discover_materials(settings, item)] == ["declared"]
