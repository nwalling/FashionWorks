from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from sc_extract.dcb import Index
from sc_extract.localization import Localization

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def dcb_dir(tmp_path: Path) -> Path:
    """A DCB export directory holding the fixture records."""
    target = tmp_path / "dcb"
    target.mkdir()
    shutil.copy(FIXTURES / "armor_records.json", target / "armor_records.json")
    return target


@pytest.fixture
def index(dcb_dir: Path) -> Index:
    return Index.load(dcb_dir)


@pytest.fixture
def loc() -> Localization:
    return Localization.from_file(FIXTURES / "global.ini")


@pytest.fixture
def records() -> list[dict]:
    return json.loads((FIXTURES / "armor_records.json").read_text())
