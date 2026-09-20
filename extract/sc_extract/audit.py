"""Catalogue-wide invariants over the built output.

Every check here exists because a real bug shipped past it. They are cheap
assertions over the manifest, the baked textures and the GLB material lists --
no rendering, no game data -- so the whole catalogue runs in seconds and the
next regression of the same shape is caught before anyone looks at a render.

The pattern that motivated this: over one session, three wrong blend-mask
tables and a wrong ``TintMode`` rule each shipped, each survived a full rebuild,
and each was found only when a person looked at a screenshot and said the colour
was wrong. Every one of them would have tripped a check below in seconds.
"""

from __future__ import annotations

import json
import logging
import re
import struct
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from .config import Settings
from .manifest import Item, Manifest

log = logging.getLogger(__name__)

# Items the viewer already hides; auditing them is noise.
HIDDEN_FLAGS = {"not_wearable", "placeholder", "test", "no_geometry"}

_BLENDER_SUFFIX = re.compile(r"\.\d{3}$")

# Colour words that appear in item names, with a representative hue in sRGB.
# Only used to check that a named colour is *present somewhere* in the bake, so
# rough values are fine; the test is deliberately loose.
COLOUR_WORDS: dict[str, tuple[int, int, int]] = {
    "black": (25, 25, 25),
    "white": (235, 235, 235),
    "grey": (128, 128, 128),
    "gray": (128, 128, 128),
    "red": (170, 35, 35),
    "crimson": (150, 20, 30),
    "orange": (215, 120, 30),
    "yellow": (225, 200, 60),
    "green": (70, 140, 70),
    "seagreen": (90, 170, 130),
    "olive": (110, 105, 60),
    "blue": (70, 95, 180),
    "aqua": (90, 190, 190),
    "sky": (140, 175, 220),
    "purple": (120, 70, 160),
    "violet": (140, 80, 200),
    "pink": (220, 140, 190),
    "tan": (190, 160, 120),
    "brown": (120, 90, 60),
}


@dataclass
class Finding:
    check: str
    severity: str  # "error" | "warn"
    item: str
    detail: str


@dataclass
class AuditReport:
    findings: list[Finding] = field(default_factory=list)
    counts: Counter = field(default_factory=Counter)

    def add(self, check: str, severity: str, item: str, detail: str) -> None:
        self.findings.append(Finding(check, severity, item, detail))
        self.counts[check] += 1

    @property
    def errors(self) -> int:
        return sum(1 for f in self.findings if f.severity == "error")


def _strip(name: str | None) -> str:
    return _BLENDER_SUFFIX.sub("", name or "")


def glb_materials(path: Path) -> list[str] | None:
    """Material names declared by a .glb, without loading the binary chunk."""
    if not path.is_file():
        return None
    blob = path.read_bytes()
    offset = 12
    while offset < len(blob):
        length, kind = struct.unpack_from("<II", blob, offset)
        offset += 8
        if kind == 0x4E4F534A:
            doc = json.loads(blob[offset : offset + length])
            return [m.get("name") for m in doc.get("materials", [])]
        offset += length
    return None


# One decode per file, shared by every check.
#
# The bakes are 1024x1024 PNGs and there are a few thousand of them. PIL's
# ``draft`` is a JPEG-only shortcut, so a PNG costs a full decode no matter what
# size you ask for -- downsampling afterwards saves nothing. Four checks each
# opening the same files took the audit past ten minutes. Decoding once into a
# small statistics record takes it to seconds, and no check needs a pixel: they
# all want a fraction or a mean over the whole image.
@dataclass(frozen=True)
class Stats:
    mean: tuple[float, float, float]
    red_fraction: float
    metal_fraction: float


_STATS: dict[str, Stats | None] = {}


