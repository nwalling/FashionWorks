"""``scx`` command line interface.

Stages, in pipeline order::

    scx doctor      # what is available on this host, and what is blocking
    scx catalog     # Data.p4k -> data/out/manifest.json
    scx extract     # manifest -> data/raw (geometry, materials, textures)
    scx convert     # data/raw -> data/out/items/<id>/item.glb
    scx rig         # base skeleton + undersuit -> data/out/base/<skeleton>.glb
    scx synth       # dev-only: synthetic manifest + GLBs, no game data needed
    scx all         # catalog + extract + convert + rig
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

import click

from . import __version__
from .config import (
    LOCAL_CONFIG,
    REPO_ROOT,
    ConfigError,
    Settings,
    load_settings,
    merge_sc_root,
)
from .manifest import SLOTS, Manifest

BLENDER_DIR = REPO_ROOT / "blender"


def _setup_logging(verbose: int) -> None:
    level = logging.WARNING if verbose == 0 else logging.INFO if verbose == 1 else logging.DEBUG
    logging.basicConfig(level=level, format="%(levelname)-7s %(name)s: %(message)s")


def _settings(ctx: click.Context) -> Settings:
    return ctx.obj["settings"]


def _fail(message: str) -> None:
    click.secho(f"error: {message}", fg="red", err=True)
    sys.exit(1)


@click.group(context_settings={"help_option_names": ["-h", "--help"]})
@click.version_option(__version__, prog_name="scx")
@click.option("-v", "--verbose", count=True, help="-v info, -vv debug")
@click.option("--config", type=click.Path(path_type=Path), default=None, help="settings.toml path")
@click.pass_context
def main(ctx: click.Context, verbose: int, config: Path | None) -> None:
    """SC Armor Kitbasher extraction pipeline."""
    _setup_logging(verbose)
    try:
        settings = load_settings(config)
    except ConfigError as exc:
        _fail(str(exc))
        return
    ctx.obj = {"settings": settings}


# ---------------------------------------------------------------------------
# doctor
# ---------------------------------------------------------------------------


@main.command()
@click.pass_context
def doctor(ctx: click.Context) -> None:
    """Report host readiness for each pipeline stage."""
    from . import tools

    settings = _settings(ctx)
    click.secho("paths", bold=True)
    p4k = settings.p4k_path
    click.echo(f"  sc_root       {settings.sc_root or '(unset)'}")
    click.echo(
        f"  Data.p4k      {p4k or '(unset)'} "
        f"{'[found]' if settings.has_game_data() else '[MISSING]'}"
    )
    click.echo(f"  out_dir       {settings.out_dir}")

    click.secho("tools", bold=True)
    statuses = {s.name: s for s in tools.status(settings)}
    for status in statuses.values():
        mark = "ok " if status.available else "MISSING"
        click.echo(f"  {status.name:<14} {mark:<8} {status.path or ''} {status.version or ''}")

    click.secho("stages", bold=True)
    checks = [
        (
            "catalog",
            settings.has_game_data() and statuses["starbreaker"].available,
            "needs Data.p4k + starbreaker",
        ),
        (
            "extract",
            settings.has_game_data() and statuses["starbreaker"].available,
            "needs Data.p4k + starbreaker",
        ),
        (
            "convert",
            statuses["cgf-converter"].available and statuses["blender"].available,
            "needs cgf-converter + blender (only cgf-converter keeps skin weights)",
        ),
        ("rig", statuses["blender"].available, "needs blender"),
        ("synth", statuses["blender"].available, "needs blender only"),
    ]
    blocked = False
    for name, ready, why in checks:
        if ready:
            click.secho(f"  {name:<10} ready", fg="green")
        else:
            blocked = True
            click.secho(f"  {name:<10} blocked  ({why})", fg="yellow")
    if blocked:
        click.echo("\nSet missing paths in config/settings.local.toml.")


@main.command(name="use-p4k")
@click.argument("path", type=click.Path(exists=True, path_type=Path))
def use_p4k(path: Path) -> None:
    """Point the pipeline at a Data.p4k, writing config/settings.local.toml.

    PATH may be the Data.p4k itself or the directory holding it, on any volume
    (an SD card or external drive is fine).
    """
    resolved = path.expanduser().resolve()
    p4k = resolved if resolved.is_file() else resolved / "Data.p4k"
    if not p4k.is_file():
        _fail(f"no Data.p4k at {p4k}")
        return

    size_gb = p4k.stat().st_size / 1_000_000_000
    local = LOCAL_CONFIG
    existing = local.read_text() if local.is_file() else ""
    local.parent.mkdir(parents=True, exist_ok=True)
    local.write_text(merge_sc_root(existing, p4k.parent))

    click.secho(f"sc_root = {p4k.parent}", fg="green")
    click.echo(f"  Data.p4k   {p4k.name}  {size_gb:.1f} GB")
    click.echo(f"  written to {local}")
    click.echo("\nNext: scx doctor, then scripts/spike.sh <set-name>")


# ---------------------------------------------------------------------------
# catalog
# ---------------------------------------------------------------------------


@main.command()
@click.option(
    "--filter",
    "filter_glob",
    default=None,
    multiple=True,
    help="DCB export filter glob; repeatable. Record paths, so lead with **/.",
)
@click.option("--include-npc", is_flag=True, help="keep NPC-only pieces")
@click.option("--force", is_flag=True, help="re-export the DCB even if cached")
@click.option(
    "--game-version",
    default=None,
    help="manifest.game_version; read from build_manifest.id when omitted",
)
@click.pass_context
def catalog(
    ctx: click.Context,
    filter_glob: tuple[str, ...],
    include_npc: bool,
    force: bool,
    game_version: str | None,
) -> None:
    """Build data/out/manifest.json from the DataCore."""
    from . import catalog as catalog_mod
    from . import dcb
    from .config import read_game_version
    from .localization import Localization
    from .tools import starbreaker_p4k_extract

    settings = _settings(ctx)
    if not settings.has_game_data():
        _fail(
            "no Data.p4k available on this host. Set paths.sc_root in "
            "config/settings.local.toml, then re-run. `scx doctor` shows the details."
        )

    game_version = game_version or read_game_version(settings.sc_root) or "unknown"

    dcb.export(settings, filter_glob=list(filter_glob) or None, force=force)
    index = dcb.Index.load(settings.dcb_dir)

    loc_file = settings.raw_dir / settings.localization_p4k_path()
    if not loc_file.is_file():
        click.echo("extracting the localization table...")
        starbreaker_p4k_extract(
            settings,
            out_dir=settings.raw_dir,
            filter_glob=f"**/{settings.localization_p4k_path()}",
            convert=None,
        )
    if loc_file.is_file():
        loc = Localization.from_file(loc_file)
    else:
        click.secho(
            f"warning: no localization at {loc_file}; names stay as class names",
            fg="yellow",
            err=True,
        )
        loc = Localization.empty()

    manifest, stats = catalog_mod.build(
        index,
        loc,
        game_version=game_version,
        include_npc=include_npc,
        skeleton=settings.skeleton,
    )
    manifest.write(settings.manifest_path())

    click.secho(f"wrote {settings.manifest_path()}", fg="green")
    for slot, count in manifest.counts_by_slot().items():
        click.echo(f"  {slot:<10} {count}")
    click.echo(f"  {'total':<10} {len(manifest.items)}")

    if loc.missing:
        settings.write_errors("unresolved_localization_keys", sorted(loc.missing))
        click.secho(
            f"{len(loc.missing)} unresolved @keys listed in {settings.errors_path()}",
            fg="yellow",
        )


# ---------------------------------------------------------------------------
# extract
# ---------------------------------------------------------------------------


@main.command()
@click.option("--slot", type=click.Choice(SLOTS), default=None)
@click.option("--item", "item_id", default=None, help="single item id")
@click.pass_context
def extract(ctx: click.Context, slot: str | None, item_id: str | None) -> None:
    """Extract raw geometry, materials and textures for catalog items."""
    from . import geometry, textures

    settings = _settings(ctx)
    if not settings.manifest_path().is_file():
        _fail(f"no manifest at {settings.manifest_path()}; run `scx catalog` first")

    manifest = Manifest.read(settings.manifest_path())
    if item_id:
        item = manifest.by_id().get(item_id)
        if item is None:
            _fail(f"no item {item_id} in manifest")
            return
        paths = geometry.extract_item(settings, item)
        click.secho(f"extracted {len(paths)} files for {item.class_name}", fg="green")
    else:
        count = geometry.extract_manifest(settings, manifest, slot=slot)
        click.secho(f"requested {count} source paths", fg="green")

    written = textures.convert_all(settings)
    click.secho(f"converted {len(written)} textures", fg="green")


# ---------------------------------------------------------------------------
# convert
# ---------------------------------------------------------------------------


@main.command()
@click.option("--slot", type=click.Choice(SLOTS), default=None)
@click.option("--item", "item_id", default=None)
@click.option("--all", "convert_all_items", is_flag=True)
@click.option("--set", "set_keys", multiple=True, help="convert one or more sets; repeatable")
@click.option(
    "--canonical-only/--with-variants",
    default=True,
    help="skip colour variants, which share geometry with their canonical item",
)
@click.option("--jobs", type=int, default=None, help="override convert.jobs")
@click.option("--web", is_flag=True, help="enable Draco/KTX2 for a web build")
@click.pass_context
def convert(
    ctx: click.Context,
    slot: str | None,
    item_id: str | None,
    convert_all_items: bool,
    set_keys: tuple[str, ...],
    canonical_only: bool,
    jobs: int | None,
    web: bool,
) -> None:
    """Convert raw geometry to normalized per-item GLBs."""
    from . import pipeline

    settings = _settings(ctx)
    if not settings.manifest_path().is_file():
        _fail(f"no manifest at {settings.manifest_path()}; run `scx catalog` first")
    if not (slot or item_id or convert_all_items or set_keys):
        _fail("pass one of --item, --slot, --set or --all")

    result = pipeline.convert(
        settings,
        slot=slot,
        item_id=item_id,
        set_keys=list(set_keys) or None,
        canonical_only=canonical_only,
        jobs=jobs or settings.jobs,
        draco=web or settings.draco,
    )
    click.secho(f"converted {result.ok} items, {len(result.errors)} failed", fg="green")
    if result.errors:
        click.secho(f"see {settings.errors_path()}", fg="yellow")


# ---------------------------------------------------------------------------
# rig / synth
# ---------------------------------------------------------------------------


@main.command()
@click.option("--skeleton", default=None, help="male|female (default: catalog.skeleton)")
@click.option("--chr", "chr_file", default=None, help="converted skeleton (.dae)")
@click.option("--undersuit", default=None, help="converted undersuit mesh for the base body")
@click.option("--undersuit-item", default=None, help="manifest item id supplying its materials")
@click.pass_context
def rig(
    ctx: click.Context,
    skeleton: str | None,
    chr_file: str | None,
    undersuit: str | None,
    undersuit_item: str | None,
) -> None:
    """Build data/out/base/<skeleton>.glb from the canonical skeleton."""
    import json as _json

    from .pipeline import material_descriptors
    from .tools import blender_run

    settings = _settings(ctx)
    name = skeleton or settings.skeleton

    args = [
        "--skeleton", name,
        "--out-dir", str(settings.base_dir()),
        "--interim-dir", str(settings.interim_dir),
        "--smooth-angle", str(settings.smooth_angle),
    ]
    if chr_file:
        args += ["--chr", chr_file]
    if undersuit:
        args += ["--undersuit", undersuit]

    # The base body needs the same materials as any other piece, or it renders
    # as a flat untextured mannequin under the armor.
    if undersuit_item and settings.manifest_path().is_file():
        manifest = Manifest.read(settings.manifest_path())
        item = manifest.by_id().get(undersuit_item)
        if item is None:
            _fail(f"no item {undersuit_item} in the manifest")
            return
        slots = material_descriptors(settings, item)
        spec = settings.interim_dir / f"base-materials-{name}.json"
        spec.parent.mkdir(parents=True, exist_ok=True)
        spec.write_text(_json.dumps(slots, indent=1))
        args += ["--materials", str(spec)]
        click.echo(f"base body materials: {len(slots)} slot(s) from {item.name}")

    blender_run(settings, BLENDER_DIR / "build_base_rig.py", args=args)
    click.secho(f"wrote {settings.base_dir() / f'{name}.glb'}", fg="green")


@main.command()
@click.option("--skeleton", default=None)
@click.option("--items", type=int, default=30, help="how many placeholder items to generate")
@click.pass_context
def synth(ctx: click.Context, skeleton: str | None, items: int) -> None:
    """Generate a synthetic rig + manifest so the viewer runs without game data.

    Development stand-in only: the meshes are primitives, not game assets. It
    exercises the same manifest schema, joint order and skinned/socket split as
    a real run, so viewer work is not blocked on having a Data.p4k.
    """
    from .synthetic import build_manifest
    from .tools import blender_run

    settings = _settings(ctx)
    name = skeleton or settings.skeleton
    blender_run(
        settings,
        BLENDER_DIR / "make_synthetic.py",
        args=["--skeleton", name, "--out-dir", str(settings.out_dir), "--items", str(items)],
        timeout=900,
    )

    descriptors = settings.out_dir / "synth-items.json"
    if not descriptors.is_file():
        _fail(f"blender did not write {descriptors}")
        return

    manifest = build_manifest(settings, descriptors)
    manifest.write(settings.manifest_path())
    click.secho(
        f"wrote {settings.manifest_path()} with {len(manifest.items)} synthetic items", fg="green"
    )
    for slot, count in manifest.counts_by_slot().items():
        click.echo(f"  {slot:<10} {count}")
    click.secho("these are placeholder primitives, not game assets", fg="yellow")


@main.command()
@click.pass_context
def refresh(ctx: click.Context) -> None:
    """Re-point the manifest at the GLBs currently on disk."""
    from .pipeline import refresh_assets

    settings = _settings(ctx)
    if not settings.manifest_path().is_file():
        _fail(f"no manifest at {settings.manifest_path()}; run `scx catalog` first")
    ready = refresh_assets(settings)
    click.secho(f"{ready} item(s) renderable", fg="green")


@main.command(name="poses")
@click.option("--skeleton", default=None)
@click.pass_context
def poses_cmd(ctx: click.Context, skeleton: str | None) -> None:
    """Retarget standing and crouching poses from the game's animation data."""
    from . import poses as poses_mod

    settings = _settings(ctx)
    try:
        target = poses_mod.build(settings, skeleton=skeleton)
    except Exception as exc:  # noqa: BLE001 - the message is the useful part
        _fail(str(exc))
        return
    data = json.loads(target.read_text())
    click.secho(f"wrote {target}", fg="green")
    for name, entry in data.items():
        click.echo(f"  {name:<8} {len(entry['bones'])} bones  ({entry['clip']})")


