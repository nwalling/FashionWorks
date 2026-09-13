"""Conversion orchestration: parallelism, batching and incremental hashing.

PLAN.md §4.4. Cgf-Converter runs once per source mesh; Blender runs once per
batch of items so its ~2s startup is amortized.
"""

from __future__ import annotations

import hashlib
import json
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path

from .config import REPO_ROOT, Settings
from .manifest import Item, Manifest
from .tools import ToolError, blender_run, cgf_convert, starbreaker_p4k_extract

log = logging.getLogger(__name__)

BLENDER_DIR = REPO_ROOT / "blender"
NORMALIZE_SCRIPT = BLENDER_DIR / "normalize_armor.py"


@dataclass
class ConvertResult:
    ok: int = 0
    skipped: int = 0
    errors: dict[str, str] = field(default_factory=dict)


def input_hash(settings: Settings, item: Item) -> str:
    """Hash of every input that affects this item's GLB."""
    digest = hashlib.sha256()
    digest.update(item.class_name.encode())
    digest.update(str(settings.draco).encode())
    for source in [g.source for g in item.geometry] + list(item.materials):
        path = settings.raw_dir / source
        digest.update(source.encode())
        if path.is_file():
            stat = path.stat()
            digest.update(f"{stat.st_size}:{int(stat.st_mtime)}".encode())
    for script in (NORMALIZE_SCRIPT,):
        if script.is_file():
            digest.update(str(int(script.stat().st_mtime)).encode())
    return digest.hexdigest()[:32]


def is_current(settings: Settings, item: Item) -> bool:
    """True when item.glb exists and its inputs are unchanged."""
    out_dir = settings.item_dir(item.id)
    glb = out_dir / "item.glb"
    sidecar = out_dir / ".hash"
    if not (glb.is_file() and sidecar.is_file()):
        return False
    return sidecar.read_text().strip() == input_hash(settings, item)


def raw_path(settings: Settings, source: str) -> Path | None:
    """Resolve a P4K source path to the extracted file on disk.

    The DataCore spells paths without the leading ``Data/`` and with
    inconsistent case, while extraction writes ``data/raw/Data/Objects/...``.
    macOS is case-insensitive so the direct join usually hits; the glob is the
    fallback for case-sensitive filesystems.
    """
    base = settings.raw_dir / "Data"
    direct = base / source
    if direct.is_file():
        return direct
    stem = Path(source).name
    for candidate in base.rglob(stem):
        if candidate.is_file():
            return candidate
    lowered = stem.lower()
    for candidate in base.rglob("*"):
        if candidate.is_file() and candidate.name.lower() == lowered:
            return candidate
    return None


def ensure_extracted(settings: Settings, items: list[Item], *, textures: bool = True) -> int:
    """Extract every raw asset the given items need, in one pass per prefix."""
    from . import geometry as geometry_mod

    wanted: list[str] = []
    for item in items:
        for source in geometry_mod.asset_sources(item):
            if raw_path(settings, source) is None and source not in wanted:
                wanted.append(source)
    if not wanted:
        return 0

    # One extraction call per directory beats one per file: the P4K is scanned
    # once per call, and on an SD card that dominates.
    prefixes = sorted({str(Path(s).parent) for s in wanted})
    converters = ["cryxml", "dds-png"] if textures else ["cryxml"]
    for prefix in prefixes:
        try:
            starbreaker_p4k_extract(
                settings, out_dir=settings.raw_dir, filter_glob=f"**/{prefix}/**",
                convert=converters,
            )
        except ToolError as exc:
            log.warning("extraction failed for %s: %s", prefix, exc)
    return len(wanted)


def ensure_converted(settings: Settings, item: Item, *, fmt: str = "dae") -> list[Path]:
    """Convert an item's meshes to Collada, skipping ones already converted.

    Collada, not glTF: Blender ignores cgf-converter's glTF inverse bind
    matrices and the mesh lands off the body. See blender/normalize_armor.py.
    """
    out: list[Path] = []
    for geo in item.geometry:
        stem = Path(geo.source).stem
        target = settings.interim_dir / f"{stem}.{fmt}"
        if target.is_file():
            out.append(target)
            continue
        source = raw_path(settings, geo.source)
        if source is None:
            log.warning("no extracted mesh for %s", geo.source)
            continue
        try:
            out.append(
                cgf_convert(
                    settings,
                    source,
                    out_dir=settings.interim_dir,
                    fmt=fmt,
                    data_dir=settings.raw_dir / "Data",
                )
            )
        except ToolError as exc:
            log.warning("conversion failed for %s: %s", source.name, exc)
    return out


