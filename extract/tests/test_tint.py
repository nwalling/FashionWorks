from __future__ import annotations

from pathlib import Path

import pytest

from sc_extract.material import MatLayer, SubMaterial
from sc_extract.tint import (
    Layer,
    compose,
    compose_layered,
    hex_to_rgb,
    layers_from_tint,
    linear_to_srgb,
    palette_key,
    roughness_from_gloss,
)

PIL = pytest.importorskip("PIL")
np = pytest.importorskip("numpy")
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


def test_neutral_layers_are_not_white() -> None:
    """268 of 491 items carry no palette; white would blow them out."""
    from sc_extract.tint import NEUTRAL_LAYERS

    assert len(NEUTRAL_LAYERS) == 3
    for layer in NEUTRAL_LAYERS:
        assert max(layer.color) < 0.7, "a stand-in must read as unpainted, not white"
    assert len({layer.color for layer in NEUTRAL_LAYERS}) == 3, "keep panel variation"


# ---------------------------------------------------------------------------
# v3 layered compositing
# ---------------------------------------------------------------------------

# The four colours that cover 96% of a real armour blend mask, and the base
# layer each must resolve to, solved against in-game captures. Gold coverage
# in game against the viewer, same angle: arms 12-18% against 15.2%, core
# 24.5% against 23.4%, legs 5.3% against 6.0%. Putting black on BaseLayer1
# instead starves the arms to 3.4% and doubles the legs to 12%.
MASK_COLOURS = [
    ((0, 0, 0), 3),      # black   -> BaseLayer4, the ground
    ((0, 0, 255), 2),    # blue    -> BaseLayer3
    ((0, 255, 0), 1),    # green   -> BaseLayer2
    ((0, 255, 255), 1),  # cyan    -> green over blue -> BaseLayer2
    ((255, 0, 0), 0),    # red     -> BaseLayer1
    ((255, 0, 255), 0),  # magenta -> red over blue   -> BaseLayer1
    ((255, 255, 0), 0),  # yellow  -> red over green  -> BaseLayer1
    ((255, 255, 255), 0),  # white -> BaseLayer1
]

# Four separable tints, one per base layer, so the composite is unambiguous.
LAYER_TINTS = [(0.8, 0.1, 0.1), (0.1, 0.8, 0.1), (0.1, 0.1, 0.8), (0.8, 0.8, 0.1)]


def _layered_sub() -> SubMaterial:
    return SubMaterial(
        name="test_m",
        shader="LayerBlend_V2",
        layers=[
            MatLayer(
                name=f"BaseLayer{i + 1}",
                # Deliberately unresolvable: with no detail texture the layer
                # is its flat tint, which is what makes the assertion exact.
                path=f"materials/layers/none/absent_{i}.mtl",
                tint_color=tint,
                gloss_mult=1.0,
                uv_tiling=1.0,
                palette_tint=0,
            )
            for i, tint in enumerate(LAYER_TINTS)
        ],
    )


def _mask(path) -> None:
    image = Image.new("RGB", (len(MASK_COLOURS), 1))
    image.putdata([colour for colour, _ in MASK_COLOURS])
    image.save(path)


def test_blend_mask_buckets_map_to_the_solved_base_layers(
    tmp_path,
) -> None:
    """Which mask colour selects which BaseLayer, pinned to four references.

    A splat -- ground, then blue, green and red lerped over it, highest channel
    winning -- with the layers numbered from the top: none, blue, green and red
    reach BaseLayer 4, 3, 2 and 1. The natural reading, reversed.

    The previous table put the ground on BaseLayer2 and green on BaseLayer4, and
    it rendered the Corbel Halcyon inverted: helmet shell and upper chest black,
    faceplate and a core stripe yellow, the opposite of the game. The corrected
    table was then checked on references it was not derived from -- the
    Sunchaser upper back renders 32.9% gold against 33.0% on CIG's store render
    (20.3% before), and the Beacon undersuit's sleeves come out the mauve-brown
    the reference shows instead of black -- while keeping the Sunchaser shoulder
    pad, whose mask has no ground or green on it, exactly as it was.

    Never settle this table on one aggregate figure or on a piece whose
    candidate layers are all the same colour; bake candidates, swap them onto a
    live piece, and compare against a reference image.
    """
    blend = tmp_path / "x_blend.png"
    _mask(blend)

    written = compose_layered(
        _layered_sub(),
        [],
        tmp_path / "out",
        "test",
        resolved={"blend": str(blend)},
        raw_root=tmp_path / "raw",
        size=len(MASK_COLOURS),
    )

    pixels = Image.open(written["base_color"]).convert("RGB").load()
    for x, (_colour, expected) in enumerate(MASK_COLOURS):
        want = linear_to_srgb(np.array(LAYER_TINTS[expected], dtype=np.float32))
        got = np.array(pixels[x, 0], dtype=np.float32) / 255.0
        assert np.allclose(got, want, atol=0.01), (
            f"mask column {x} resolved to {got}, expected layer {expected + 1} {want}"
        )