@main.command(name="sets")
@click.option("--incomplete", is_flag=True, help="also list sets missing a core slot")
@click.option("--pending", is_flag=True, help="only sets with unconverted items")
@click.pass_context
def sets_cmd(ctx: click.Context, incomplete: bool, pending: bool) -> None:
    """List armor sets and how much of each is converted."""
    from collections import defaultdict

    settings = _settings(ctx)
    if not settings.manifest_path().is_file():
        _fail(f"no manifest at {settings.manifest_path()}; run `scx catalog` first")

    manifest = Manifest.read(settings.manifest_path())
    core = {"helmet", "torso", "arms", "legs"}
    grouped: dict[str, list] = defaultdict(list)
    for item in manifest.items:
        if item.geometry and item.variant_of is None and item.set:
            grouped[item.set].append(item)

    rows = []
    for key, items in grouped.items():
        slots = {i.slot for i in items}
        ready = sum(1 for i in items if i.assets.glb)
        if not incomplete and not core <= slots:
            continue
        if pending and ready == len(items):
            continue
        maker = next((i.manufacturer.code for i in items if i.manufacturer.code), "")
        weight = next((i.weight_class for i in items if i.weight_class), "")
        rows.append((key, maker, weight, ready, len(items), sorted(slots)))

    rows.sort(key=lambda r: (r[2] or "", r[1] or "", r[0]))
    for key, maker, weight, ready, total, slots in rows:
        mark = "done" if ready == total else f"{ready}/{total}"
        click.echo(f"  {key:<30} {maker:<6} {weight or '-':<11} {mark:<7} {','.join(slots)}")
    click.secho(f"{len(rows)} set(s)", fg="green")


@main.command(name="all")
@click.option("--game-version", default="unknown")
@click.pass_context
def all_stages(ctx: click.Context, game_version: str) -> None:
    """Run catalog, extract, convert and rig in order."""
    ctx.invoke(catalog, game_version=game_version)
    ctx.invoke(extract)
    ctx.invoke(convert, convert_all_items=True)
    ctx.invoke(rig)


if __name__ == "__main__":
    main()
