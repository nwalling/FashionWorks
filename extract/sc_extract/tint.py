"""Composite an item's tint palette into PBR textures.

Star Citizen armor ships **no albedo texture**. Its ``LayerBlend_V2`` shader
composites three tinted layers at render time, and the colours live in a
``TintPaletteTree`` record (see :mod:`sc_extract.catalog`). Using only the first
layer, as v1 did, renders a two-tone piece in one flat colour.

The per-pixel layer weights come from the material's ``_blend`` map, whose red
and green channels mask layers B and C over layer A. Verified on build
1.0.191.55227: on a QRT helmet those channels are sparse (means 18 and 29 of
255) while layer A covers the rest, which is what a base colour with accent
detailing looks like.

glTF cannot carry a node graph, so the composite is baked here into two images
the exporter understands:

* ``<stem>_albedo.png``    base colour
* ``<stem>_orm.png``       occlusion/roughness/metallic, glTF's packed layout
  (roughness in green, metallic in blue)

Doing it as image math with Pillow keeps it fast; a Blender bake per item would
dominate the run.
"""

from __future__ import annotations

import hashlib
import logging
import math
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

log = logging.getLogger(__name__)

try:  # Pillow is only needed when compositing, not for the catalog stage.
    from PIL import Image
except ImportError:  # pragma: no cover - exercised only on a host without Pillow
    Image = None  # type: ignore[assignment]

try:  # numpy likewise: the catalog stages import this module without it.
    import numpy as np
except ImportError:  # pragma: no cover - exercised only on a host without numpy
    np = None  # type: ignore[assignment]


@dataclass(frozen=True)
class Layer:
    """One entry of a tint palette."""

    color: tuple[float, float, float] = (0.5, 0.5, 0.5)
    spec: tuple[float, float, float] = (0.23, 0.23, 0.23)
    glossiness: float = 0.5


def hex_to_rgb(
    value: str | None, default: tuple[float, float, float]
) -> tuple[float, float, float]:
    if not isinstance(value, str) or not value.startswith("#") or len(value) != 7:
        return default
    try:
        return tuple(int(value[i : i + 2], 16) / 255.0 for i in (1, 3, 5))  # type: ignore[return-value]
    except ValueError:
        return default


# Used when a LayerBlend_V2 material has no palette to composite. 268 of 491
# canonical items carry no palette reference at all, and that shader supplies no
# albedo, so without a stand-in they render blown-out white. Three near-greys
# keep the blend mask's panel variation visible and read as unpainted metal.
NEUTRAL_LAYERS = [
    Layer(color=(0.42, 0.43, 0.45), spec=(0.23, 0.23, 0.23), glossiness=0.55),
    Layer(color=(0.30, 0.31, 0.33), spec=(0.23, 0.23, 0.23), glossiness=0.65),
    Layer(color=(0.55, 0.56, 0.58), spec=(0.28, 0.28, 0.28), glossiness=0.45),
]


def layers_from_tint(tint: dict | None) -> list[Layer]:
    """Turn a manifest ``tint`` block into up to three layers."""
    entries = (tint or {}).get("layers") or []
    out: list[Layer] = []
    for entry in entries[:3]:
        if not isinstance(entry, dict):
            continue
        gloss = entry.get("glossiness")
        out.append(
            Layer(
                color=hex_to_rgb(entry.get("color"), (0.5, 0.5, 0.5)),
                spec=hex_to_rgb(entry.get("spec"), (0.23, 0.23, 0.23)),
                glossiness=float(gloss) if isinstance(gloss, (int, float)) else 0.5,
            )
        )
    return out


_UNSAFE = re.compile(r"[^A-Za-z0-9_.-]+")


def safe_stem(value: str) -> str:
    """Filename-safe token for a cache stem.

    Some submaterials are named with a full asset path -- the VGL light
    backpack calls one "Objects/Characters/Human/backpack/vgl/..." -- and
    pasting that into a filename asks Pillow to write into directories that do
    not exist. Every separator becomes an underscore.
    """
    return _UNSAFE.sub("_", value).strip("_")[:120] or "material"


def _luminance(rgb: tuple[float, float, float]) -> float:
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]