def test_palette_tint_index_routes_to_the_palette(tmp_path) -> None:
    """A layer with PaletteTint=N takes palette entry N, not its own tint."""
    sub = _layered_sub()
    sub.layers[0] = MatLayer(
        name="BaseLayer1",
        path="materials/layers/none/absent.mtl",
        # White, so the palette colour comes through unmodulated. Half of the
        # real palette-tinted layers are white like this; the other half
        # darken the palette colour, which the next test covers.
        tint_color=(1.0, 1.0, 1.0),
        palette_tint=1,
        gloss_mult=1.0,
        uv_tiling=1.0,
    )
    palette = [Layer(color=(1.0, 0.0, 0.0), glossiness=1.0)]

    written = compose_layered(
        sub, palette, tmp_path / "out", "pal",
        resolved={}, raw_root=tmp_path / "raw", size=2,
    )
    red, green, blue = Image.open(written["base_color"]).convert("RGB").load()[0, 0]
    assert red > 200 and green < 40 and blue < 40


def test_untinted_layer_keeps_its_baked_colour(tmp_path) -> None:
    """PaletteTint=0 must ignore the palette entirely.

    This is the 87% case, and getting it wrong is what made every suit the
    wrong colour.
    """
    sub = _layered_sub()
    palette = [Layer(color=(1.0, 0.0, 0.0), glossiness=1.0)]

    written = compose_layered(
        sub, palette, tmp_path / "out", "untinted",
        resolved={}, raw_root=tmp_path / "raw", size=2,
    )
    got = np.array(
        Image.open(written["base_color"]).convert("RGB").load()[0, 0], dtype=np.float32
    ) / 255.0
    want = linear_to_srgb(np.array(LAYER_TINTS[0], dtype=np.float32))
    assert np.allclose(got, want, atol=0.01)


def test_no_layer_stack_falls_back(tmp_path) -> None:
    """A glass or glow submaterial has no MatLayers; the caller must know."""
    bare = SubMaterial(name="glass_m", shader="LayerBlend_V2")
    assert compose_layered(
        bare, [], tmp_path / "out", "glass",
        resolved={}, raw_root=tmp_path / "raw", size=2,
    ) == {}


def test_submaterial_names_that_are_paths_do_not_break_the_cache(tmp_path) -> None:
    """Some submaterials are named with a full asset path.

    The VGL light backpack calls one "Objects/Characters/Human/backpack/vgl/..".
    Pasting that into a cache filename asked Pillow to write into directories
    that do not exist, and took a whole 20-item Blender batch down with it.
    """
    written = compose_layered(
        _layered_sub(),
        [],
        tmp_path / "out",
        "vgl_blend_Objects/Characters/Human/backpack/vgl/pack_01",
        resolved={},
        raw_root=tmp_path / "raw",
        size=2,
    )
    assert written
    for path in written.values():
        assert path.parent == tmp_path / "out"
        assert path.is_file()


def _wear_sub(wear_path: str) -> SubMaterial:
    """Two-layer stack: base layer 1 wears through to `wear_path`."""
    return SubMaterial(
        name="wear_m",
        shader="LayerBlend_V2",
        layers=[
            MatLayer(
                name="BaseLayer1",
                path="materials/layers/none/base.mtl",
                tint_color=(0.8, 0.1, 0.1),
                gloss_mult=1.0,
                uv_tiling=1.0,
            ),
            MatLayer(
                name="WearLayer1",
                path=wear_path,
                tint_color=(0.1, 0.1, 0.8),
                gloss_mult=1.0,
                uv_tiling=1.0,
            ),
        ],
    )


def _grey(path, value: int, width: int = 2) -> None:
    image = Image.new("L", (width, 1), value)
    image.save(path)


def test_a_dark_wear_mask_wears_through_to_the_wear_layer(tmp_path) -> None:
    """Dark is worn.

    The mask is a single BC4 channel, so it is an amount rather than a
    selector. Hard-surface masks average 0.72-0.90 and armour is mostly intact
    paint, so the bright majority has to be the unworn side.
    """
    mask = tmp_path / "x_wear.png"
    _grey(mask, 0)  # fully worn

    written = compose_layered(
        _wear_sub("materials/layers/none/worn.mtl"),
        [],
        tmp_path / "out",
        "worn",
        resolved={"wear": str(mask)},
        raw_root=tmp_path / "raw",
        size=2,
    )
    got = np.array(
        Image.open(written["base_color"]).convert("RGB").load()[0, 0], dtype=np.float32
    ) / 255.0
    want = linear_to_srgb(np.array([0.1, 0.1, 0.8], dtype=np.float32))
    assert np.allclose(got, want, atol=0.01), "a black wear mask must expose the wear layer"


