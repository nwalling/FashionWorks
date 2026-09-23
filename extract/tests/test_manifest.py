from __future__ import annotations

from pathlib import Path

from sc_extract.manifest import (
    SCHEMA_VERSION,
    Assets,
    Geometry,
    Item,
    Manifest,
    Manufacturer,
    MaterialOverride,
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


def test_material_overrides_survive_a_round_trip(tmp_path: Path) -> None:
    """A colour variant's textures must reach the viewer through the manifest.

    Variants reuse their canonical item's GLB, so this list is the only place
    their own surface is recorded.
    """
    item = Item(
        id="v1",
        class_name="variant",
        name="Odyssey II Undersuit Autumn",
        slot="undersuit",
        variant_of="c1",
        swatch="#786c5e",
        material_overrides=[
            MaterialOverride(name="cloth_m", base_color="tint/a_albedo.png", orm="tint/a_orm.png")
        ],
    )
    path = Manifest(items=[item]).write(tmp_path / "manifest.json")
    back = Manifest.read(path).items[0]
    assert back.swatch == "#786c5e"
    assert len(back.material_overrides) == 1
    assert back.material_overrides[0].name == "cloth_m"
    assert back.material_overrides[0].base_color == "tint/a_albedo.png"


def test_schema_version_is_four() -> None:
    """Bumped whenever the shape changes.

    v2 added material_overrides and swatch; v3 base_color_unworn and
    orm_unworn, so the viewer can show a piece factory-fresh; v4 the armour's
    holster ``ports`` and the ``gear`` list (LOADOUT.md).

    viewer/src/manifest.ts must carry the same number or the viewer refuses
    the manifest. This test exists to make that a conscious edit rather than
    something noticed after the viewer starts rejecting builds.
    """
    assert SCHEMA_VERSION == 4


def test_write_restamps_the_schema_version(tmp_path: Path) -> None:
    """Writing an old manifest back must not keep its old version number.

    A stage that adds fields would otherwise ship them under the previous
    version, and the viewer refuses a mismatch.
    """
    path = tmp_path / "manifest.json"
    stale = Manifest(items=[])
    stale.schema_version = 1
    stale.write(path)
    assert Manifest.read(path).schema_version == SCHEMA_VERSION
