"""The ``Materials/Layers`` detail library that LayerBlend_V2 composites.

A LayerBlend_V2 armour material carries no albedo of its own. Its
``<MatLayers>`` block names up to eight tiling detail materials -- painted
metal, nylon, rubber, aluminium -- and the shader blends them across the
surface using the ``_blend`` mask. Version 2 of this pipeline ignored that
block entirely and painted flat palette colours instead, which is why armour
came out the wrong colour with no surface detail.

Each detail material is a tiny ``Shader="Layer"`` .mtl holding:

* ``TexSlot1`` - the tiling diffuse, optionally with its own ``TexMod`` tiling
* ``TexSlot2`` - the tiling ``_ddna`` normal
* ``Shininess`` / ``Specular`` - the layer's base gloss and reflectance

The per-pixel gloss is **not** in the converted PNG. CryEngine stores it in
``.dds.Na`` sibling streams that ``--convert dds-png`` silently drops, leaving
a constant-255 alpha. It has to be pulled out separately with
``starbreaker dds decode --alpha``; :func:`gloss_for` does that on demand and
caches the result.
"""

from __future__ import annotations

import logging
import re
import subprocess
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

log = logging.getLogger(__name__)

_SEP = re.compile(r"[\\/]+")
_EXT = re.compile(r"\.(tif|dds|png|tga)(\.\d+[ab]?)?$", re.IGNORECASE)


def _norm(value: str) -> str:
    return _SEP.sub("/", value or "").strip().lstrip("/").lower()


def _scalar(value: str | None, default: float) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class LayerMaterial:
    """One resolved entry of the detail library."""

    path: str
    diff: Path | None = None
    ddna: Path | None = None
    tile_u: float = 1.0
    tile_v: float = 1.0
    shininess: float = 255.0
    specular: tuple[float, float, float] = (0.04, 0.04, 0.04)
    # The layer's own diffuse colour. 168 of 317 dielectric layers set this to
    # something other than white and 46 set it below 0.5, so ignoring it made
    # them render at full brightness. A black diffuse with real specular is
    # CryEngine's signature for bare metal.
    diffuse: tuple[float, float, float] = (1.0, 1.0, 1.0)
    # PublicParams TintMode: 1 = tinted as a dielectric (201 layers, 3% metal by
    # reflectance -- fabric, canvas, fleece, paint), 2 = tinted as a metal (130
    # layers, 96% metal -- aluminium, steel, bronze), 0 = neither stated (144,
    # the weapon and reference layers). -1 means the material omitted it.
    #
    # Modes 1 and 2 are what `is_metal` was inferring from reflectance, so they
    # are taken at their word. **Mode 0 is not.** It does not mean "no tint":
    # `rubber_diamond_02` is mode 0 and every Venture colourway authors a
    # different TintColor on it -- (54,31,79) on the purple, (210,210,210) on
    # the base -- so the tint plainly still applies, and discarding it rendered
    # 1185 armour layer references, and 12 of 28 Venture undersuits, flat white.
    # Mode 0 says nothing about metalness either, so it falls through to the
    # reflectance heuristic.
    tint_mode: int = -1

    @property
    def is_metal(self) -> bool:
        """Whether this layer is bare metal.

        `TintMode` is the artist saying so outright, and it wins wherever the
        material states one: mode 2 is metal, mode 1 is not. It disagrees
        with the reflectance heuristic below on 70 of 475 library layers and
        0.5% of real armour layer references -- among them
        `anodized_white_metal_01` (spec 0.061, diffuse 1.0) and `burnt_metal_02`,
        which the numbers call dielectric and the artist calls metal.

        The heuristic stays as the fallback for a material with no TintMode.
        Two signatures, both CryEngine's own. A high specular is the obvious
        one. The second catches near-metals whose specular sits just under the
        threshold: a black diffuse with any real reflectance can only be metal,
        since a dielectric gets its colour from diffuse.
        """
        if self.tint_mode in (1, 2):
            return self.tint_mode == 2
        spec = 0.2126 * self.specular[0] + 0.7152 * self.specular[1] + 0.0722 * self.specular[2]
        diff = 0.2126 * self.diffuse[0] + 0.7152 * self.diffuse[1] + 0.0722 * self.diffuse[2]
        return spec > 0.2 or (diff < 0.05 and spec > 0.02)

    @property
    def glossiness(self) -> float:
        """The layer's own gloss, before the armour's per-layer GlossMult."""
        return max(0.0, min(1.0, self.shininess / 255.0))


