from __future__ import annotations

from pathlib import Path

from sc_extract.manifest import (
    SCHEMA_VERSION,
    Assets,
    Geometry,
    Item,
    Manifest,
    Manufacturer,
    Skeleton,
)


def sample() -> Manifest:
    return Manifest(
        game_version="4.3.1",
        skeletons={"male": Skeleton(chr="a.chr", glb="base/male.glb")},
        sockets=["head_socket"],
        items=[
            Item(
                id="g1",
                class_name="c1",
                name="Helmet",
                slot="helmet",
                manufacturer=Manufacturer(code="AEG", name="Aegis"),
                geometry=[Geometry(source="a/b.skin", side="left")],
                assets=Assets(glb="items/g1/item.glb"),
            )
        ],
    )


def test_roundtrip_through_disk(tmp_path: Path) -> None:
    path = sample().write(tmp_path / "manifest.json")
    restored = Manifest.read(path)
    assert restored.schema_version == SCHEMA_VERSION
    assert restored.items[0].manufacturer.code == "AEG"
    assert restored.items[0].geometry[0].side == "left"
    assert restored.items[0].assets.glb == "items/g1/item.glb"
    assert restored.skeletons["male"].glb == "base/male.glb"


def test_unknown_fields_are_dropped_on_read() -> None:
    data = sample().to_dict()
    data["items"][0]["a_field_from_a_future_version"] = 1
    restored = Manifest.from_dict(data)
    assert restored.items[0].id == "g1"


def test_counts_cover_every_slot() -> None:
    counts = sample().counts_by_slot()
    assert counts["helmet"] == 1
    assert counts["undersuit"] == 0
    assert len(counts) == 6


def test_generated_at_is_filled() -> None:
    assert Manifest().generated_at
