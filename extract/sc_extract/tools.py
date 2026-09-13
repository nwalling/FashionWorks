"""External tool discovery and invocation.

Wraps the three binaries the pipeline shells out to: StarBreaker (P4K + DCB +
DDS), Cgf-Converter (CryEngine geometry -> glTF/Collada) and Blender (headless
normalization). Every tool is resolved through :mod:`sc_extract.config`; none of
them is looked up by a hardcoded path here.

Resolution order for a tool named ``foo``:

1. the configured value, if it is an existing absolute path
2. ``shutil.which`` on PATH
3. each ``tools.search_dirs`` entry, plus a ``.exe`` variant on Windows
4. per-platform candidates (Blender only)
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from .config import Settings

log = logging.getLogger(__name__)

PLATFORM = {"darwin": "darwin", "win32": "windows"}.get(sys.platform, "linux")


class ToolError(RuntimeError):
    """A tool is missing, or exited non-zero."""


class ToolMissing(ToolError):
    """A required tool could not be resolved on this host."""


@dataclass(frozen=True)
class ToolStatus:
    name: str
    path: Path | None
    configured: str
    version: str | None = None
    note: str = ""

    @property
    def available(self) -> bool:
        return self.path is not None


def _candidates(name: str, configured: str, settings: Settings) -> list[Path]:
    out: list[Path] = []
    if configured:
        cfg = Path(configured).expanduser()
        if cfg.is_absolute():
            out.append(cfg)
        else:
            found = shutil.which(configured)
            if found:
                out.append(Path(found))
            for directory in settings.tool_search_dirs:
                out.append(directory / configured)
                if PLATFORM == "windows":
                    out.append(directory / f"{configured}.exe")
    if name == "blender" and not configured:
        for value in settings.blender_candidates.get(PLATFORM, []):
            out.append(Path(value).expanduser())
        found = shutil.which("blender")
        if found:
            out.append(Path(found))
    return out


def resolve(name: str, settings: Settings) -> Path | None:
    """Return the executable path for ``name``, or None when unavailable."""
    configured = {
        "starbreaker": settings.starbreaker,
        "cgf-converter": settings.cgf_converter,
        "blender": settings.blender,
    }.get(name)
    if configured is None:
        raise ValueError(f"unknown tool: {name}")

    for candidate in _candidates(name, configured, settings):
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    return None


def require(name: str, settings: Settings) -> Path:
    path = resolve(name, settings)
    if path is None:
        raise ToolMissing(
            f"{name!r} is not available on this host. "
            f"Set tools.{name.replace('-', '_')} in config/settings.local.toml, "
            f"or drop the binary in one of: "
            f"{', '.join(str(d) for d in settings.tool_search_dirs) or '(no search dirs)'}. "
            f"Run `scx doctor` for a full report."
        )
    return path


def _probe_version(name: str, path: Path) -> str | None:
    args = {
        "blender": ["--version"],
        "starbreaker": ["--version"],
        "cgf-converter": ["--version"],
    }[name]
    try:
        proc = subprocess.run(  # noqa: S603
            [str(path), *args], capture_output=True, text=True, timeout=30, check=False
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return f"probe failed: {exc}"
    text = (proc.stdout or proc.stderr).strip()
    return text.splitlines()[0] if text else None


def status(settings: Settings, *, probe: bool = True) -> list[ToolStatus]:
    """Resolve every tool and report what is available on this host."""
    configured = {
        "starbreaker": settings.starbreaker,
        "cgf-converter": settings.cgf_converter,
        "blender": settings.blender,
    }
    out: list[ToolStatus] = []
    for name, cfg in configured.items():
        path = resolve(name, settings)
        version = _probe_version(name, path) if (path and probe) else None
        out.append(ToolStatus(name=name, path=path, configured=cfg, version=version))
    return out


def run(
    argv: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    timeout: float | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    """Run a subprocess with logging. Raises ToolError on non-zero exit."""
    printable = " ".join(str(a) for a in argv)
    log.info("run: %s", printable)
    started = time.monotonic()
    try:
        proc = subprocess.run(  # noqa: S603
            [str(a) for a in argv],
            cwd=str(cwd) if cwd else None,
            env={**os.environ, **(env or {})} if env else None,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:
        raise ToolMissing(f"executable not found: {argv[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise ToolError(f"timed out after {timeout}s: {printable}") from exc

    elapsed = time.monotonic() - started
    log.debug("exit=%s in %.1fs", proc.returncode, elapsed)
    if proc.stdout:
        log.debug("stdout: %s", proc.stdout.strip()[:4000])
    if proc.returncode != 0:
        log.warning("stderr: %s", (proc.stderr or "").strip()[:4000])
        if check:
            raise ToolError(
                f"{argv[0]} exited {proc.returncode}\n"
                f"  cmd: {printable}\n"
                f"  stderr: {(proc.stderr or '').strip()[:2000]}"
            )
    return proc


# --------------------------------------------------------------------------
# StarBreaker
# --------------------------------------------------------------------------
# NOTE: the exact subcommand spelling is a HYPOTHESIS taken from PLAN.md §2 and
# must be checked against `starbreaker --help` during the Task 1 spike. Keep the
# argv construction in these two functions so there is one place to fix.


def starbreaker_dcb_extract(
    settings: Settings, *, out_dir: Path, fmt: str = "json", filter_glob: str | None = None
) -> Path:
    """Export the DataCore database to ``out_dir``. Returns ``out_dir``."""
    binary = require("starbreaker", settings)
    p4k = settings.p4k_path
    if p4k is None or not p4k.is_file():
        raise ToolError("no Data.p4k configured; set paths.sc_root in config/settings.local.toml")
    out_dir.mkdir(parents=True, exist_ok=True)
    argv = [str(binary), "dcb", "extract", "--p4k", str(p4k), "--format", fmt, "-o", str(out_dir)]
    if filter_glob:
        argv += ["--filter", filter_glob]
    run(argv)
    return out_dir


def starbreaker_p4k_extract(
    settings: Settings, *, out_dir: Path, filter_glob: str, convert: str | None = "all"
) -> Path:
    """Extract files matching ``filter_glob`` from the P4K into ``out_dir``."""
    binary = require("starbreaker", settings)
    p4k = settings.p4k_path
    if p4k is None or not p4k.is_file():
        raise ToolError("no Data.p4k configured; set paths.sc_root in config/settings.local.toml")
    out_dir.mkdir(parents=True, exist_ok=True)
    argv = [
        str(binary),
        "p4k",
        "extract",
        "--p4k",
        str(p4k),
        "-o",
        str(out_dir),
        "--filter",
        filter_glob,
    ]
    if convert:
        argv += ["--convert", convert]
    run(argv)
    return out_dir


# --------------------------------------------------------------------------
# Cgf-Converter  (repo: Markemp/Cryengine-Converter)
# --------------------------------------------------------------------------


def cgf_convert(
    settings: Settings,
    source: Path,
    *,
    out_dir: Path,
    fmt: str = "gltf",
    data_dir: Path | None = None,
) -> Path:
    """Convert one .skin/.cgf/.chr to glTF (``fmt='gltf'``) or Collada (``'dae'``)."""
    binary = require("cgf-converter", settings)
    out_dir.mkdir(parents=True, exist_ok=True)
    flag = {"gltf": "-gltf", "glb": "-glb", "dae": "-dae"}[fmt]
    argv = [
        str(binary),
        str(source),
        flag,
        "-objectdir",
        str(data_dir or settings.raw_dir),
        "-outputfile",
        str(out_dir / source.stem),
    ]
    run(argv)
    suffix = {"gltf": ".gltf", "glb": ".glb", "dae": ".dae"}[fmt]
    return out_dir / f"{source.stem}{suffix}"


# --------------------------------------------------------------------------
# Blender
# --------------------------------------------------------------------------


def blender_run(
    settings: Settings, script: Path, *, args: list[str] | None = None, timeout: float = 900
) -> subprocess.CompletedProcess[str]:
    """Run ``script`` in headless Blender. Args after ``--`` reach the script."""
    binary = require("blender", settings)
    argv = [str(binary), "-b", "--factory-startup", "-noaudio", "-P", str(script)]
    if args:
        argv += ["--", *args]
    return run(argv, timeout=timeout)
