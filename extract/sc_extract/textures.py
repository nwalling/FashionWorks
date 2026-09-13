"""Texture handling: split-mip DDS merge, PNG conversion, dedupe (PLAN.md §4.1).

StarEngine ships each DDS as a base file plus numbered mip files
(``x_diff.dds``, ``x_diff.dds.1`` ...). They must be merged before any normal
image tool can read them; StarBreaker does the merge and the PNG conversion.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from .config import Settings
from .tools import ToolMissing, starbreaker_dds_to_png, starbreaker_dds_to_png_all

log = logging.getLogger(__name__)

_MIP_SUFFIX = re.compile(r"\.dds\.\d+[ab]?$", re.IGNORECASE)

# StarEngine texture channel suffixes -> the PBR role they map to (PLAN.md §4.3).
CHANNEL_ROLES: dict[str, str] = {
    "_diff": "base_color",
    "_ddna": "normal_gloss",
    "_spec": "specular",
    "_disp": "displacement",
    "_blend": "blend",
    "_mask": "tint_mask",
    "_emis": "emissive",
}


def channel_role(path: str) -> str | None:
    """Classify a texture path by its filename suffix."""
    stem = Path(path).name.lower()
    stem = _MIP_SUFFIX.sub("", stem)
    stem = stem.removesuffix(".dds")
    for suffix, role in CHANNEL_ROLES.items():
        if stem.endswith(suffix):
            return role
    return None


def base_dds(path: Path) -> Path:
    """Return the base .dds for a numbered mip file."""
    name = _MIP_SUFFIX.sub(".dds", path.name)
    return path.with_name(name)


def group_mips(paths: list[Path]) -> dict[Path, list[Path]]:
    """Group split-mip files under their base .dds."""
    groups: dict[Path, list[Path]] = {}
    for path in paths:
        groups.setdefault(base_dds(path), []).append(path)
    return groups


def merge_and_convert(settings: Settings, dds: Path, *, out_dir: Path) -> Path:
    """Convert one already-extracted DDS to PNG. Returns the PNG path.

    StarBreaker's ``dds to-png`` merges split mips itself, so there is no
    separate merge call for the single-file path.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    return starbreaker_dds_to_png(settings, dds, out_dir / f"{dds.stem}.png")


def convert_all(settings: Settings, *, out_dir: Path | None = None) -> list[Path]:
    """Convert every DDS under ``raw_dir`` to PNG in ``interim_dir/textures``.

    Textures are shared heavily between items, so they are deduped by their
    path relative to ``raw_dir`` rather than copied per item.
    """
    out_dir = out_dir or (settings.interim_dir / "textures")
    candidates = [p for p in settings.raw_dir.rglob("*.dds") if not _MIP_SUFFIX.search(p.name)]
    if not candidates:
        log.info("no DDS files under %s", settings.raw_dir)
        return []

    # One batch call beats one process per texture; fall back to per-file so a
    # single bad texture cannot lose the whole run.
    try:
        starbreaker_dds_to_png_all(settings, settings.raw_dir, out_dir)
        written = sorted(out_dir.rglob("*.png"))
        if written:
            log.info("converted %d textures in batch", len(written))
            return written
    except ToolMissing:
        raise
    except Exception as exc:  # noqa: BLE001 - fall through to the per-file path
        log.warning("batch texture conversion failed (%s); retrying per file", exc)

    written = []
    for dds in candidates:
        target = out_dir / dds.relative_to(settings.raw_dir).with_suffix(".png")
        if target.is_file():
            written.append(target)
            continue
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            merge_and_convert(settings, dds, out_dir=target.parent)
            written.append(target)
        except ToolMissing:
            raise
        except Exception as exc:  # noqa: BLE001 - one bad texture must not stop the run
            log.warning("texture conversion failed for %s: %s", dds, exc)
    log.info("converted %d textures", len(written))
    return written
