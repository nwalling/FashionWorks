from __future__ import annotations

from pathlib import Path

import pytest

from sc_extract.config import ConfigError, load_settings

BASE = """
[paths]
sc_root = ""
out_dir = "data/out"
[tools]
starbreaker = "starbreaker"
blender = ""
search_dirs = ["tools/bin"]
[convert]
jobs = 4
draco = false
"""


def write(path: Path, text: str) -> Path:
    path.write_text(text)
    return path


def test_missing_config_raises(tmp_path: Path) -> None:
    with pytest.raises(ConfigError):
        load_settings(tmp_path / "nope.toml")


def test_relative_paths_resolve_against_root(tmp_path: Path) -> None:
    config = write(tmp_path / "settings.toml", BASE)
    settings = load_settings(config, local_path=None, environ={}, root=tmp_path)
    assert settings.out_dir == tmp_path / "data" / "out"
    assert settings.sc_root is None
    assert settings.has_game_data() is False


def test_local_file_overrides_base(tmp_path: Path) -> None:
    config = write(tmp_path / "settings.toml", BASE)
    local = write(tmp_path / "local.toml", '[paths]\nsc_root = "/games/SC/LIVE"\n')
    settings = load_settings(config, local_path=local, environ={}, root=tmp_path)
    assert settings.sc_root == Path("/games/SC/LIVE")
    assert settings.p4k_path == Path("/games/SC/LIVE/Data.p4k")


def test_env_overrides_and_coerces_types(tmp_path: Path) -> None:
    config = write(tmp_path / "settings.toml", BASE)
    settings = load_settings(
        config,
        local_path=None,
        environ={"SCX_CONVERT_JOBS": "12", "SCX_CONVERT_DRACO": "true", "SCX_PATHS_SC_ROOT": "/x"},
        root=tmp_path,
    )
    assert settings.jobs == 12
    assert settings.draco is True
    assert settings.sc_root == Path("/x")


def test_derived_paths(tmp_path: Path) -> None:
    config = write(tmp_path / "settings.toml", BASE)
    settings = load_settings(config, local_path=None, environ={}, root=tmp_path)
    assert settings.manifest_path().name == "manifest.json"
    assert settings.item_dir("abc").name == "abc"
    assert settings.localization_p4k_path() == "Data/Localization/english/global.ini"
