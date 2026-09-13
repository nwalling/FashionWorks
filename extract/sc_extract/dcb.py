"""DataCore (DCB) export and record indexing.

StarBreaker exports the DataCore as a tree of JSON files. This module owns the
export cache and builds an in-memory index so the catalog stage can resolve
record references without rescanning the tree.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Iterator
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


def export(settings: Settings, *, filter_glob: str | None = None, force: bool = False) -> Path:
    """Export the DCB to ``dcb_dir``, skipping if the cached export is current.

    The cache key is the P4K's size and mtime, per PLAN.md §3.1.
    """
    out_dir = settings.dcb_dir
    p4k = settings.p4k_path
    if p4k is None or not p4k.is_file():
        raise FileNotFoundError(
            "no Data.p4k available; set paths.sc_root in config/settings.local.toml"
        )

    key = _cache_key(p4k)
    cache_path = out_dir / CACHE_FILE
    if not force and cache_path.is_file():
        try:
            cached = json.loads(cache_path.read_text())
        except json.JSONDecodeError:
            cached = {}
        if cached.get("key") == key and cached.get("filter") == filter_glob:
            log.info("DCB export is current (key=%s); skipping", key)
            return out_dir

    starbreaker_dcb_extract(settings, out_dir=out_dir, fmt="json", filter_glob=filter_glob)
    out_dir.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(
        json.dumps({"key": key, "filter": filter_glob, "p4k": str(p4k)}, indent=2)
    )
    return out_dir


def iter_json(root: Path) -> Iterator[Path]:
    """Yield every exported record file under ``root``, cache file excluded."""
    for path in sorted(root.rglob("*.json")):
        if path.name == CACHE_FILE:
            continue
        yield path


def _record_id(data: dict[str, Any], path: Path) -> str:
    value = F.first(data, F.RECORD_ID)
    if isinstance(value, dict):
        value = value.get("value") or value.get("__ref")
    if isinstance(value, str) and value.strip("{} 0-"):
        return value.strip("{}")
    # No usable GUID in the export: fall back to the path, which is stable.
    return path.stem


def _class_name(data: dict[str, Any], path: Path) -> str:
    value = F.first(data, F.CLASS_NAME)
    return value if isinstance(value, str) and value else path.stem


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
        """Resolve a record reference, which may be a GUID string or a dict."""
        if isinstance(ref, dict):
            ref = ref.get("__ref") or ref.get("value") or ref.get("Reference")
        if not isinstance(ref, str):
            return None
        key = ref.strip("{}")
        return self.by_id.get(key) or self.by_class.get(key.lower())

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