def _mix(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def roughness_from_gloss(glossiness: float) -> float:
    """Palette glossiness (0-1) to a plausible PBR roughness.

    The palette stores glossiness as 0-255 and armor entries are routinely the
    full 255. Taken literally that is roughness 0, a mirror, which reads as wet
    plastic. It behaves like a multiplier on the material's own gloss, so it is
    mapped into a band that keeps painted armor looking like painted armor.
    """
    return 1.0 - (0.25 + 0.45 * min(max(glossiness, 0.0), 1.0))


def palette_key(layers: list[Layer]) -> str:
    """Short stable digest of a palette, for cache filenames."""
    raw = ";".join(f"{layer.color}:{layer.spec}:{round(layer.glossiness, 4)}" for layer in layers)
    return hashlib.sha1(raw.encode()).hexdigest()[:10]


def compose(
    blend_path: Path | None,
    layers: list[Layer],
    out_dir: Path,
    stem: str,
    *,
    wear_path: Path | None = None,
    size: int | None = 1024,
) -> dict[str, Path]:
    """Write the albedo and packed ORM images. Returns the paths written.

    With no blend map, or only one layer, this still writes flat images so the
    caller has one code path.
    """
    if Image is None:
        log.warning("Pillow is not installed; skipping tint composite for %s", stem)
        return {}
    if not layers:
        return {}

    out_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{safe_stem(stem)}__{palette_key(layers)}"
    written = {
        "base_color": out_dir / f"{stem}_albedo.png",
        "orm": out_dir / f"{stem}_orm.png",
    }
    # Sets share blend maps and palettes, so the same composite is asked for
    # many times over a full run.
    if all(path.is_file() for path in written.values()):
        return written

    base = layers[0]
    layer_b = layers[1] if len(layers) > 1 else base
    layer_c = layers[2] if len(layers) > 2 else base

    mask = None
    if blend_path and blend_path.is_file():
        try:
            mask = Image.open(blend_path).convert("RGB")
            if size and mask.size[0] > size:
                mask = mask.resize((size, size), Image.BILINEAR)
        except OSError as exc:
            log.warning("unreadable blend map %s: %s", blend_path, exc)
            mask = None

    wear = None
    if wear_path and wear_path.is_file():
        try:
            wear = Image.open(wear_path).convert("L")
            if mask is not None:
                wear = wear.resize(mask.size, Image.BILINEAR)
            elif size:
                wear = wear.resize((size, size), Image.BILINEAR)
        except OSError:
            wear = None

    dimensions = mask.size if mask is not None else (8, 8)
    albedo = Image.new("RGB", dimensions)
    orm = Image.new("RGB", dimensions)

    mask_px = mask.load() if mask is not None else None
    wear_px = wear.load() if wear is not None else None
    albedo_px = albedo.load()
    orm_px = orm.load()

    width, height = dimensions
    for y in range(height):
        for x in range(width):
            if mask_px is not None:
                r, g, _b = mask_px[x, y]
                weight_b = r / 255.0
                weight_c = g / 255.0
            else:
                weight_b = weight_c = 0.0

            colour = []
            for channel in range(3):
                value = _mix(base.color[channel], layer_b.color[channel], weight_b)
                value = _mix(value, layer_c.color[channel], weight_c)
                colour.append(value)

            gloss = _mix(base.glossiness, layer_b.glossiness, weight_b)
            gloss = _mix(gloss, layer_c.glossiness, weight_c)
            roughness = roughness_from_gloss(gloss)

            spec = _mix(_luminance(base.spec), _luminance(layer_b.spec), weight_b)
            spec = _mix(spec, _luminance(layer_c.spec), weight_c)
            metallic = min(max(spec * 1.6, 0.0), 1.0)

            if wear_px is not None:
                # Worn edges lose their coat: darker and rougher.
                w = wear_px[x, y] / 255.0
                colour = [c * (0.55 + 0.45 * w) for c in colour]
                roughness = min(1.0, roughness + (1.0 - w) * 0.35)

            roughness = min(max(roughness, 0.15), 1.0)
            albedo_px[x, y] = tuple(int(min(max(c, 0.0), 1.0) * 255) for c in colour)
            orm_px[x, y] = (255, int(roughness * 255), int(metallic * 255))

    albedo.save(written["base_color"])
    orm.save(written["orm"])
    return written


# ---------------------------------------------------------------------------
# v3: composite the material's real MatLayers stack
# ---------------------------------------------------------------------------
#
# What v2 got wrong, and this fixes:
#
# 1. It painted every layer with a palette colour. In the male armour set
#    17332 of 19981 layers carry ``PaletteTint="0"``, meaning "use my own
#    baked TintColor" -- 87% of the surface was being repainted.
# 2. It ignored ``<MatLayers>`` entirely, so no tiling detail (paint grain,
#    nylon weave, rubber pattern, scratched aluminium) ever reached the
#    albedo. That is the detail the shader gets from ``Materials/Layers``.
# 3. It used only the blend mask's red and green channels. The mask drives
#    four base layers through R, G and B; blue had the largest coverage
#    (mean 160 of 255) and was discarded.
# 4. It invented roughness from the palette's glossiness. Real gloss is
#    ``layer Shininess x GlossMult x the _ddna alpha``.
# 5. It keyed the cache on the blend map alone, so all five submaterials of a
#    mesh shared one albedo despite having different layer stacks.
#
# Colour spaces: .mtl colours are linear, palette hex and the diffuse PNGs are
# sRGB, and glTF wants an sRGB base colour texture. Everything is converted to
# linear to blend and back to sRGB to write.

MIN_TILE_PX = 4  # below this a tiled detail texture aliases into mush

# Remapping the wear mask to a wear amount: wear = (THRESHOLD - mask) / FALLOFF,
# clamped. LayerBlend_V2 exposes no wear parameters of its own -- of 2741 armour
# submaterials only 8 carry any Wear* PublicParam, and those 8 are an unrelated
# stencil-edge feature (the 192 that looked like wear tuning are GlassPBR canopy
# scratches). So the curve is chosen, not read.
#
# These values were calibrated over 30 real wear maps: the median map ends up
# with 13.5% of its texels more than a quarter worn, the cleanest with none and
# the grubbiest with half. That reads as scuffed edges and rubbed patches rather
# than stripped armour, which is the right side to err on given the curve is
# inferred.
WEAR_THRESHOLD = 0.5
WEAR_FALLOFF = 0.5

# Reflectance above which a detail layer is treated as bare metal, used by
# layers.LayerMaterial.is_metal. Kept here because it belongs to the texture
# cache key. CryEngine's
# Layer shader states this directly: a metal carries Specular near its F0 with
# Diffuse at black, a dielectric sits near 0.04. Measured across the 495-entry
# layer library the two populations separate cleanly -- the `dielectric`
# category tops out at 0.156 and the `metal` and `metallic` categories run to
# 1.0 -- so 0.2 splits them with room to spare.
#
# The directory the layer lives in is the wrong signal and was the first rule
# here: it misses the whole `metallic/` category (34 materials, 85% metal by
# reflectance) because that path does not contain "/metal/", and it calls 24%
# of `/metal/` metal when their own reflectance says otherwise.
METAL_F0_THRESHOLD = 0.2


def srgb_to_linear(a):
    return np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)


