"""Golden outputs: everything the web port is scored against, as one file.

WEB.md's mitigation for its largest risk -- *the knowledge port, not the code
port, is the real cost* -- is that the Python stays the reference and the port
is gated on matching it. That only works if the reference outputs can be
regenerated. The first set was produced by a throwaway script, which meant the
numbers in WEB.md could be quoted but not re-derived; this module is that
script, kept.

It dumps, per submaterial of a fixed item list, every input
`tint.compose_layered` consumes and the mean of what it produced. Three
harnesses read it:

* `web/core/examples/composite_diff.rs` -- the CPU port's mean albedo
* `web/gpu/check.html` -- the GPU shader's, read back off a framebuffer
* `web/core/examples/gold_fraction.rs` -- the store-render comparison

The item list covers the pieces whose appearance settled a rule, so a
regression shows up as a named piece rather than as a percentage: Sunchaser
(the blend table and the palette index), Corbel Halcyon (the ground layer),
Beacon (the colourway roles), Lynx (the palette specular), Venture (TintMode 0)
and Odyssey (colourway by material).
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path

from . import layers as layer_lib
from . import material, pipeline, tint
from .config import Settings
from .manifest import Item, Manifest

log = logging.getLogger(__name__)

# Paths are emitted relative to the repository root so the file is portable and
# so a static server rooted there can serve every texture it names. The GPU
# harness fetches them over HTTP; the Rust harnesses open them from disk.
ROOT = Path(__file__).resolve().parents[2]


def _rel(path: Path | str | None) -> str | None:
    if path is None:
        return None
    resolved = Path(path)
    try:
        return str(resolved.relative_to(ROOT))
    except ValueError:
        return str(resolved)


# Substrings matched against an item's display name, lowercased. Each one is
# here because a piece in that family decided a rule; see the module docstring.
REFERENCE_FAMILIES = (
    "sunchaser",
    "halcyon",
    "beacon",
    "lynx",
    "venture",
    "odyssey",
    "bokto",
    "deadhead",
)


@dataclass(frozen=True)
class Selection:
    """Which items the golden covers, and why each was picked."""

    items: list[Item]
    matched: dict[str, str]


def select(manifest: Manifest, families: tuple[str, ...] = REFERENCE_FAMILIES) -> Selection:
    """Items from the reference families, one per slot per family.

    **Colour variants are included, and have to be.** Sunchaser and Halcyon are
    both variants, and both are here because their *appearance* settled a rule:
    1626 of 2081 variants name their own material under `mtl_var/` and 876 carry
    no palette at all, so a variant is a different layer stack, not a tint of
    its sibling's. Skipping them dropped exactly the two pieces the store-render
    comparison is measured against.
    """
    chosen: dict[tuple[str, str], Item] = {}
    matched: dict[str, str] = {}
    for item in manifest.items:
        name = (item.name or item.class_name or "").lower()
        family = next((f for f in families if f in name), None)
        if family is None:
            continue
        key = (family, item.slot)
        chosen.setdefault(key, item)
        matched.setdefault(item.id, family)

    # Every sibling colourway of whatever was chosen, because the
    # `colourways-identical` invariant needs four members of one group to say
    # anything. One item per slot is enough to check a surface; it is not
    # enough to notice a family collapsing onto one colour, which is how
    # reading `TintMode=0` as "not tinted" baked twelve Venture undersuits to
    # the same near-white.
    groups = {item.variant_of or item.id for item in chosen.values()}
    for item in manifest.items:
        if (item.variant_of or item.id) in groups and item.id not in matched:
            chosen[("colourway", item.id)] = item
            matched[item.id] = "colourway"
    return Selection(items=list(chosen.values()), matched=matched)


def _mean_rgb(path: Path) -> list[float] | None:
    try:
        import numpy as np
        from PIL import Image
    except ImportError:  # pragma: no cover - the caller checks first
        return None
    if not path.is_file():
        return None
    with Image.open(path) as image:
        data = np.asarray(image.convert("RGB"), dtype=np.float32)
    return [float(v) for v in data.reshape(-1, 3).mean(axis=0)]


def _layer_row(
    entry,
    palette: list[tint.Layer],
    *,
    settings: Settings,
    gloss: bool,
) -> dict:
    """One layer reference, resolved exactly as ``compose_layered`` resolves it.

    Both shapes are emitted from one pass. `tint` and `metal` are the *already
    resolved* values the CPU port consumes, so a harness reading them tests the
    compositing rules in isolation; `tint_color`, `palette_tint` and `response`
    are the raw inputs the shader takes, because on the GPU the palette is a
    live uniform and the resolution happens per pixel.
    """
    detail = layer_lib.load(settings.raw_dir, entry.path)
    metallic = bool(detail.is_metal) if detail is not None else bool(entry.metallic)

    if 0 < entry.palette_tint <= len(palette):
        chosen = palette[entry.palette_tint - 1]
        source = chosen.spec if metallic else chosen.color
        resolved = [
            tint.srgb_to_linear(source[i]) * entry.tint_color[i] for i in range(3)
        ]
    else:
        resolved = list(entry.tint_color)

    response = (1.0, 1.0, 1.0)
    if detail is not None:
        response = detail.specular if metallic else detail.diffuse
        resolved = [resolved[i] * response[i] for i in range(3)]

    gloss_path = None
    if gloss and detail is not None:
        try:
            found = layer_lib.gloss_for(
                detail,
                p4k=settings.p4k_path,
                starbreaker=Path(settings.starbreaker),
                cache_dir=settings.interim_dir / "gloss",
            )
            gloss_path = _rel(found) if found is not None else None
        except Exception as error:  # pragma: no cover - depends on the host
            log.debug("no gloss for %s: %s", entry.path, error)

    return {
        # Consumed by the CPU port.
        "tint": resolved,
        "metal": metallic,
        "uv_tiling": entry.uv_tiling,
        "tile_u": detail.tile_u if detail else 1.0,
        "diffuse": _rel(detail.diff) if detail and detail.diff else None,
        # Consumed by the shader, which resolves the palette per pixel.
        "layer_path": entry.path,
        "tint_color": list(entry.tint_color),
        "palette_tint": entry.palette_tint,
        "response": list(response),
        "shininess": detail.glossiness if detail else 0.5,
        "gloss_mult": entry.gloss_mult,
        "gloss": gloss_path,
    }


def build(
    settings: Settings,
    manifest: Manifest,
    *,
    gloss: bool = True,
    families: tuple[str, ...] = REFERENCE_FAMILIES,
) -> list[dict]:
    """Every submaterial of the reference items, with its inputs and its bake."""
    selection = select(manifest, families)
    rows: list[dict] = []

    for item in selection.items:
        palette = tint.layers_from_tint(item.tint) or tint.NEUTRAL_LAYERS
        for mtl in pipeline.discover_materials(settings, item):
            for sub in material.parse(mtl):
                if not sub.tintable or not sub.base_layers:
                    continue
                resolved = {}
                for role, reference in sub.textures.items():
                    path = pipeline.texture_on_disk(settings, reference)
                    if path is not None:
                        resolved[role] = str(path)

                base = Path(resolved.get("blend", mtl.stem)).stem or mtl.stem
                stem = f"{base}_{sub.name}"
                safe = tint.safe_stem(stem)
                key = tint.layered_key(sub, palette, True)
                baked = settings.interim_dir / "tint" / f"{safe}__{key}_albedo.png"
                orm = settings.interim_dir / "tint" / f"{safe}__{key}_orm.png"

                wear_pairs = sub.wear_pairs
                layer_rows = []
                for index, entry in enumerate(sub.base_layers[:4]):
                    row = _layer_row(entry, palette, settings=settings, gloss=gloss)
                    pair = wear_pairs[index] if index < len(wear_pairs) else None
                    row["worn"] = (
                        _layer_row(pair, palette, settings=settings, gloss=gloss)
                        if pair is not None
                        else None
                    )
                    layer_rows.append(row)

                rows.append(
                    {
                        "item": item.id,
                        "name": item.name,
                        # The colourway group. `colourways-identical` needs it:
                        # the invariant is about a family collapsing onto one
                        # colour, so the members have to be groupable.
                        "variant_of": item.variant_of or item.id,
                        "slot": item.slot,
                        "family": selection.matched.get(item.id, ""),
                        "sub": sub.name,
                        "mtl": _rel(mtl),
                        "baked": _rel(baked),
                        "baked_mean": _mean_rgb(baked),
                        "orm": _rel(orm),
                        "orm_mean": _mean_rgb(orm),
                        "blend": _rel(resolved.get("blend")),
                        "wear": _rel(resolved.get("wear")),
                        "hal": _rel(resolved.get("hal")),
                        "wear_threshold": tint.WEAR_THRESHOLD,
                        "wear_falloff": tint.WEAR_FALLOFF,
                        "palette": [
                            {
                                "color": list(entry.color),
                                "spec": list(entry.spec),
                                "glossiness": entry.glossiness,
                            }
                            for entry in palette[:3]
                        ],
                        "layers": layer_rows,
                    }
                )
    return rows


def write(settings: Settings, manifest: Manifest, out: Path, *, gloss: bool = True) -> int:
    rows = build(settings, manifest, gloss=gloss)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rows, indent=1))
    return len(rows)
