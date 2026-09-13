"""Configuration loading.

Single source of truth for every path in the project. Layers, lowest first:

1. ``config/settings.toml``
2. ``config/settings.local.toml`` (gitignored, machine-specific)
3. environment variables ``SCX_<SECTION>_<KEY>``

Nothing else in this package may hardcode a filesystem path.
"""

from __future__ import annotations

import json
import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG_DIR = REPO_ROOT / "config"
DEFAULT_CONFIG = CONFIG_DIR / "settings.toml"
LOCAL_CONFIG = CONFIG_DIR / "settings.local.toml"

# Distinguishes "caller said nothing, use the default local file" from
# "caller explicitly said: no local override". Passing None used to mean the
# former, which silently leaked the developer's machine config into tests.
USE_DEFAULT_LOCAL = object()


class ConfigError(RuntimeError):
    """Raised when configuration is missing or internally inconsistent."""


def _deep_merge(base: dict[str, Any], over: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for key, value in over.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def _coerce(raw: str, current: Any) -> Any:
    """Coerce an environment string to the type of the value it overrides."""
    if isinstance(current, bool):
        return raw.strip().lower() in {"1", "true", "yes", "on"}
    if isinstance(current, int) and not isinstance(current, bool):
        return int(raw)
    if isinstance(current, list):
        return [part for part in (p.strip() for p in raw.split(os.pathsep)) if part]
    return raw


def _apply_env(data: dict[str, Any], environ: dict[str, str]) -> dict[str, Any]:
    """Apply ``SCX_<SECTION>_<KEY>`` overrides onto already-merged TOML data."""
    out = {section: dict(values) for section, values in data.items()}
    for section, values in data.items():
        if not isinstance(values, dict):
            continue
        for key, current in values.items():
            env_name = f"SCX_{section.upper()}_{key.upper()}"
            if env_name in environ:
                out[section][key] = _coerce(environ[env_name], current)
    return out


@dataclass(frozen=True)
class Settings:
    """Resolved project settings. All directory fields are absolute paths."""

    raw: dict[str, Any] = field(repr=False)

    # paths
    sc_root: Path | None
    data_dir: Path
    raw_dir: Path
    dcb_dir: Path
    interim_dir: Path
    out_dir: Path

    # tools
    starbreaker: str
    cgf_converter: str
    blender: str
    tool_search_dirs: tuple[Path, ...]
    blender_candidates: dict[str, list[str]]

    # extract
    locale: str
    localization_path: str
    character_root: str

    # catalog
    skeleton: str
    exclude_flags: tuple[str, ...]

    # convert
    jobs: int
    blender_batch_size: int
    draco: bool

    # viewer
    asset_base_url: str

    @property
    def p4k_path(self) -> Path | None:
        """Path to ``Data.p4k``, or None when no install is configured."""
        return None if self.sc_root is None else self.sc_root / "Data.p4k"

    def has_game_data(self) -> bool:
        p4k = self.p4k_path
        return p4k is not None and p4k.is_file()

    def item_dir(self, item_id: str) -> Path:
        return self.out_dir / "items" / item_id

    def base_dir(self) -> Path:
        return self.out_dir / "base"

    def manifest_path(self) -> Path:
        return self.out_dir / "manifest.json"

    def errors_path(self) -> Path:
        return self.out_dir / "errors.json"

    def localization_p4k_path(self) -> str:
        return self.localization_path.format(locale=self.locale)


def _abs(value: str, root: Path) -> Path:
    path = Path(value).expanduser()
    return path if path.is_absolute() else (root / path)


def load_settings(
    path: Path | None = None,
    *,
    local_path: Path | None | Any = USE_DEFAULT_LOCAL,
    environ: dict[str, str] | None = None,
    root: Path | None = None,
) -> Settings:
    """Load and resolve settings. Raises ConfigError if the base file is absent."""
    root = root or REPO_ROOT
    path = path or DEFAULT_CONFIG
    if local_path is USE_DEFAULT_LOCAL:
        local_path = LOCAL_CONFIG
    environ = os.environ if environ is None else environ

    if not path.is_file():
        raise ConfigError(f"missing config file: {path}")

    with path.open("rb") as handle:
        data: dict[str, Any] = tomllib.load(handle)

    if local_path and local_path.is_file():
        with local_path.open("rb") as handle:
            data = _deep_merge(data, tomllib.load(handle))

    data = _apply_env(data, dict(environ))

    paths = data.get("paths", {})
    tools = data.get("tools", {})
    extract = data.get("extract", {})
    catalog = data.get("catalog", {})
    convert = data.get("convert", {})
    viewer = data.get("viewer", {})

    sc_root_raw = str(paths.get("sc_root", "") or "").strip()

    return Settings(
        raw=data,
        sc_root=_abs(sc_root_raw, root) if sc_root_raw else None,
        data_dir=_abs(paths.get("data_dir", "data"), root),
        raw_dir=_abs(paths.get("raw_dir", "data/raw"), root),
        dcb_dir=_abs(paths.get("dcb_dir", "data/dcb"), root),
        interim_dir=_abs(paths.get("interim_dir", "data/interim"), root),
        out_dir=_abs(paths.get("out_dir", "data/out"), root),
        starbreaker=str(tools.get("starbreaker", "") or ""),
        cgf_converter=str(tools.get("cgf_converter", "") or ""),
        blender=str(tools.get("blender", "") or ""),
        tool_search_dirs=tuple(_abs(d, root) for d in tools.get("search_dirs", [])),
        blender_candidates=dict(tools.get("blender_candidates", {})),
        locale=str(extract.get("locale", "english")),
        localization_path=str(
            extract.get("localization_path", "Data/Localization/{locale}/global.ini")
        ),
        character_root=str(extract.get("character_root", "Data/Objects/Characters/Human")),
        skeleton=str(catalog.get("skeleton", "male")),
        exclude_flags=tuple(catalog.get("exclude_flags", [])),
        jobs=int(convert.get("jobs", 4)),
        blender_batch_size=int(convert.get("blender_batch_size", 20)),
        draco=bool(convert.get("draco", False)),
        asset_base_url=str(viewer.get("asset_base_url", "/assets")),
    )


def merge_sc_root(existing: str, sc_root: Path) -> str:
    """Return ``settings.local.toml`` text with ``paths.sc_root`` set.

    Preserves any other settings already in the file, and replaces an existing
    ``sc_root`` rather than appending a second one. Pure so it can be tested
    without touching the real config.
    """
    line = f'sc_root = "{sc_root}"'

    if not existing.strip():
        return f"[paths]\n{line}\n"

    lines = existing.splitlines()
    kept = [entry for entry in lines if not entry.strip().startswith("sc_root")]

    if any(entry.strip() == "[paths]" for entry in kept):
        out: list[str] = []
        for entry in kept:
            out.append(entry)
            if entry.strip() == "[paths]":
                out.append(line)
        return "\n".join(out).rstrip() + "\n"

    return "\n".join(kept).rstrip() + f"\n\n[paths]\n{line}\n"


def read_game_version(sc_root: Path | None) -> str | None:
    """Game version from ``build_manifest.id`` beside ``Data.p4k``.

    The file is JSON with a ``Data`` object holding ``Version`` and ``Branch``,
    e.g. ``1.0.191.55227`` on ``sc-alpha-4.10.0-hotfix``.
    """
    if sc_root is None:
        return None
    manifest = sc_root / "build_manifest.id"
    if not manifest.is_file():
        return None
    try:
        data = json.loads(manifest.read_text(encoding="utf-8-sig"))
    except (json.JSONDecodeError, OSError):
        return None
    body = data.get("Data") if isinstance(data, dict) else None
    if not isinstance(body, dict):
        return None
    version = str(body.get("Version") or "").strip()
    branch = str(body.get("Branch") or "").strip()
    if version and branch:
        return f"{version} ({branch})"
    return version or branch or None