# Transfer functions run on millions of pixels per piece, and a full run bakes
# thousands of pieces. Doing the power curve per pixel dominated the profile,
# so both directions are precomputed once and looked up. They are built on
# first use rather than at import, so this module still imports on a host
# without numpy (the catalog stages do not need it).
_TO_SRGB_STEPS = 4096


@lru_cache(maxsize=1)
def _to_linear_lut():
    return srgb_to_linear(np.arange(256, dtype=np.float32) / 255.0).astype(np.float32)


@lru_cache(maxsize=1)
def _to_srgb_lut():
    x = np.arange(_TO_SRGB_STEPS, dtype=np.float32) / (_TO_SRGB_STEPS - 1)
    return np.where(
        x <= 0.0031308, x * 12.92, 1.055 * (x ** (1 / 2.4)) - 0.055
    ).astype(np.float32)


def linear_to_srgb(a):
    idx = np.clip(a, 0.0, 1.0) * (_TO_SRGB_STEPS - 1)
    return _to_srgb_lut()[idx.astype(np.uint16)]


@lru_cache(maxsize=768)
def _tiled_cached(path: str, size: int, tile_px: int, mode: str):
    try:
        im = Image.open(path).convert(mode)
    except (OSError, ValueError) as exc:
        log.warning("unreadable detail texture %s: %s", path, exc)
        return None
    arr = np.asarray(im.resize((tile_px, tile_px), Image.LANCZOS), dtype=np.uint8)
    if arr.ndim == 2:
        arr = arr[:, :, None]
    reps = math.ceil(size / tile_px)
    tiled = np.tile(arr, (reps, reps, 1))[:size, :size]
    tiled.flags.writeable = False
    return tiled


