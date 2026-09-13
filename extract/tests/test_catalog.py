from __future__ import annotations

from sc_extract import catalog
from sc_extract.dcb import Index
from sc_extract.localization import Localization
from sc_extract.manifest import Item, Manufacturer


def build(index: Index, loc: Localization, **kwargs):
    return catalog.build(index, loc, game_version="test", **kwargs)


def test_only_armor_records_become_items(index: Index, loc: Localization) -> None:
    manifest, stats = build(index, loc)
    class_names = {item.class_name for item in manifest.items}
    assert "behr_p8sc_smg" not in class_names, "weapons must not enter the armor catalog"
    assert "Manufacturer_AEG" not in class_names
    assert stats.considered == 8
    assert stats.matched == len(manifest.items)


def test_slots_and_counts(index: Index, loc: Localization) -> None:
    manifest, _ = build(index, loc)
    counts = manifest.counts_by_slot()
    assert counts["helmet"] == 3
    assert counts["arms"] == 1
    assert counts["torso"] == 0


def test_names_resolve_through_localization(index: Index, loc: Localization) -> None:
    manifest, _ = build(index, loc)
    helmet = next(i for i in manifest.items if i.class_name.endswith("helmet_light_slate"))
    assert helmet.name == "AEG Pathfinder Helmet"
    assert helmet.description == "A light exploration helmet, rated to -40C."
    assert helmet.name_key == "@item_Name_aeg_pathfinder_helmet"


def test_unresolved_name_falls_back_to_class_name(index: Index, loc: Localization) -> None:
    manifest, stats = build(index, loc)
    prototype = next(i for i in manifest.items if "prototype" in i.class_name)
    assert prototype.name == prototype.class_name
    assert stats.unresolved_names >= 1
    assert "@item_Name_missing" in loc.missing


def test_manufacturer_reference_resolves(index: Index, loc: Localization) -> None:
    manifest, _ = build(index, loc)
    helmet = next(i for i in manifest.items if i.class_name.endswith("helmet_light_slate"))
    assert helmet.manufacturer == Manufacturer(code="AEG", name="Aegis Dynamics")


def test_geometry_paths_are_normalized_and_paired(index: Index, loc: Localization) -> None:
    manifest, _ = build(index, loc)
    helmet = next(i for i in manifest.items if i.class_name.endswith("helmet_light_slate"))
    assert helmet.geometry[0].source == (
        "Data/Objects/Characters/Human/male_v7/aeg/pathfinder/helmet.skin"
    ), "backslashes must be normalized"

    arms = next(i for i in manifest.items if i.slot == "arms")
    assert [g.side for g in arms.geometry] == ["left", "right"]
    assert len(arms.geometry) == 2


def test_components_may_be_a_list(index: Index, loc: Localization) -> None:
    manifest, _ = build(index, loc)
    arms = next(i for i in manifest.items if i.slot == "arms")
    assert arms.manufacturer.code == "RSI"
    assert arms.weight_class == "medium"


def test_flags_mark_test_and_missing_geometry(index: Index, loc: Localization) -> None:
    manifest, _ = build(index, loc)
    prototype = next(i for i in manifest.items if "prototype" in i.class_name)
    assert "test" in prototype.flags
    assert "no_geometry" in prototype.flags


def test_stats_keep_only_known_fields(index: Index, loc: Localization) -> None:
    manifest, _ = build(index, loc)
    helmet = next(i for i in manifest.items if i.class_name.endswith("helmet_light_slate"))
    assert "TemperatureResistance" in helmet.stats
    assert "IgnoredField" not in helmet.stats


def test_tags_resolve_to_names(index: Index, loc: Localization) -> None:
    manifest, _ = build(index, loc)
    helmet = next(i for i in manifest.items if i.class_name.endswith("helmet_light_slate"))
    assert helmet.tags == ["weight_light"]


def test_colour_variants_link_to_one_canonical_item(index: Index, loc: Localization) -> None:
    manifest, _ = build(index, loc)
    helmets = [i for i in manifest.items if i.slot == "helmet" and "pathfinder" in i.class_name]
    canonical = [i for i in helmets if i.variant_of is None]
    variants = [i for i in helmets if i.variant_of is not None]
    assert len(canonical) == 1
    assert len(variants) == 1
    assert variants[0].variant_of == canonical[0].id
    assert canonical[0].variants == [variants[0].id]


def test_canonical_key_strips_stacked_suffixes() -> None:
    assert catalog.canonical_key("cds_helmet_light_01_black") == "cds_helmet_light"
    assert catalog.canonical_key("cds_helmet_light") == "cds_helmet_light"


def test_set_key_groups_by_path_manufacturer_and_weight() -> None:
    from sc_extract.manifest import Geometry

    def item(path: str, code: str, weight: str) -> Item:
        return Item(
            id=path,
            class_name=path,
            name=path,
            slot="helmet",
            weight_class=weight,
            manufacturer=Manufacturer(code=code),
            geometry=[Geometry(source=path)],
        )

    a = item("a/b/aeg/pathfinder/helmet.skin", "AEG", "light")
    b = item("a/b/aeg/pathfinder/torso.skin", "AEG", "light")
    c = item("a/b/rsi/bastion/helmet.skin", "RSI", "medium")
    assert catalog.set_key(a) == catalog.set_key(b)
    assert catalog.set_key(a) != catalog.set_key(c)


def test_slot_falls_back_to_class_name_hints() -> None:
    from sc_extract.dcb import Record

    record = Record(id="x", class_name="somemaker_backpack_heavy", path=None, data={})
    assert catalog.slot_for(record) == "backpack"


def test_unknown_char_armor_type_still_maps() -> None:
    from sc_extract.dcb import Record

    data = {
        "Components": {"SAttachableComponentParams": {"AttachDef": {"Type": "Char_Armor_Legs"}}}
    }
    record = Record(id="x", class_name="unknowable", path=None, data=data)
    assert catalog.slot_for(record) == "legs"


def test_npc_items_excluded_by_default(loc: Localization) -> None:
    from sc_extract.dcb import Record

    index = Index()
    data = {
        "Components": {"SAttachableComponentParams": {"AttachDef": {"Type": "Char_Armor_Torso"}}}
    }
    index.add(Record(id="n1", class_name="npc_guard_torso", path=None, data=data))

    manifest, _ = catalog.build(index, loc)
    assert manifest.items == []

    manifest, _ = catalog.build(index, loc, include_npc=True)
    assert len(manifest.items) == 1


def test_asset_paths_collapse_repeated_separators() -> None:
    assert catalog._normalize_asset_path("Data\\\\Objects//x.skin") == "Data/Objects/x.skin"
    assert catalog._normalize_asset_path("/Data/x.skin") == "Data/x.skin"