def test_a_bright_wear_mask_keeps_the_base_layer(tmp_path) -> None:
    mask = tmp_path / "x_wear.png"
    _grey(mask, 255)  # pristine

    written = compose_layered(
        _wear_sub("materials/layers/none/worn.mtl"),
        [],
        tmp_path / "out",
        "pristine",
        resolved={"wear": str(mask)},
        raw_root=tmp_path / "raw",
        size=2,
    )
    got = np.array(
        Image.open(written["base_color"]).convert("RGB").load()[0, 0], dtype=np.float32
    ) / 255.0
    want = linear_to_srgb(np.array([0.8, 0.1, 0.1], dtype=np.float32))
    assert np.allclose(got, want, atol=0.01)


def test_wear_is_skipped_when_the_wear_layer_repeats_the_base(tmp_path) -> None:
    """The no-op case must not blend, even under a fully dark mask."""
    mask = tmp_path / "x_wear.png"
    _grey(mask, 0)

    written = compose_layered(
        _wear_sub("materials/layers/none/base.mtl"),  # same path as the base
        [],
        tmp_path / "out",
        "noop",
        resolved={"wear": str(mask)},
        raw_root=tmp_path / "raw",
        size=2,
    )
    got = np.array(
        Image.open(written["base_color"]).convert("RGB").load()[0, 0], dtype=np.float32
    ) / 255.0
    want = linear_to_srgb(np.array([0.8, 0.1, 0.1], dtype=np.float32))
    assert np.allclose(got, want, atol=0.01)


def test_no_wear_mask_leaves_the_base_layer_alone(tmp_path) -> None:
    written = compose_layered(
        _wear_sub("materials/layers/none/worn.mtl"),
        [],
        tmp_path / "out",
        "nomask",
        resolved={},
        raw_root=tmp_path / "raw",
        size=2,
    )
    got = np.array(
        Image.open(written["base_color"]).convert("RGB").load()[0, 0], dtype=np.float32
    ) / 255.0
    want = linear_to_srgb(np.array([0.8, 0.1, 0.1], dtype=np.float32))
    assert np.allclose(got, want, atol=0.01)


def test_metalness_comes_from_reflectance_not_the_directory(tmp_path, monkeypatch) -> None:
    """A layer is metal when its own Specular says so.

    The first rule keyed on the layer living under Materials/Layers/metal. That
    misses the whole `metallic/` category and wrongly promotes the 24% of
    `/metal/` entries whose reflectance is dielectric.
    """
    from sc_extract import layers as layer_lib
    from sc_extract.tint import METAL_F0_THRESHOLD

    # A dielectric sitting in the metal directory must not render as metal.
    fake = layer_lib.LayerMaterial(
        path="materials/layers/metal/painted_thing.mtl",
        diff=None,
        ddna=None,
        specular=(0.04, 0.04, 0.04),
        shininess=200.0,
    )
    monkeypatch.setattr(layer_lib, "load", lambda *a, **k: fake)

    sub = SubMaterial(
        name="m",
        shader="LayerBlend_V2",
        layers=[
            MatLayer(
                name="BaseLayer1",
                path="materials/layers/metal/painted_thing.mtl",
                tint_color=(0.5, 0.5, 0.5),
                gloss_mult=1.0,
                uv_tiling=1.0,
            )
        ],
    )
    assert sub.layers[0].metallic, "the path rule would call this metal"

    written = compose_layered(
        sub, [], tmp_path / "out", "diel", resolved={}, raw_root=tmp_path / "raw", size=2
    )
    _ao, _rough, metal = Image.open(written["orm"]).convert("RGB").load()[0, 0]
    assert metal == 0, f"reflectance {0.04} is below {METAL_F0_THRESHOLD}, so not metal"


def test_a_dielectric_takes_its_colour_from_diffuse(tmp_path, monkeypatch) -> None:
    """168 of 317 dielectric layers set a non-white Diffuse.

    Ignoring it rendered them at full brightness, which is part of why armour
    came out far lighter than the game shows it.
    """
    from sc_extract import layers as layer_lib

    dark = layer_lib.LayerMaterial(
        path="materials/layers/synthetic/dark_paint.mtl",
        specular=(0.04, 0.04, 0.04),
        diffuse=(0.1, 0.1, 0.1),
        shininess=200.0,
    )
    monkeypatch.setattr(layer_lib, "load", lambda *a, **k: dark)

    sub = SubMaterial(
        name="m",
        shader="LayerBlend_V2",
        layers=[
            MatLayer(
                name="BaseLayer1",
                path="materials/layers/synthetic/dark_paint.mtl",
                tint_color=(1.0, 1.0, 1.0),
                gloss_mult=1.0,
                uv_tiling=1.0,
            )
        ],
    )
    written = compose_layered(
        sub, [], tmp_path / "out", "diff", resolved={}, raw_root=tmp_path / "raw", size=2
    )
    got = np.array(
        Image.open(written["base_color"]).convert("RGB").load()[0, 0], dtype=np.float32
    ) / 255.0
    want = linear_to_srgb(np.array([0.1, 0.1, 0.1], dtype=np.float32))
    assert np.allclose(got, want, atol=0.02), f"{got} should follow Diffuse, not white"