def stats_for(path: Path) -> Stats | None:
    """Decode one baked texture and reduce it to the numbers the checks use."""
    key = str(path)
    if key in _STATS:
        return _STATS[key]
    result: Stats | None = None
    try:
        import numpy as np
        from PIL import Image

        if path.is_file():
            image = Image.open(path).convert("RGB")
            if image.width > 256:
                image = image.reduce(max(1, image.width // 256))
            arr = np.asarray(image, dtype="float32")
            red, green, blue = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
            hot = (red > 120) & (green < red * 0.45) & (blue < red * 0.45)
            result = Stats(
                mean=tuple(float(v) for v in arr.reshape(-1, 3).mean(0)),
                red_fraction=float(hot.mean()),
                # ORM packs metallic in blue; harmless on an albedo, where no
                # check reads it.
                metal_fraction=float((blue > 127.5).mean()),
            )
    except (OSError, ImportError):
        result = None
    _STATS[key] = result
    return result


def _mean_rgb(path: Path) -> tuple[float, float, float] | None:
    got = stats_for(path)
    return got.mean if got else None


def _visible(item: Item) -> bool:
    return not (set(item.flags or []) & HIDDEN_FLAGS)


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------


def check_overrides_bind(settings: Settings, manifest: Manifest, report: AuditReport) -> None:
    """A material override whose name matches no GLB slot silently does nothing.

    This is how the Beacon undersuits rendered in a placeholder grey: the mesh
    carried Collada's ``<stem>_mtl_<sub>`` names and the overrides carried bare
    submaterial names, so not one of them bound. It also caught the Aves and
    Venture families being handed a *helmet* material for arms, legs and core.
    """
    cache: dict[str, list[str] | None] = {}
    for item in manifest.items:
        overrides = item.material_overrides or []
        rel = (item.assets.glb if item.assets else None) or None
        if not overrides or not rel:
            continue
        if rel not in cache:
            cache[rel] = glb_materials(settings.out_dir / rel)
        slots = cache[rel]
        if slots is None:
            report.add("glb-missing", "error", item.name, f"no glb at {rel}")
            continue
        have = {_strip(s) for s in slots}
        missing = [o.name for o in overrides if o.name not in have]
        if len(missing) == len(overrides):
            report.add(
                "overrides-bind-none",
                "error",
                item.name,
                f"none of {len(overrides)} overrides match slots {sorted(have)}",
            )


def check_colourways_differ(settings: Settings, manifest: Manifest, report: AuditReport) -> None:
    """Colourways of one family must not all bake to the same flat colour.

    Reading ``TintMode=0`` as "not tinted" forced 1185 layer references to white
    and baked 12 of the 28 Venture undersuits to a near-identical (220,220,219).
    A family collapsing onto one colour is the signature of a tint being
    discarded somewhere, and it is visible without any reference image.
    """
    families: dict[str, list[tuple[str, tuple[float, float, float]]]] = defaultdict(list)
    for item in manifest.items:
        if not _visible(item):
            continue
        key = item.variant_of or item.id
        for override in item.material_overrides or []:
            mean = _mean_rgb(settings.out_dir / override.base_color)
            if mean is None:
                continue
            families[f"{key}/{override.name}"].append((item.name, mean))
            break
    for key, members in families.items():
        if len(members) < 4:
            continue
        import numpy as np

        arr = np.array([m for _, m in members], dtype="float32")
        spread = float(np.linalg.norm(arr - arr.mean(0), axis=1).mean())
        if spread < 6.0:
            report.add(
                "colourways-identical",
                "error",
                members[0][0],
                f"{len(members)} colourways of {key.split('/')[-1]} agree to "
                f"within {spread:.1f}; a tint is being discarded",
            )


def check_named_colour_present(
    settings: Settings, manifest: Manifest, report: AuditReport
) -> None:
    """An item named for a colour should bake something near that colour.

    Deliberately loose -- it only fires when the *closest* baked submaterial is
    far from the named hue, which is the flat-white failure mode rather than a
    matter of taste.
    """
    import numpy as np

    for item in manifest.items:
        if not _visible(item) or not item.material_overrides:
            continue
        words = [w for w in COLOUR_WORDS if re.search(rf"\b{w}\b", item.name, re.I)]
        if len(words) != 1:
            continue  # two-colour names are ambiguous; skip rather than guess
        want = np.array(COLOUR_WORDS[words[0]], dtype="float32")
        best = None
        for override in item.material_overrides:
            mean = _mean_rgb(settings.out_dir / override.base_color)
            if mean is None:
                continue
            d = float(np.linalg.norm(np.array(mean, dtype="float32") - want))
            best = d if best is None else min(best, d)
        if best is not None and best > 165.0:
            report.add(
                "named-colour-absent",
                "warn",
                item.name,
                f"no submaterial within {best:.0f} of {words[0]}",
            )


def check_cloth_not_metal(settings: Settings, manifest: Manifest, report: AuditReport) -> None:
    """Fabric submaterials should not bake mostly metallic.

    The Beacon undersuit shipped at 58.9% metalness on its jumpsuit because the
    blend table sent the body of the garment to an ``anodized_black`` layer.
    Cloth reading as metal is a reliable signal that layer selection is wrong.
    """
    cloth = re.compile(
        r"(undersuit|jumpsuit|fabric|cloth|nylon|strap|cusion|cushion|glove)", re.I
    )
    seen: set[str] = set()
    for item in manifest.items:
        if not _visible(item):
            continue
        for override in item.material_overrides or []:
            if not cloth.search(override.name) or not override.orm:
                continue
            if override.orm in seen:
                continue
            seen.add(override.orm)
            got = stats_for(settings.out_dir / override.orm)
            if got is None:
                continue
            metal = got.metal_fraction
            if metal > 0.40:
                report.add(
                    "cloth-reads-metal",
                    "error",
                    item.name,
                    f"{override.name} is {100 * metal:.0f}% metallic",
                )


def check_distinct_names(settings: Settings, manifest: Manifest, report: AuditReport) -> None:
    """Two selectable items in one slot should not share a display name.

    Six entries all called "Deadhead Helmet" are indistinguishable in the
    picker, and five of them are hair-extension records rather than helmets.
    """
    dupes = Counter(
        (i.slot, i.name) for i in manifest.items if _visible(i) and not i.variant_of
    )
    for (slot, name), count in dupes.items():
        if count > 1:
            report.add(
                "duplicate-name", "warn", name, f"{count} distinct {slot} items share this name"
            )


def check_not_a_fragment(settings: Settings, manifest: Manifest, report: AuditReport) -> None:
    """A wearable whose mesh carries one material is usually a sub-part.

    ``srvl_helmet_01_01_01_hair_extension`` is a hair mesh with a single
    ``hair_m`` slot listed as a helmet; equipping it renders hair and no helmet.
    Genuine single-material pieces exist, so this is a warning.
    """
    cache: dict[str, list[str] | None] = {}
    for item in manifest.items:
        if not _visible(item) or item.variant_of:
            continue
        rel = (item.assets.glb if item.assets else None) or None
        if not rel:
            continue
        if rel not in cache:
            cache[rel] = glb_materials(settings.out_dir / rel)
        slots = cache[rel]
        if slots is not None and len(slots) == 1:
            report.add(
                "single-material-piece",
                "warn",
                item.name,
                f"{item.slot} with one slot {slots[0]!r} [{item.class_name}]",
            )


def check_no_sentinel_red(settings: Settings, manifest: Manifest, report: AuditReport) -> None:
    """A baked surface should not come out saturated pure red.

    63 of the 44164 armour BaseLayer entries carry a TintColor of pure
    saturated red, almost all on BaseLayer1. They are not albedo. Three things
    say so:

    * the value is frozen across colourways while its sibling layers change --
      Corbel's ``arms01_m`` BaseLayer1 stays (255,0,4) while BaseLayer3 and 4
      move from 189 to 255;
    * where the parent submaterial is emissive, the material's ``Emissive``
      colour is byte-identical to that layer's tint. Corbel ``arms01_m`` and
      ``core01_m`` are both ``Emissive="1,0,0.001214108" Glow="0.2"`` against a
      BaseLayer1 tint of exactly (1, 0, 0.001214108). The layer marks *where the
      glow is*, and the emission supplies the colour;
    * nothing in the catalogue is a flat pure-red plastic panel.

    Composited as albedo they produce bright red blotches: 4.9% of the Corbel
    arms, 11.7% of its legs, and -- where the marker sits on the ground layer --
    80.2% of ``core_acc_m`` on the QRT medium core and 67.5% of ``helm_parts``
    on the BASL light helmet.

    The fix is to route these to an emissive output rather than base colour,
    which needs emissive plumbed through the bake, Blender and glTF. Until then
    this check keeps the damage visible and sized.
    """
    # A colourway *named* for red is supposed to bake red. The first run of this
    # check reported 410 surfaces and led with "ADP Arms Red" and "ADP-mk4 Arms
    # Red Alert" -- correct renders, not markers. Skip those names.
    named_red = re.compile(r"\b(red|crimson|scarlet|ruby|blood|rust|maroon|red alert)\b", re.I)
    seen: set[str] = set()
    for item in manifest.items:
        if not _visible(item) or named_red.search(item.name):
            continue
        for override in item.material_overrides or []:
            if override.base_color in seen:
                continue
            seen.add(override.base_color)
            got = stats_for(settings.out_dir / override.base_color)
            if got is None:
                continue
            fraction = got.red_fraction
            if fraction > 0.02:
                report.add(
                    "sentinel-red-baked",
                    "error",
                    item.name,
                    f"{override.name} is {100 * fraction:.0f}% saturated red "
                    f"(emissive marker baked as albedo)",
                )


def check_has_own_surface(settings: Settings, manifest: Manifest, report: AuditReport) -> None:
    """An item with no material and no override wears whatever baked its GLB.

    Colour variants share their canonical item's mesh, so a variant with
    nothing of its own is not "untinted" -- it renders as *some other item*.
    ``Citadel-SE Arms Maroon`` comes out as ``Citadel Arms Brimstone`` and
    ``ORC-mkX Arms (XenoThreat v2)`` as ``GCD-Army Arms``, which is worse than
    a missing texture because it looks deliberate.

    Found by rendering 1874 items and diffing colourways against each other:
    115 items were in this state, spread across every slot, and many are the
    *canonical* member of their family rather than a variant.
    """
    byglb: dict[str, list[Item]] = defaultdict(list)
    for item in manifest.items:
        rel = (item.assets.glb if item.assets else None) or None
        if rel and _visible(item):
            byglb[rel].append(item)
    for item in manifest.items:
        if not _visible(item):
            continue
        rel = (item.assets.glb if item.assets else None) or None
        if not rel or item.materials or item.material_overrides:
            continue
        others = sorted({o.name for o in byglb[rel] if o.name != item.name})
        if others:
            report.add(
                "surface-borrowed",
                "error",
                item.name,
                f"no material of its own; renders as {others[0]!r}"
                + (f" (+{len(others) - 1} more on this mesh)" if len(others) > 1 else ""),
            )
        else:
            report.add(
                "surface-missing", "warn", item.name, f"no material and no override [{item.slot}]"
            )


def check_variant_surfaces_differ(
    settings: Settings, manifest: Manifest, report: AuditReport
) -> None:
    """Two differently-named colourways must not bake to the same textures.

    :func:`check_colourways_differ` catches a whole family collapsing onto one
    colour; this catches a *pair*, which is how the palette-specular bug
    presented. Lynx Blue, Green, Purple, Seagreen and Violet baked byte-identical
    textures because ``layered_key`` hashed only the palette's colour and their
    entire colourway lives in its specular.

    Comparing the baked filenames rather than their pixels is deliberate: the
    names are content hashes, so equality here means the pipeline decided these
    are one surface, which is the thing worth reporting.
    """
    families: dict[str, list[Item]] = defaultdict(list)
    for item in manifest.items:
        if _visible(item) and (item.material_overrides or []):
            families[item.variant_of or item.id].append(item)

    def surface(item: Item) -> tuple[str, ...]:
        return tuple(sorted(o.base_color for o in item.material_overrides or []))

    for members in families.values():
        if len(members) < 2:
            continue
        bysurface: dict[tuple[str, ...], list[str]] = defaultdict(list)
        for item in members:
            bysurface[surface(item)].append(item.name)
        for names in bysurface.values():
            distinct = sorted(set(names))
            if len(distinct) > 1:
                report.add(
                    "variant-surfaces-identical",
                    "error",
                    distinct[0],
                    f"bakes the same textures as {', '.join(distinct[1:4])}"
                    + (f" (+{len(distinct) - 4} more)" if len(distinct) > 4 else ""),
                )


CHECKS = (
    check_overrides_bind,
    check_colourways_differ,
    check_named_colour_present,
    check_cloth_not_metal,
    check_distinct_names,
    check_not_a_fragment,
    check_no_sentinel_red,
    check_has_own_surface,
    check_variant_surfaces_differ,
)


def run(settings: Settings, manifest: Manifest) -> AuditReport:
    report = AuditReport()
    for check in CHECKS:
        try:
            check(settings, manifest, report)
        except Exception as exc:  # one bad check must not hide the others
            log.warning("audit check %s failed: %s", check.__name__, exc)
    return report
