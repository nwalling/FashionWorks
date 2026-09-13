"""DataCore (DCB) export and record indexing.

StarBreaker exports the DataCore as a tree of JSON files. This module owns the
export cache and builds an in-memory index so the catalog stage can resolve
record references without rescanning the tree.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import fields as F
from .config import Settings
from .tools import starbreaker_dcb_extract

log = logging.getLogger(__name__)

CACHE_FILE = ".dcb-export.json"


@dataclass
class Record:
    """One DataCore record, with its source file."""

    id: str
    class_name: str
    path: Path
    data: dict[str, Any] = field(repr=False)

    def get(self, paths: list[str], default: Any = None) -> Any:
        return F.first(self.data, paths, default)


def _cache_key(p4k: Path) -> str:
    stat = p4k.stat()
    digest = hashlib.sha256(f"{p4k}|{stat.st_size}|{int(stat.st_mtime)}".encode()).hexdigest()
    return digest[:16]


# Record paths the catalog needs. StarBreaker's DCB filter matches the record's
# own path, so each pattern must lead with "**/".
DEFAULT_FILTERS = (
    "**/entities/scitem/characters/human/**",  # the wearables themselves
    "**/scitemmanufacturer/**",  # manufacturer codes and names
    "**/tintpalettes/**",  # per-item colour palettes
)


def export(
    settings: Settings,
    *,
    filter_glob: str | Sequence[str] | None = None,
    force: bool = False,
) -> Path:
    """Export the DCB to ``dcb_dir``, skipping if the cached export is current.

    The cache key is the P4K's size and mtime (PLAN.md §3.1). ``filter_glob``
    may be one pattern or several; the tool takes a single ``--filter``, so
    several patterns mean several passes into the same directory.
    """
    out_dir = settings.dcb_dir
    p4k = settings.p4k_path
    if p4k is None or not p4k.is_file():
        raise FileNotFoundError(
            "no Data.p4k available; set paths.sc_root in config/settings.local.toml"
        )

    if filter_glob is None:
        filters: list[str | None] = list(DEFAULT_FILTERS)
    elif isinstance(filter_glob, str):
        filters = [filter_glob]
    else:
        filters = list(filter_glob) or [None]

    key = _cache_key(p4k)
    cache_path = out_dir / CACHE_FILE
    if not force and cache_path.is_file():
        try:
            cached = json.loads(cache_path.read_text())
        except json.JSONDecodeError:
            cached = {}
        if cached.get("key") == key and cached.get("filters") == filters:
            log.info("DCB export is current (key=%s); skipping", key)
            return out_dir

    for pattern in filters:
        starbreaker_dcb_extract(settings, out_dir=out_dir, fmt="json", filter_glob=pattern)

    out_dir.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps({"key": key, "filters": filters, "p4k": str(p4k)}, indent=2))
    return out_dir


def iter_json(root: Path) -> Iterator[Path]:
    """Yield every exported record file under ``root``, cache file excluded."""
    for path in sorted(root.rglob("*.json")):
        if path.name == CACHE_FILE:
            continue
        yield path


def _record_id(data: dict[str, Any], path: Path) -> str:
    """Prefer the DataCore GUID; fall back to the file stem, which is stable."""
    value = data.get(F.RECORD_ID) if isinstance(data, dict) else None
    if isinstance(value, dict):
        value = value.get("value") or value.get("__ref")
    if isinstance(value, str) and value.strip("{} 0-"):
        return value.strip("{}")
    legacy = F.first(data, ["__ref", "Reference", "reference", "id", "GUID", "guid"])
    if isinstance(legacy, str) and legacy.strip("{} 0-"):
        return legacy.strip("{}")
    return path.stem


def _class_name(data: dict[str, Any], path: Path) -> str:
    """``_RecordName_`` minus its type prefix, e.g. ``cds_combat_light_helmet_01``."""
    name = F.class_name_of(data)
    if name:
        return name
    legacy = F.first(data, ["ClassName", "className", "Name", "name"])
    return legacy if isinstance(legacy, str) and legacy else path.stem


class Index:
    """Records keyed by id and by class name."""

    def __init__(self) -> None:
        self.by_id: dict[str, Record] = {}
        self.by_class: dict[str, Record] = {}
        self.records: list[Record] = []

    def __len__(self) -> int:
        return len(self.records)

    def add(self, record: Record) -> None:
        self.records.append(record)
        self.by_id.setdefault(record.id, record)
        self.by_class.setdefault(record.class_name.lower(), record)

    def resolve_ref(self, ref: Any) -> Record | None:
        """Resolve a record reference.

        References in this build are relative ``file://`` URLs into the foundry
        record tree, e.g.::

            file://./../../libs/foundry/records/scitemmanufacturer/armor/scitemmanufacturer.cds.json

        The filename is ``<record type>.<record name>.json``, so the name is
        what follows the first dot. GUIDs and bare names are still accepted.
        """
        if isinstance(ref, dict):
            ref = ref.get("__ref") or ref.get("value") or ref.get("Reference")
        if not isinstance(ref, str) or not ref.strip():
            return None

        name = self.ref_name(ref)
        if name is None:
            return None
        return self.by_id.get(name) or self.by_class.get(name.lower())

    @staticmethod
    def ref_name(ref: str) -> str | None:
        """The record name a reference points at, or None."""
        value = ref.strip()
        if value.startswith("file://"):
            stem = value.rsplit("/", 1)[-1]
            stem = stem[: -len(".json")] if stem.lower().endswith(".json") else stem
            # "<type>.<name>" -> "<name>"; a name may itself contain dots.
            return stem.split(".", 1)[1] if "." in stem else stem
        return value.strip("{}") or None

    @classmethod
    def load(cls, root: Path, *, limit: int | None = None) -> Index:
        index = cls()
        count = 0
        for path in iter_json(root):
            try:
                data = json.loads(path.read_text(encoding="utf-8-sig"))
            except (json.JSONDecodeError, OSError) as exc:
                log.warning("skipping unreadable record %s: %s", path, exc)
                continue
            # A bulk export may wrap many records in one file.
            payloads = data if isinstance(data, list) else [data]
            for payload in payloads:
                if not isinstance(payload, dict):
                    continue
                index.add(
                    Record(
                        id=_record_id(payload, path),
                        class_name=_class_name(payload, path),
                        path=path,
                        data=payload,
                    )
                )
                count += 1
                if limit and count >= limit:
                    log.info("loaded %d records (limit reached)", count)
                    return index
        log.info("loaded %d records from %s", count, root)
        return index
