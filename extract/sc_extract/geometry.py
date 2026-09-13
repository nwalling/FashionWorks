"""Raw asset extraction from the P4K for catalog items (PLAN.md §4.1-4.2)."""

from __future__ import annotations

import logging
import re
from pathlib import Path

from .config import Settings
from .manifest import Item, Manifest
from .tools import cgf_convert, starbreaker_p4k_extract

log = logging.getLogger(__name__)

# Texture references inside a .mtl, e.g. <Texture Map="Diffuse" File="path/x_diff.dds"/>
_TEXTURE_REF = re.compile(r'File\s*=\s*"([^"]+)"', re.IGNORECASE)

_SEPARATORS = re.compile(r"[\\/]+")


def _normalize(path: str) -> str:
    """Windows separators to POSIX, collapsing repeats and any leading slash."""
    return _SEPARATORS.sub("/", path).lstrip("/")


def asset_sources(item: Item) -> list[str]:
    """Every P4K path this item needs: geometry plus its materials."""
    sources = [g.source for g in item.geometry]
    sources += [m for m in item.materials if m]
    # A .skin sits beside a .mtl of the same stem when the record omits it.
    for geo in item.geometry:
        implied = re.sub(r"\.(skin|cgf|chr|cga)$", ".mtl", geo.source, flags=re.IGNORECASE)
        if implied != geo.source and implied not in sources:
            sources.append(implied)
    return sources


def common_prefix_filter(paths: list[str]) -> str:
    """Build one P4K glob covering ``paths``, to avoid N extraction calls."""
    if not paths:
        return ""
    if len(paths) == 1:
        return paths[0]
    split = [p.split("/") for p in paths]
    prefix: list[str] = []
    for parts in zip(*split, strict=False):
        if len(set(parts)) == 1:
            prefix.append(parts[0])
        else:
            break
    return "/".join(prefix) + "/**" if prefix else "**"


def textures_referenced(mtl_path: Path) -> list[str]:
    """Parse a converted .mtl for the texture files it references."""
    if not mtl_path.is_file():
        return []
    text = mtl_path.read_text(encoding="utf-8", errors="replace")
    out: list[str] = []
    for match in _TEXTURE_REF.finditer(text):
        value = _normalize(match.group(1))
        if value and value not in out:
            out.append(value)
    return out


def extract_item(settings: Settings, item: Item) -> list[Path]:
    """Extract one item's geometry and materials into ``raw_dir``."""
    sources = asset_sources(item)
    if not sources:
        log.warning("item %s (%s) has no geometry to extract", item.id, item.class_name)
        return []
    starbreaker_p4k_extract(
        settings, out_dir=settings.raw_dir, filter_glob=common_prefix_filter(sources)
    )
    return [settings.raw_dir / s for s in sources if (settings.raw_dir / s).is_file()]


def extract_manifest(settings: Settings, manifest: Manifest, *, slot: str | None = None) -> int:
    """Extract raw assets for every item (optionally one slot). Returns count."""
    items = [i for i in manifest.items if slot is None or i.slot == slot]
    all_sources: list[str] = []
    for item in items:
        all_sources.extend(asset_sources(item))
    if not all_sources:
        return 0
    # One extraction pass over the shared prefix beats one call per item.
    starbreaker_p4k_extract(
        settings, out_dir=settings.raw_dir, filter_glob=common_prefix_filter(all_sources)
    )
    return len(all_sources)


def convert_geometry(settings: Settings, source: Path, *, fmt: str = "gltf") -> Path:
    """Run Cgf-Converter on one .skin/.chr into ``interim_dir``."""
    relative = (
        source.relative_to(settings.raw_dir)
        if source.is_relative_to(settings.raw_dir)
        else Path(source.name)
    )
    out_dir = settings.interim_dir / relative.parent
    return cgf_convert(settings, source, out_dir=out_dir, fmt=fmt, data_dir=settings.raw_dir)
