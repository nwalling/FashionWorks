"""Localization table (``global.ini``) parsing and key resolution.

``global.ini`` is a flat ``key=value`` file with no INI sections, UTF-8 with a
BOM, one entry per line. Values may contain ``=``; only the first one splits.
Keys appear in records prefixed with ``@`` (``@item_Name_foo``) but are stored
in the file without it.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from pathlib import Path

log = logging.getLogger(__name__)


class Localization:
    """A resolved ``key -> text`` table."""

    def __init__(self, table: dict[str, str] | None = None) -> None:
        self._table: dict[str, str] = dict(table or {})
        self.missing: set[str] = set()

    def __len__(self) -> int:
        return len(self._table)

    def __contains__(self, key: str) -> bool:
        return self._normalize(key) in self._table

    @staticmethod
    def _normalize(key: str) -> str:
        return key[1:] if key.startswith("@") else key

    def get(self, key: str | None, default: str | None = None) -> str | None:
        """Resolve ``@key`` to English text; records unresolved keys."""
        if not key:
            return default
        normalized = self._normalize(key)
        value = self._table.get(normalized)
        if value is None:
            # Keys are matched case-insensitively as a fallback: the DCB and the
            # ini file do not always agree on casing.
            value = self._lower_index().get(normalized.lower())
        if value is None:
            self.missing.add(key)
            return default
        return value

    def _lower_index(self) -> dict[str, str]:
        cached = getattr(self, "_lower_cache", None)
        if cached is None or len(cached) != len(self._table):
            cached = {k.lower(): v for k, v in self._table.items()}
            self._lower_cache = cached
        return cached

    @classmethod
    def from_lines(cls, lines: Iterable[str]) -> Localization:
        table: dict[str, str] = {}
        for raw in lines:
            line = raw.lstrip("﻿").strip()
            if not line or line.startswith((";", "#", "[")):
                continue
            key, sep, value = line.partition("=")
            if not sep:
                continue
            table[key.strip()] = value.strip()
        return cls(table)

    @classmethod
    def from_file(cls, path: Path) -> Localization:
        if not path.is_file():
            raise FileNotFoundError(f"localization file not found: {path}")
        # utf-8-sig strips the BOM; some builds ship cp1252 for a few lines.
        text = path.read_text(encoding="utf-8-sig", errors="replace")
        table = cls.from_lines(text.splitlines())
        log.info("loaded %d localization keys from %s", len(table), path)
        return table

    @classmethod
    def empty(cls) -> Localization:
        return cls({})
