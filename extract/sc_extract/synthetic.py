"""Build a manifest from the synthetic generator's descriptors.

Keeps :mod:`sc_extract.manifest` the single owner of the manifest schema: the
Blender script writes plain descriptors, this module turns them into the same
``Manifest`` objects the real catalog stage produces.
"""

from __future__ import annotations

import json
from pathlib import Path

from .catalog import assign_sets, link_variants
from .config import Settings
from .manifest import Assets, Item, Manifest, Manufacturer, Skeleton


def build_manifest(settings: Settings, descriptors_path: Path) -> Manifest:
    data = json.loads(descriptors_path.read_text(encoding="utf-8"))
    skeleton_name = data.get("skeleton", settings.skeleton)

    items: list[Item] = []
    for raw in data.get("items", []):
        mfg = raw.get("manufacturer") or {}
        items.append(
            Item(
                id=raw["id"],
                class_name=raw["class_name"],
                name=raw["name"],
                slot=raw["slot"],
                weight_class=raw.get("weight_class"),
                manufacturer=Manufacturer(code=mfg.get("code", ""), name=mfg.get("name", "")),
                bind_mode=raw.get("bind_mode", "skinned"),
                socket=raw.get("socket"),
                tint={"colors": raw.get("color")} if raw.get("color") else None,
                assets=Assets(glb=raw.get("glb"), thumb=None),
                flags=list(raw.get("flags", [])),
            )
        )

    items.sort(key=lambda i: (i.slot, i.name.lower()))
    assign_sets(items)
    link_variants(items)
    # The generator already knows the set; keep its grouping rather than the
    # path-prefix heuristic, which has no real geometry paths to work from.
    for item, raw in zip(
        items,
        sorted(data.get("items", []), key=lambda r: (r["slot"], r["name"].lower())),
        strict=False,
    ):
        if raw.get("set"):
            item.set = raw["set"]

    manifest = Manifest(
        game_version=f"synthetic ({skeleton_name})",
        skeletons={
            skeleton_name: Skeleton(chr=None, glb=data.get("base_glb", f"base/{skeleton_name}.glb"))
        },
        sockets=list(data.get("sockets", [])),
        items=items,
    )
    return manifest
