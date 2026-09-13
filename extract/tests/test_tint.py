from __future__ import annotations

from pathlib import Path

import pytest

from sc_extract.tint import (
    Layer,
    compose,
    hex_to_rgb,
    layers_from_tint,
    palette_key,
    roughness_from_gloss,
)

PIL = pytest.importorskip("PIL")
from PIL import Image  # noqa: E402


def test_hex_to_rgb() -> None:
    assert hex_to_rgb("#ff0000", (0, 0, 0)) == (1.0, 0.0, 0.0)
    assert hex_to_rgb("nope", (0.5, 0.5, 0.5)) == (0.5, 0.5, 0.5)
    assert hex_to_rgb(None, (0.5, 0.5, 0.5)) == (0.5, 0.5, 0.5)


def test_layers_from_tint() -> None:
    layers = layers_from_tint(
        {
            "layers": [
                {"color": "#ff0000", "spec": "#3b3b3b", "glossiness": 1.0},
                {"color": "#00ff00", "spec": "#3b3b3b", "glossiness": 0.5},
            ]
        }
    )
    assert len(layers) == 2
    assert layers[0].color == (1.0, 0.0, 0.0)
    assert layers[1].glossiness == 0.5


def test_layers_from_empty_tint() -> None:
    assert layers_from_tint(None) == []
    assert layers_from_tint({}) == []


def test_roughness_band_keeps_armor_matte() -> None:
    """A palette glossiness of 255 taken literally is a mirror; it is a multiplier."""
    assert roughness_from_gloss(1.0) == pytest.approx(0.30)
    assert roughness_from_gloss(0.0) == pytest.approx(0.75)
    assert roughness_from_gloss(2.0) == pytest.approx(0.30), "clamped"


def test_palette_key_is_stable_and_distinct() -> None:
    a = [Layer(color=(1, 0, 0))]
    b = [Layer(color=(0, 1, 0))]
    assert palette_key(a) == palette_key(list(a))
    assert palette_key(a) != palette_key(b)


def _blend_map(path: Path) -> Path:
    """Left half selects layer B (red), right half layer C (green)."""
    image = Image.new("RGB", (8, 8), (0, 0, 255))
    for y in range(8):
        for x in range(4):
            image.putpixel((x, y), (255, 0, 0))
        for x in range(4, 8):
            image.putpixel((x, y), (0, 255, 0))
    image.save(path)
    return path


def test_compose_produces_two_tone_albedo(tmp_path: Path) -> None:
    blend = _blend_map(tmp_path / "blend.png")
    layers = [
        Layer(color=(0.0, 0.0, 0.0)),
        Layer(color=(1.0, 0.0, 0.0)),
        Layer(color=(0.0, 0.0, 1.0)),
    ]
    written = compose(blend, layers, tmp_path / "out", "piece")
    albedo = Image.open(written["base_color"]).convert("RGB")

    left = albedo.getpixel((1, 1))
    right = albedo.getpixel((6, 1))
    assert left != right, "the blend mask must select different layers"
    assert left[0] > left[2], "red channel masks layer B"
    assert right[2] > right[0], "green channel masks layer C"


def test_compose_writes_packed_orm(tmp_path: Path) -> None:
    blend = _blend_map(tmp_path / "blend.png")
    written = compose(blend, [Layer(glossiness=1.0)], tmp_path / "out", "piece")
    orm = Image.open(written["orm"]).convert("RGB")
    _occlusion, roughness, _metallic = orm.getpixel((0, 0))
    assert roughness == pytest.approx(int(0.30 * 255), abs=2)


def test_compose_is_cached(tmp_path: Path) -> None:
    blend = _blend_map(tmp_path / "blend.png")
    layers = [Layer()]
    first = compose(blend, layers, tmp_path / "out", "piece")
    stamp = first["base_color"].stat().st_mtime_ns
    second = compose(blend, layers, tmp_path / "out", "piece")
    assert second == first
    assert second["base_color"].stat().st_mtime_ns == stamp, "should not rewrite"


def test_compose_without_a_blend_map_is_flat(tmp_path: Path) -> None:
    written = compose(None, [Layer(color=(1.0, 0.0, 0.0))], tmp_path / "out", "flat")
    albedo = Image.open(written["base_color"]).convert("RGB")
    assert albedo.getpixel((0, 0))[0] > 200


def test_compose_without_layers_writes_nothing(tmp_path: Path) -> None:
    assert compose(None, [], tmp_path / "out", "none") == {}