def _tiled(path, size: int, repeat: float, mode: str = "RGB"):
    """Tile a detail texture ``repeat`` times across the UV square, as uint8.

    The library is small and shared, so the same (texture, tiling) pair is
    asked for over and over across a run; the result is cached.
    """
    repeat = max(1.0, float(repeat))
    tile_px = max(MIN_TILE_PX, int(round(size / repeat)))
    return _tiled_cached(str(path), size, tile_px, mode)


@lru_cache(maxsize=128)
def _resample(path, size: int, mode: str = "RGB"):
    """Load a per-mesh map (blend, hal) at the bake resolution, as float 0-1.

    Blend masks are shared by every submaterial of a mesh and by every palette
    variant of that mesh, so this is worth caching too.
    """
    try:
        im = Image.open(path).convert(mode)
    except (OSError, ValueError):
        return None
    if im.size != (size, size):
        im = im.resize((size, size), Image.BILINEAR)
    arr = np.asarray(im, dtype=np.float32) / 255.0
    arr = arr[:, :, None] if arr.ndim == 2 else arr
    arr.flags.writeable = False
    return arr


def layered_key(sub, palette: list[Layer]) -> str:
    """Digest covering the layer stack *and* the palette it is tinted with."""
    parts = [f"{p.color}:{round(p.glossiness, 4)}" for p in palette]
    for entry in sub.layers:
        parts.append(
            f"{entry.name}|{entry.path}|{entry.tint_color}|{entry.palette_tint}"
            f"|{round(entry.gloss_mult, 4)}|{round(entry.uv_tiling, 3)}"
        )
    parts.append(f"wear:{WEAR_THRESHOLD}:{WEAR_FALLOFF}:metal:{METAL_F0_THRESHOLD}:diffuse")
    return hashlib.sha1(";".join(parts).encode()).hexdigest()[:10]


