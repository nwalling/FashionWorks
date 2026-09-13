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
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

try:  # Pillow is only needed when compositing, not for the catalog stage.
    from PIL import Image
except ImportError:  # pragma: no cover - exercised only on a host without Pillow
    Image = None  # type: ignore[assignment]


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
    stem = f"{stem}__{palette_key(layers)}"
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
