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
from collections.abc import Sequence
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
    """Best-effort version string. Returns None when a tool has no version flag."""
    args = {
        "blender": ["--version"],
        "starbreaker": ["--version"],
        # Cgf-Converter uses single-dash flags and has no version switch; its
        # usage text on an unknown flag is noise, not a version.
        "cgf-converter": None,
    }[name]
    if args is None:
        return "built from source"
    try:
        proc = subprocess.run(  # noqa: S603
            [str(path), *args], capture_output=True, text=True, timeout=30, check=False
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return f"probe failed: {exc}"
    text = (proc.stdout or proc.stderr).strip()
    if not text or "No corresponding input file" in text:
        return None
    return text.splitlines()[0]


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
# VERIFIED against the v0.3.2 CLI source (cli/src/{p4k,dcb,skin,dds}.rs).
# Every subcommand also honours the SC_DATA_P4K environment variable in place
# of --p4k; this module always passes the flag explicitly so a stray shell
# variable cannot silently change which install is read.


def _p4k_args(settings: Settings) -> list[str]:
    p4k = settings.p4k_path
    if p4k is None or not p4k.is_file():
        raise ToolError(
            "no Data.p4k available; set paths.sc_root in config/settings.local.toml "
            "(an absolute path is fine, including an external volume)"
        )
    return ["--p4k", str(p4k)]


def starbreaker_dcb_extract(
    settings: Settings, *, out_dir: Path, fmt: str = "json", filter_glob: str | None = None
) -> Path:
    """Export DataCore records to ``out_dir``.

    ``starbreaker dcb extract --p4k P --output D --format json [--filter G]``
    Note the CLI defaults to ``xml``; json is passed explicitly.
    """
    binary = require("starbreaker", settings)
    out_dir.mkdir(parents=True, exist_ok=True)
    argv = [str(binary), "dcb", "extract", *_p4k_args(settings),
            "--output", str(out_dir), "--format", fmt]
    if filter_glob:
        argv += ["--filter", filter_glob]
    run(argv)
    return out_dir


def starbreaker_dcb_query(settings: Settings, path: str, *, filter_glob: str | None = None) -> str:
    """Query records by property path, e.g.
    ``EntityClassDefinition.Components[SGeometryResourceParams].Geometry.Geometry.Geometry.path``.

    Cheap way to check a field guess in fields.py against real data without a
    full export. Returns stdout.
    """
    binary = require("starbreaker", settings)
    argv = [str(binary), "dcb", "query", *_p4k_args(settings), "--path", path]
    if filter_glob:
        argv += ["--filter", filter_glob]
    return run(argv).stdout


# Converters accepted by `p4k extract --convert` (repeatable).
CONVERTERS = ("cryxml", "dds-png", "dds-merge", "all")


def starbreaker_p4k_extract(
    settings: Settings,
    *,
    out_dir: Path,
    filter_glob: str,
    convert: Sequence[str] | str | None = ("cryxml", "dds-png"),
    max_threads: int | None = None,
) -> Path:
    """Extract P4K entries matching ``filter_glob``, converting on the way out.

    ``starbreaker p4k extract --p4k P --output D --filter G [--convert C ...]``
    ``--convert`` is repeatable, so it is passed once per converter.
    """
    binary = require("starbreaker", settings)
    out_dir.mkdir(parents=True, exist_ok=True)
    argv = [str(binary), "p4k", "extract", *_p4k_args(settings),
            "--output", str(out_dir), "--filter", filter_glob]

    converters = [convert] if isinstance(convert, str) else list(convert or [])
    for converter in converters:
        if converter not in CONVERTERS:
            raise ValueError(f"unknown converter {converter!r}; expected one of {CONVERTERS}")
        argv += ["--convert", converter]
    if max_threads:
        argv += ["--max-threads", str(max_threads)]
    run(argv)
    return out_dir


def starbreaker_p4k_list(settings: Settings, filter_glob: str) -> list[str]:
    """List P4K entries matching a glob, without extracting."""
    binary = require("starbreaker", settings)
    argv = [str(binary), "p4k", "list", *_p4k_args(settings), "--filter", filter_glob]
    return [line.strip() for line in run(argv).stdout.splitlines() if line.strip()]


def starbreaker_skin_export(settings: Settings, p4k_path: str, out_glb: Path) -> Path:
    """Export one .skin/.cgf straight from the P4K to GLB.

    ``starbreaker skin export <p4k path substring> <output.glb> --p4k P``

    This replaces the Cgf-Converter step for geometry: StarBreaker reads the
    mesh out of the archive and writes glTF directly, so there is no
    intermediate extract-then-convert pass and no .NET dependency. Cgf-Converter
    remains available as a cross-check via :func:`cgf_convert`.
    """
    binary = require("starbreaker", settings)
    out_glb.parent.mkdir(parents=True, exist_ok=True)
    run([str(binary), "skin", "export", p4k_path, str(out_glb), *_p4k_args(settings)])
    return out_glb


def starbreaker_skin_inspect(settings: Settings, p4k_path: str, *, bone_weights: bool = False) -> str:
    """Print parsed mesh metadata. With ``bone_weights``, dumps per-vertex
    influence statistics, which is how the Task 1 spike answers whether a
    .skin carries the full skeleton or a subset."""
    binary = require("starbreaker", settings)
    argv = [str(binary), "skin", "inspect", p4k_path, *_p4k_args(settings)]
    if bone_weights:
        argv.append("--bone-weights")
    return run(argv).stdout


def starbreaker_dds_to_png(settings: Settings, dds: Path, out_png: Path) -> Path:
    """Convert one already-extracted DDS on disk to PNG.

    ``starbreaker dds to-png <input.dds> <output.png>``
    For textures still inside the archive use ``dds decode`` instead; for a
    whole directory prefer :func:`starbreaker_dds_to_png_all`.
    """
    binary = require("starbreaker", settings)
    out_png.parent.mkdir(parents=True, exist_ok=True)
    run([str(binary), "dds", "to-png", str(dds), str(out_png)])
    return out_png


def starbreaker_dds_to_png_all(
    settings: Settings, in_dir: Path, out_dir: Path, *, filter_glob: str = "*.dds"
) -> Path:
    """Batch DDS to PNG: ``starbreaker dds to-png-all -i D -o D [--filter G]``."""
    binary = require("starbreaker", settings)
    out_dir.mkdir(parents=True, exist_ok=True)
    run([str(binary), "dds", "to-png-all", "-i", str(in_dir), "-o", str(out_dir),
         "--filter", filter_glob])
    return out_dir


def starbreaker_dds_merge_all(settings: Settings, in_dir: Path, out_dir: Path) -> Path:
    """Batch merge split-mip DDS: ``starbreaker dds merge-all -i D -o D``."""
    binary = require("starbreaker", settings)
    out_dir.mkdir(parents=True, exist_ok=True)
    run([str(binary), "dds", "merge-all", "-i", str(in_dir), "-o", str(out_dir)])
    return out_dir


# --------------------------------------------------------------------------
# Cgf-Converter  (repo: Markemp/Cryengine-Converter)
# --------------------------------------------------------------------------
# Optional since StarBreaker gained `skin export`. Kept as a cross-check for
# meshes whose weights or bone hierarchy come out wrong.


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