def _batches(items: list[Item], size: int) -> list[list[Item]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def _run_batch(settings: Settings, batch: list[Item], *, draco: bool) -> dict[str, str]:
    """Normalize one batch in a single Blender process. Returns id -> error."""
    spec = {
        "out_dir": str(settings.out_dir),
        "interim_dir": str(settings.interim_dir),
        "raw_dir": str(settings.raw_dir),
        "base_dir": str(settings.base_dir()),
        "skeleton": settings.skeleton,
        "draco": draco,
        "items": [
            {
                "id": item.id,
                "class_name": item.class_name,
                "slot": item.slot,
                "bind_mode": item.bind_mode,
                "socket": item.socket,
                "geometry": [{"source": g.source, "side": g.side} for g in item.geometry],
                "materials": list(item.materials),
                "tint": item.tint,
            }
            for item in batch
        ],
    }
    spec_path = settings.interim_dir / f"batch-{batch[0].id}.json"
    spec_path.parent.mkdir(parents=True, exist_ok=True)
    spec_path.write_text(json.dumps(spec, indent=2))

    try:
        blender_run(settings, NORMALIZE_SCRIPT, args=["--spec", str(spec_path)], timeout=1800)
    except ToolError as exc:
        return {item.id: str(exc) for item in batch}

    errors: dict[str, str] = {}
    for item in batch:
        glb = settings.item_dir(item.id) / "item.glb"
        if glb.is_file():
            (settings.item_dir(item.id) / ".hash").write_text(input_hash(settings, item))
        else:
            errors[item.id] = "blender produced no item.glb"
    return errors


def refresh_assets(settings: Settings, manifest: Manifest | None = None) -> int:
    """Point manifest ``assets.glb`` at the item GLBs that exist on disk.

    Colour variants share their canonical item's geometry and differ only by
    tint, so a variant with no GLB of its own borrows the canonical one. That
    is what makes the swatch row in the viewer work without converting the same
    mesh a dozen times.

    Returns how many items are renderable, and fills in each skeleton's base GLB.
    """
    manifest = manifest or Manifest.read(settings.manifest_path())

    for item in manifest.items:
        glb = settings.item_dir(item.id) / "item.glb"
        item.assets.glb = f"items/{item.id}/item.glb" if glb.is_file() else None

    by_id = manifest.by_id()
    for item in manifest.items:
        if item.assets.glb is None and item.variant_of:
            canonical = by_id.get(item.variant_of)
            if canonical is not None and canonical.assets.glb:
                item.assets.glb = canonical.assets.glb
                # The mesh decides how it attaches, so inherit that too.
                item.bind_mode = canonical.bind_mode
                item.socket = canonical.socket

    for name, skeleton in manifest.skeletons.items():
        base = settings.base_dir() / f"{name}.glb"
        skeleton.glb = f"base/{name}.glb" if base.is_file() else None

    manifest.write(settings.manifest_path())
    return sum(1 for item in manifest.items if item.assets.glb)


def convert(
    settings: Settings,
    *,
    slot: str | None = None,
    item_id: str | None = None,
    set_keys: list[str] | None = None,
    canonical_only: bool = True,
    jobs: int = 4,
    draco: bool = False,
) -> ConvertResult:
    """Convert manifest items to normalized GLBs, in parallel batches."""
    manifest = Manifest.read(settings.manifest_path())
    items = manifest.items
    if item_id:
        items = [i for i in items if i.id == item_id]
    else:
        if set_keys:
            wanted = set(set_keys)
            items = [i for i in items if i.set in wanted]
        if slot:
            items = [i for i in items if i.slot == slot]
        if canonical_only:
            # Variants share geometry with their canonical item and differ only
            # by tint, so converting them duplicates meshes for nothing.
            items = [i for i in items if i.variant_of is None]
        items = [i for i in items if i.geometry]

    result = ConvertResult()
    pending: list[Item] = []
    for item in items:
        if is_current(settings, item):
            result.skipped += 1
        else:
            pending.append(item)

    log.info("%d items pending, %d already current", len(pending), result.skipped)

    if pending:
        ensure_extracted(settings, pending)
        for item in pending:
            ensure_converted(settings, item)

    batches = _batches(pending, max(1, settings.blender_batch_size))
    if batches:
        with ThreadPoolExecutor(max_workers=max(1, jobs)) as pool:
            futures = {pool.submit(_run_batch, settings, b, draco=draco): b for b in batches}
            for future in as_completed(futures):
                batch = futures[future]
                try:
                    errors = future.result()
                except Exception as exc:  # noqa: BLE001 - record, do not abort the run
                    errors = {item.id: repr(exc) for item in batch}
                result.errors.update(errors)
                result.ok += len(batch) - len(errors)

    refresh_assets(settings, manifest)

    if result.errors:
        settings.errors_path().parent.mkdir(parents=True, exist_ok=True)
        settings.errors_path().write_text(json.dumps({"convert": result.errors}, indent=2))
    return result