@lru_cache(maxsize=1)
def _raw_index(raw_root: str) -> dict[str, Path]:
    """Case-insensitive index of the extracted tree.

    Archive paths are Windows-cased and materials reference them with a
    different case; a case-sensitive lookup matches nothing and fails silently
    much later. Indexing once by lowercase relative path avoids that.
    """
    root = Path(raw_root)
    index: dict[str, Path] = {}
    if not root.is_dir():
        return index
    for file in root.rglob("*"):
        if file.is_file():
            index.setdefault(_norm(str(file.relative_to(root))), file)
    return index


def _lookup(raw_root: Path, reference: str, suffixes: tuple[str, ...]) -> Path | None:
    """Find ``reference`` under the extracted tree, trying each suffix."""
    index = _raw_index(str(raw_root))
    ref = _norm(reference)
    # Strip whatever extension the reference carries. Materials name .tif for
    # textures that were extracted as .png, and .mtl references need no change
    # -- appending blindly produced "paint_01.mtl.mtl" and matched nothing.
    stem = _EXT.sub("", ref)
    if stem == ref:
        stem = ref.rsplit(".", 1)[0] if "." in Path(ref).name else ref
    for candidate in (stem + s for s in suffixes):
        for prefix in ("data/", ""):
            hit = index.get(prefix + candidate)
            if hit is not None:
                return hit
    return None


def load(raw_root: Path, reference: str) -> LayerMaterial | None:
    """Resolve and parse one ``materials/layers/...mtl`` reference."""
    if not reference:
        return None
    return _load_cached(str(raw_root), _norm(reference))


@lru_cache(maxsize=1024)
def _load_cached(raw_root: str, reference: str) -> LayerMaterial | None:
    root = Path(raw_root)
    mtl = _lookup(root, reference, (".mtl",))
    if mtl is None:
        log.debug("layer material not extracted: %s", reference)
        return None
    try:
        node = ET.parse(mtl).getroot()
    except ET.ParseError as exc:
        log.warning("unparseable layer material %s: %s", mtl, exc)
        return None

    diff = ddna = None
    tile_u = tile_v = 1.0
    for tex in node.findall(".//Texture"):
        slot = (tex.get("Map") or "").strip().lower()
        file_attr = tex.get("File") or ""
        if not file_attr:
            continue
        found = _lookup(root, file_attr, (".png",))
        if slot == "texslot1":
            diff = found
            mod = tex.find("TexMod")
            if mod is not None:
                tile_u = _scalar(mod.get("TileU"), 1.0) or 1.0
                tile_v = _scalar(mod.get("TileV"), 1.0) or 1.0
        elif slot == "texslot2":
            ddna = found

    def _colour(attr: str, default: tuple[float, float, float]):
        raw = node.get(attr)
        if not raw:
            return default
        parts = tuple(_scalar(p, default[0]) for p in raw.split(","))
        return parts if len(parts) == 3 else default

    spec = _colour("Specular", (0.04, 0.04, 0.04))
    diffuse = _colour("Diffuse", (1.0, 1.0, 1.0))

    params = node.find("PublicParams")
    tint_mode = -1
    if params is not None and params.get("TintMode") is not None:
        tint_mode = int(_scalar(params.get("TintMode"), -1.0))

    return LayerMaterial(
        path=reference,
        diff=diff,
        ddna=ddna,
        tile_u=tile_u,
        tile_v=tile_v,
        shininess=_scalar(node.get("Shininess"), 255.0),
        tint_mode=tint_mode,
        specular=spec,  # type: ignore[arg-type]
        diffuse=diffuse,  # type: ignore[arg-type]
    )


def gloss_for(
    layer: LayerMaterial,
    *,
    p4k: Path,
    starbreaker: Path,
    cache_dir: Path,
) -> Path | None:
    """Per-pixel gloss for a layer, from the ``_ddna`` alpha stream.

    ``--convert dds-png`` writes a constant-255 alpha because it never reads
    the ``.dds.Na`` siblings, so the gloss has to be decoded separately. The
    result is cached on disk; the library is small (348 textures) and shared
    across every armour piece, so this runs once.
    """
    if layer.ddna is None:
        return None
    cache_dir.mkdir(parents=True, exist_ok=True)
    out = cache_dir / (layer.ddna.stem + "_gloss.png")
    if out.is_file():
        return out
    missing = cache_dir / (layer.ddna.stem + ".none")
    if missing.is_file():  # decoded before, this texture has no alpha stream
        return None

    archive = "Data/" + str(layer.ddna).split("/Data/", 1)[-1]
    archive = _EXT.sub(".dds", archive)
    try:
        proc = subprocess.run(
            [str(starbreaker), "dds", "decode", "--p4k", str(p4k),
             archive, str(out), "--alpha"],
            capture_output=True, text=True, timeout=180,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        log.warning("gloss decode failed for %s: %s", archive, exc)
        return None
    if proc.returncode != 0 or not out.is_file():
        missing.write_text(proc.stderr[-400:])
        return None
    return out
