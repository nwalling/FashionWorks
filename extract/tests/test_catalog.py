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
    assert "cds" not in class_names, "manufacturer records are not items"
    assert stats.considered == 8
    assert stats.matched == len(manifest.items)


def test_slots_and_counts(index: Index, loc: Localization) -> None:
    manifest, _ = build(index, loc)
    counts = manifest.counts_by_slot()
    assert counts["helmet"] == 3
    assert counts["arms"] == 1
    assert counts["backpack"] == 1
    assert counts["torso"] == 0


def test_names_resolve_through_localization(index: Index, loc: Localization) -> None:
    manifest, _ = build(index, loc)
    helmet = next(i for i in manifest.items if i.class_name.endswith("helmet_02_02_01"))
    assert helmet.name == "FBL-8a Helmet SecondWind"
    assert helmet.description == "A light combat helmet, rated to -32C."
    assert helmet.name_key == "@item_Name_cds_combat_light_helmet_02_02_01"


def test_unresolved_name_falls_back_to_class_name(index: Index, loc: Localization) -> None:
    manifest, stats = build(index, loc)
    prototype = next(i for i in manifest.items if "prototype" in i.class_name)
    assert prototype.name == prototype.class_name
    assert stats.unresolved_names >= 1
    assert "@item_Name_missing" in loc.missing


def test_manufacturer_reference_resolves(index: Index, loc: Localization) -> None:
    """A file:// ref resolves to the manufacturer record, giving code and name."""
    manifest, _ = build(index, loc)
    helmet = next(i for i in manifest.items if i.class_name.endswith("helmet_02_02_01"))
    assert helmet.manufacturer.code == "CDS"
    assert helmet.manufacturer.name == "Clark Defense Systems"


def test_geometry_picks_the_worn_mesh_not_the_carry_prop(index: Index, loc: Localization) -> None:
    """The top of the geometry tree is the dropped-item prop, not the armor."""
    manifest, _ = build(index, loc)
    helmet = next(i for i in manifest.items if i.class_name.endswith("helmet_02_02_01"))
    sources = [g.source for g in helmet.geometry]
    assert sources == ["objects/characters/human/male_v7/armor/cds/m_cds_light_helmet_01.skin"]
    assert not any("carry_prop" in s for s in sources)
    assert not any("female_v2" in s for s in sources), "male skeleton was requested"
    assert not any("visor" in s for s in sources), "shared visors are not the helmet"
    assert not any("_lod" in s for s in sources)


def test_geometry_pairs_left_and_right(index: Index, loc: Localization) -> None:
    manifest, _ = build(index, loc)
    arms = next(i for i in manifest.items if i.slot == "arms")
    assert [g.side for g in arms.geometry] == ["left", "right"]
    assert len(arms.geometry) == 2


def test_female_skeleton_selects_female_meshes(index: Index, loc: Localization) -> None:
    manifest, _ = catalog.build(index, loc, game_version="test", skeleton="female")
    helmet = next(i for i in manifest.items if i.class_name.endswith("helmet_02_02_01"))
    assert helmet.geometry[0].source.startswith("objects/characters/human/female_v2/")


def test_backpacks_bind_to_a_socket(index: Index, loc: Localization) -> None:
    manifest, _ = build(index, loc)
    backpack = next(i for i in manifest.items if i.slot == "backpack")
    assert backpack.geometry[0].source.endswith(".cga")
    assert backpack.bind_mode == "socket"


def test_backslashes_are_normalized(index: Index, loc: Localization) -> None:
    manifest, _ = build(index, loc)
    for item in manifest.items:
        for geometry in item.geometry:
            assert "\\" not in geometry.source


def test_manufacturer_falls_back_to_the_code_in_the_reference(
    index: Index, loc: Localization
) -> None:
    """Refs are file:// paths ending <type>.<code>.json."""
    manifest, _ = build(index, loc)
    arms = next(i for i in manifest.items if i.slot == "arms")
    assert arms.manufacturer.code == "RSI"
    assert arms.weight_class == "medium", "SubType carries the weight class"


def test_flags_mark_test_and_missing_geometry(index: Index, loc: Localization) -> None:
    manifest, _ = build(index, loc)
    prototype = next(i for i in manifest.items if "prototype" in i.class_name)
    assert "test" in prototype.flags
    assert "no_geometry" in prototype.flags


def test_stats_keep_only_known_fields(index: Index, loc: Localization) -> None:
    manifest, _ = build(index, loc)
    helmet = next(i for i in manifest.items if i.class_name.endswith("helmet_02_02_01"))
    assert "TemperatureResistance" in helmet.stats
    assert "RadiationResistance" in helmet.stats
    assert "IgnoredField" not in helmet.stats


def test_tags_split_from_a_space_separated_string(index: Index, loc: Localization) -> None:
    manifest, _ = build(index, loc)
    helmet = next(i for i in manifest.items if i.class_name.endswith("helmet_02_02_01"))
    assert helmet.tags == ["Marine_Light", "Set_02", "Color_01", "Helmet"]


def test_colour_variants_link_to_one_canonical_item(index: Index, loc: Localization) -> None:
    """Same set and slot, differing Color_ tag, means one entry with swatches."""
    manifest, _ = build(index, loc)
    helmets = [i for i in manifest.items if i.slot == "helmet" and "helmet_02_0" in i.class_name]
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