def compose_layered(
    sub,
    palette: list[Layer],
    out_dir: Path,
    stem: str,
    *,
    resolved: dict[str, str],
    raw_root: Path,
    gloss_cache: Path | None = None,
    p4k: Path | None = None,
    starbreaker: Path | None = None,
    size: int = 1024,
) -> dict[str, Path]:
    """Bake one LayerBlend_V2 submaterial to an albedo and a packed ORM.

    Returns the written paths, or ``{}`` when the material has no usable layer
    stack and the caller should fall back to :func:`compose`.
    """
    from . import layers as layer_lib

    if Image is None or np is None:
        log.warning("numpy/Pillow missing; cannot composite %s", stem)
        return {}
    base_layers = sub.base_layers[:4]
    if not base_layers:
        return {}

    out_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{safe_stem(stem)}__{layered_key(sub, palette)}"
    written = {
        "base_color": out_dir / f"{stem}_albedo.png",
        "orm": out_dir / f"{stem}_orm.png",
    }
    if all(p.is_file() for p in written.values()):
        return written

    # Blend mask: the weights for base layers 2, 3 and 4, applied in turn over
    # layer 1 in the order blue, green, red -- not red, green, blue.
    #
    # Verified on the slaver torso mask, which is hard-edged and saturated
    # rather than a soft gradient. Four colours cover 96% of it: black 34.8%,
    # blue 32.9%, cyan 25.6%, magenta 2.7%. Blending B then G then R resolves
    # those to layers 1, 2, 3 and 4 exactly. The opposite order collapses cyan
    # and magenta onto layer 4, which handed 60% of the surface to a rubber
    # grip pattern and left the palette-tinted layer on a few scraps.
    mask = None
    if "blend" in resolved:
        mask = _resample(resolved["blend"], size, "RGB")

    rgb = np.zeros((size, size, 3), dtype=np.float32)
    rough = np.zeros((size, size, 1), dtype=np.float32)
    metal = np.zeros((size, size, 1), dtype=np.float32)
    have_base = False

    # How much of each base layer has worn through to its wear layer. The
    # mask is a single BC4 channel -- one scalar, so it cannot choose between
    # four layers, only say how much. Dark is worn: hard-surface masks average
    # 0.72-0.90, and armour is mostly intact paint with scuffed patches, not
    # mostly bare metal. See WEAR_THRESHOLD for the remap.
    worn = None
    if "wear" in resolved:
        sample = _resample(resolved["wear"], size, "L")
        if sample is not None:
            worn = np.clip((WEAR_THRESHOLD - sample) / WEAR_FALLOFF, 0.0, 1.0)
            # A mask with nothing below the threshold means nothing is worn, and
            # blending by zero is identity. Dropping it here skips a second full
            # layer evaluation per base layer, which is the whole cost of wear.
            if not worn.any():
                worn = None

    wear_pairs = sub.wear_pairs

    def evaluate(entry):
        """One layer's linear colour, roughness and metallic, at bake size."""
        detail = layer_lib.load(raw_root, entry.path)

        # Where the colour comes from: PaletteTint 0 means the artist already
        # chose it and baked it into the .mtl in linear space.
        if 0 < entry.palette_tint <= len(palette):
            chosen = palette[entry.palette_tint - 1]
            tint = srgb_to_linear(np.array(chosen.color, dtype=np.float32))
            gloss_scale = max(0.05, min(1.0, chosen.glossiness))
        else:
            tint = np.array(entry.tint_color, dtype=np.float32)
            gloss_scale = 1.0

        if detail is not None:
            metallic = 1.0 if detail.is_metal else 0.0
            if metallic:
                # Metal has no diffuse; its base colour is its reflectance.
                tint = tint * np.array(detail.specular, dtype=np.float32)
            else:
                # A dielectric's colour is its diffuse. 168 of 317 dielectric
                # layers set this to something other than white, so skipping it
                # rendered them at full brightness.
                tint = tint * np.array(detail.diffuse, dtype=np.float32)
        else:
            metallic = 1.0 if entry.metallic else 0.0

        repeat = entry.uv_tiling * (detail.tile_u if detail else 1.0)

        colour = np.broadcast_to(tint, (size, size, 3)).astype(np.float32)
        if detail is not None and detail.diff is not None:
            sample = _tiled(detail.diff, size, repeat, "RGB")
            if sample is not None:
                colour = _to_linear_lut()[sample] * tint

        gloss = (detail.glossiness if detail else 0.5) * entry.gloss_mult * gloss_scale
        gloss_map = np.full((size, size, 1), gloss, dtype=np.float32)
        if detail is not None and gloss_cache and p4k and starbreaker:
            path = layer_lib.gloss_for(
                detail, p4k=p4k, starbreaker=starbreaker, cache_dir=gloss_cache
            )
            if path is not None:
                sample = _tiled(path, size, repeat, "L")
                if sample is not None:
                    gloss_map = (
                        sample.astype(np.float32) / 255.0
                    ) * entry.gloss_mult * gloss_scale
        return (
            colour,
            np.clip(1.0 - gloss_map, 0.04, 1.0),
            np.full((size, size, 1), metallic, dtype=np.float32),
        )

    for index, entry in enumerate(base_layers):
        colour, layer_rough, layer_metal = evaluate(entry)

        # Wear it through to the paired layer before the blend mask picks
        # between layers: wear happens within a layer, not between them.
        pair = wear_pairs[index] if index < len(wear_pairs) else None
        if pair is not None and worn is not None:
            wcolour, wrough, wmetal = evaluate(pair)
            colour = colour + (wcolour - colour) * worn
            layer_rough = layer_rough + (wrough - layer_rough) * worn
            layer_metal = layer_metal + (wmetal - layer_metal) * worn

        if not have_base:
            rgb, rough, metal, have_base = colour, layer_rough, layer_metal, True
            continue
        if mask is None:
            continue
        channel = 3 - index  # layer2 -> B, layer3 -> G, layer4 -> R
        weight = mask[:, :, channel : channel + 1]
        rgb = rgb + (colour - rgb) * weight
        rough = rough + (layer_rough - rough) * weight
        metal = metal + (layer_metal - metal) * weight

    # Ambient occlusion: the _hal control map's green channel is the only one
    # carrying data (red and blue sit at the neutral 126). Using it as AO adds
    # the cavity shading the flat white channel threw away.
    ao = np.ones((size, size, 1), dtype=np.float32)
    if "hal" in resolved:
        sample = _resample(resolved["hal"], size, "RGB")
        if sample is not None:
            ao = np.clip(0.35 + 0.65 * sample[:, :, 1:2], 0.0, 1.0)

    albedo = (linear_to_srgb(rgb) * 255.0).astype(np.uint8)
    orm = np.concatenate(
        [
            (ao * 255.0).astype(np.uint8),
            (np.clip(rough, 0.0, 1.0) * 255.0).astype(np.uint8),
            (np.clip(metal, 0.0, 1.0) * 255.0).astype(np.uint8),
        ],
        axis=2,
    )
    Image.fromarray(albedo, "RGB").save(written["base_color"])
    Image.fromarray(orm, "RGB").save(written["orm"])
    return written
