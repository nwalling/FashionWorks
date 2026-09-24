from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from sc_extract import dcb


class _Settings:
    def __init__(self, root: Path) -> None:
        self.dcb_dir = root / "dcb"
        self.p4k_path = root / "Data.p4k"


def _fake_extract(written: list[str]):
    def extract(settings, *, out_dir: Path, fmt: str = "json", filter_glob: str | None = None) -> Path:
        out_dir.mkdir(parents=True, exist_ok=True)
        name = f"record_{len(written)}.json"
        (out_dir / "libs").mkdir(exist_ok=True)
        (out_dir / "libs" / name).write_text("{}")
        written.append(name)
        return out_dir

    return extract


def test_a_new_archive_replaces_the_old_export_rather_than_adding_to_it(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    settings = _Settings(tmp_path)
    settings.p4k_path.write_bytes(b"old build")
    written: list[str] = []
    monkeypatch.setattr(dcb, "starbreaker_dcb_extract", _fake_extract(written))

    dcb.export(settings, filter_glob="**/a/**")
    assert (settings.dcb_dir / "libs" / "record_0.json").is_file()

    # A different archive: new size and mtime, so a new cache key.
    settings.p4k_path.write_bytes(b"a newer, longer build")
    os.utime(settings.p4k_path, (1_900_000_000, 1_900_000_000))
    dcb.export(settings, filter_glob="**/a/**")

    records = sorted(p.name for p in (settings.dcb_dir / "libs").iterdir())
    assert records == ["record_1.json"], "a record the new build dropped must not survive"
    stamp = json.loads((settings.dcb_dir / dcb.CACHE_FILE).read_text())
    assert stamp["p4k"] == str(settings.p4k_path)


def test_a_current_export_is_kept(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    settings = _Settings(tmp_path)
    settings.p4k_path.write_bytes(b"build")
    written: list[str] = []
    monkeypatch.setattr(dcb, "starbreaker_dcb_extract", _fake_extract(written))

    dcb.export(settings, filter_glob="**/a/**")
    dcb.export(settings, filter_glob="**/a/**")
    assert written == ["record_0.json"], "the second call should skip"


def test_a_directory_without_our_stamp_is_never_cleared(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    settings = _Settings(tmp_path)
    settings.p4k_path.write_bytes(b"build")
    settings.dcb_dir.mkdir()
    (settings.dcb_dir / "someone_elses.json").write_text("{}")
    monkeypatch.setattr(dcb, "starbreaker_dcb_extract", _fake_extract([]))

    dcb.export(settings, filter_glob="**/a/**")
    assert (settings.dcb_dir / "someone_elses.json").is_file()


class _LocSettings(_Settings):
    def __init__(self, root: Path) -> None:
        super().__init__(root)
        self.raw_dir = root / "raw"

    def localization_p4k_path(self) -> str:
        return "Data/Localization/english/global.ini"


def test_the_localization_table_follows_the_archive(tmp_path: Path) -> None:
    from sc_extract.cli import fresh_localization

    settings = _LocSettings(tmp_path)
    settings.p4k_path.write_bytes(b"old build")
    calls: list[str] = []

    def extract(settings, *, out_dir: Path, filter_glob: str, convert=None) -> Path:
        target = out_dir / "Data/Localization/english/global.ini"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f"table {len(calls)}")
        calls.append(filter_glob)
        return out_dir

    loc = fresh_localization(settings, extract)
    assert loc.read_text() == "table 0"
    fresh_localization(settings, extract)
    assert len(calls) == 1, "the same archive reuses the table"

    settings.p4k_path.write_bytes(b"a newer, longer build")
    os.utime(settings.p4k_path, (1_900_000_000, 1_900_000_000))
    assert fresh_localization(settings, extract).read_text() == "table 1", "a new archive re-extracts"


def test_an_unstamped_table_is_extracted_again(tmp_path: Path) -> None:
    # A table from before the stamp existed cannot say which build it came from.
    from sc_extract.cli import fresh_localization

    settings = _LocSettings(tmp_path)
    settings.p4k_path.write_bytes(b"build")
    old = settings.raw_dir / "Data/Localization/english/global.ini"
    old.parent.mkdir(parents=True)
    old.write_text("old table")

    def extract(settings, *, out_dir: Path, filter_glob: str, convert=None) -> Path:
        old.write_text("new table")
        return out_dir

    assert fresh_localization(settings, extract).read_text() == "new table"