def test_black_diffuse_with_reflectance_is_metal() -> None:
    """CryEngine's signature for bare metal, and it catches near-metals.

    weapon_bare_120 sits at specular 0.188, just under the threshold, with a
    black diffuse. A dielectric gets its colour from diffuse, so black diffuse
    plus real reflectance can only be metal.
    """
    from sc_extract.layers import LayerMaterial

    assert LayerMaterial(path="x", specular=(0.188,) * 3, diffuse=(0.0, 0.0, 0.0)).is_metal
    assert LayerMaterial(path="x", specular=(1.0,) * 3, diffuse=(0.0, 0.0, 0.0)).is_metal
    assert not LayerMaterial(path="x", specular=(0.045,) * 3, diffuse=(1.0, 1.0, 1.0)).is_metal


def test_the_palette_modulates_the_layer_tint_rather_than_replacing_it(tmp_path) -> None:
    """A layer's own TintColor still applies under a palette.

    966 of 1984 palette-tinted base layers carry a non-white TintColor, median
    0.50. Replacing it with the palette colour rendered half of them up to
    twice as bright as the game: the Sunchaser backplate, bracket and shoes
    came out light grey against a near-black reference.
    """
    sub = SubMaterial(
        name="m",
        shader="LayerBlend_V2",
        layers=[
            MatLayer(
                name="BaseLayer1",
                path="materials/layers/none/absent.mtl",
                tint_color=(0.5, 0.5, 0.5),
                palette_tint=1,
                gloss_mult=1.0,
                uv_tiling=1.0,
            )
        ],
    )
    palette = [Layer(color=(1.0, 1.0, 1.0), glossiness=1.0)]
    written = compose_layered(
        sub, palette, tmp_path / "out", "mul", resolved={}, raw_root=tmp_path / "raw", size=2
    )
    got = np.array(
        Image.open(written["base_color"]).convert("RGB").load()[0, 0], dtype=np.float32
    ) / 255.0
    # White palette times a half-strength layer is the layer, not white.
    want = linear_to_srgb(np.array([0.5, 0.5, 0.5], dtype=np.float32))
    assert np.allclose(got, want, atol=0.02), f"{got} should be modulated, not replaced"


def test_tint_mode_declares_metal_but_mode_zero_means_nothing() -> None:
    """`TintMode` 1 and 2 are the artist stating dielectric or metal outright.

    Mode 2 is metal, mode 1 is not, and both beat the reflectance heuristic --
    `anodized_white_metal_01` reads dielectric (specular 0.061, diffuse 1.0) and
    is declared metal.

    **Mode 0 is not a statement and must not be treated as one.** It does not
    mean "not metal" and it does not mean "not tinted": `rubber_diamond_02` is
    mode 0, and every Venture undersuit colourway authors a different TintColor
    on it -- (54,31,79) on the purple, (210,210,210) on the base -- so the tint
    plainly applies. Reading mode 0 as "no tint" rendered 1185 armour layer
    references, and 12 of the 28 Venture undersuits, flat white. Mode 0 falls
    through to reflectance.
    """
    from sc_extract.layers import LayerMaterial

    assert LayerMaterial(path="x", tint_mode=2).is_metal
    assert not LayerMaterial(path="x", tint_mode=1).is_metal

    # A stated mode beats reflectance that says the opposite.
    assert LayerMaterial(
        path="anodized_white_metal_01", tint_mode=2,
        specular=(0.061, 0.061, 0.061), diffuse=(1.0, 1.0, 1.0),
    ).is_metal

    # Mode 0 defers to reflectance rather than asserting dielectric.
    assert LayerMaterial(path="x", tint_mode=0, specular=(0.84, 0.84, 0.84)).is_metal
    assert not LayerMaterial(path="x", tint_mode=0, specular=(0.04, 0.04, 0.04)).is_metal

    # No TintMode at all: reflectance decides, as before.
    assert LayerMaterial(path="x", specular=(0.84, 0.84, 0.84)).is_metal
    assert not LayerMaterial(path="x", specular=(0.04, 0.04, 0.04)).is_metal
