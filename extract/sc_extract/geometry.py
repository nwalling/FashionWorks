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


# CryEngine splits a mesh across a header and a data file. The DataCore names
# only the header, but conversion needs both. Verified in build 1.0.191.55227:
# .skin/.skinm (3450 pairs in the male armor tree), .cgf/.cgfm, .cga/.cgam.
MESH_DATA_SIBLING = {".skin": ".skinm", ".cgf": ".cgfm", ".cga": ".cgam"}


def mesh_siblings(source: str) -> list[str]:
    """The header path plus its mesh-data sibling, when it has one."""
    out = [source]
    for header, data in MESH_DATA_SIBLING.items():
        if source.lower().endswith(header):
            out.append(source[: -len(header)] + data)
            break
    return out


def asset_sources(item: Item, *, speculative: bool = True) -> list[str]:
    """Every P4K path this item needs: geometry, mesh data, and materials.

    ``speculative`` adds a ``.mtl`` guessed from each mesh's stem, for records
    that name no material. Those guesses frequently do not exist, so callers
    deciding *whether extraction is still outstanding* must pass
    ``speculative=False``: otherwise a path that can never appear keeps looking
    like missing work and the P4K is rescanned on every run.
    """
    sources: list[str] = []
    for geo in item.geometry:
        for path in mesh_siblings(geo.source):
            if path not in sources:
                sources.append(path)

    for material in item.materials:
        if material and material not in sources:
            sources.append(material)

    if speculative:
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
