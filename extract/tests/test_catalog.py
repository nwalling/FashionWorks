from __future__ import annotations

from sc_extract import catalog
from sc_extract.catalog import GeoNode
from sc_extract.dcb import Index, Record
from sc_extract.localization import Localization
from sc_extract.manifest import Item, Manufacturer


def build(index: Index, loc: Localization, **kwargs):
    return catalog.build(index, loc, game_version="test", **kwargs)


def test_only_armor_records_become_items(index: Index, loc: Localization) -> None:
    manifest, stats = build(index, loc)
    class_names = {item.class_name for item in manifest.items}
    assert "behr_p8sc_smg" not in class_names, "weapons must not enter the armor catalog"
    assert "cds" not in class_names, "manufacturer records are not items"
    # Six entities. The two SCItemManufacturer records are not considered at
    # all now: only entities describe an item, and the export carries the
    # others so they can be looked up.
    assert stats.considered == 6
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


def test_set_key_groups_by_product_name() -> None:
    """The display name is the set, because the game's own grouping is not.

    ``Set_<n>`` is present on part of a family and absent from the rest. Corbel
    is the case that exposed it: four helmets carry ``Set_01`` and land on the
    shared ``cds_heavy_set01``, the arms, legs and core carry no set tag and
    fall back to a path key, and one helmet has no manufacturer code and lands
    on a third key -- so "equip full set" could never assemble it.
    """
    from sc_extract.manifest import Geometry

    def item(name: str, slot: str, *, tags: list[str] | None = None,
             code: str = "CDS", weight: str = "heavy", flags: list[str] | None = None) -> Item:
        return Item(
            id=name, class_name=name.lower().replace(" ", "_"), name=name, slot=slot,
            weight_class=weight, manufacturer=Manufacturer(code=code),
            geometry=[Geometry(source=f"objects/{slot}.skin")],
            tags=tags or [], flags=flags or [],
        )

    # The real Corbel shape: a tagged helmet, and untagged arms/legs/core.
    helmet = item("Corbel Helmet Halcyon", "helmet", tags=["Set_01", "Color_01"])
    arms = item("Corbel Arms Halcyon", "arms")
    legs = item("Corbel Legs Halcyon", "legs")
    core = item("Corbel Core Halcyon", "torso")
    keys = {catalog.set_key(i) for i in (helmet, arms, legs, core)}
    assert keys == {"corbel"}, f"Corbel must be one set, got {keys}"

    # A different product with the same manufacturer and weight stays separate,
    # where the old path+manufacturer+weight key merged them.
    other = item("Defiance Core Tactical", "torso")
    assert catalog.set_key(other) != catalog.set_key(core)

    # The product part ends at the slot word, so these do not collapse onto
    # a shared first word.
    assert catalog.set_key(item("The Butcher Helmet", "helmet")) != catalog.set_key(
        item("The Hill Horror Helmet", "helmet")
    )
    assert catalog.set_key(item("Odyssey II Racing Helmet Alpha", "helmet")) != catalog.set_key(
        item("Odyssey Helmet Tan", "helmet")
    )


def test_set_key_falls_back_when_the_name_did_not_resolve() -> None:
    """An ``unnamed`` item has no product name, so the old scheme still applies."""
    from sc_extract.manifest import Geometry

    def item(path: str, code: str, weight: str) -> Item:
        return Item(
            id=path, class_name=path, name=path, slot="helmet", weight_class=weight,
            manufacturer=Manufacturer(code=code), geometry=[Geometry(source=path)],
            flags=["unnamed"],
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


def _clothing(attach_type: str, class_name: str, path: str | None = None, **params):
    from pathlib import Path

    data = {
        "_RecordName_": f"EntityClassDefinition.{class_name}",
        "Components": [
            {"_Type_": "SAttachableComponentParams", "AttachDef": {"Type": attach_type}},
            {"_Type_": "SCItemClothingParams", **params},
        ],
    }
    return Record(
        id=class_name, class_name=class_name, path=Path(path) if path else None, data=data
    )


def test_clothing_types_map_to_clothing_slots() -> None:
    cases = {
        "Char_Clothing_Hat": "hat",
        "Char_Clothing_Torso_0": "shirt",
        "Char_Clothing_Torso_1": "jacket",
        "Char_Clothing_Torso_2": "accessory",
        "Char_Clothing_Hands": "gloves",
        "Char_Clothing_Legs": "trousers",
        "Char_Clothing_Feet": "footwear",
        "Char_Clothing_Backpack": "pack",
    }
    for attach_type, slot in cases.items():
        assert catalog.slot_for(_clothing(attach_type, "x_01_01_01")) == slot


def test_a_clothing_type_wins_over_an_armour_name() -> None:
    # The Ready-Up Helmet is a hat in the game's data; its name used to make it
    # an armour helmet.
    record = _clothing("Char_Clothing_Hat", "gys_helmet_01_01_01")
    assert catalog.slot_for(record) == "hat"


def test_chunks_and_hidden_parts_are_read(loc: Localization) -> None:
    index = Index()
    index.add(
        _clothing(
            "Char_Clothing_Torso_1",
            "drn_jacket_01_01_01",
            HiddenParts=[
                {"_Type_": "SCItemClothingHiddenPartsParams", "PortName": "Clothing_Torso_0"},
                {"_Type_": "SCItemClothingHiddenPartsParams", "PortName": "Clothing_Legs"},
                {"_Type_": "SCItemClothingHiddenPartsParams", "PortName": "Clothing_Torso_0"},
            ],
            Chunks=[
                {"MeshChunk": "torso01_zone", "Layer": 2, "VisibleLayers": []},
                {"MeshChunk": "l_arm05_zone", "Layer": 2, "VisibleLayers": [0]},
                {"MeshChunk": "", "Layer": 2},
            ],
        )
    )
    manifest, _ = catalog.build(index, loc)
    (item,) = manifest.items
    assert item.slot == "jacket"
    assert item.outfit == "clothing"
    assert item.hidden == ["Clothing_Torso_0", "Clothing_Legs"]
    assert item.chunks == [
        {"zone": "torso01_zone", "layer": 2, "visible": []},
        {"zone": "l_arm05_zone", "layer": 2, "visible": [0]},
    ]
    assert "Chunks" not in item.stats


def test_squadron42_uniforms_are_flagged(loc: Localization) -> None:
    index = Index()
    root = "libs/foundry/records/entities/scitem/characters/human/clothing"
    index.add(
        _clothing(
            "Char_Clothing_Legs",
            "sc_nvy_bdu_pants_01_01_01",
            f"{root}/s42_clothing/s42_clothing_legs/sc_nvy_bdu_pants_01_01_01.json",
        )
    )
    index.add(
        _clothing(
            "Char_Clothing_Legs",
            "dmc_pants_05_01_01",
            f"{root}/pu_clothing/clothing_legs/dmc_pants_05_01_01.json",
        )
    )
    manifest, _ = catalog.build(index, loc)
    flags = {i.class_name: i.flags for i in manifest.items}
    assert "squadron42" in flags["sc_nvy_bdu_pants_01_01_01"]
    assert "squadron42" not in flags["dmc_pants_05_01_01"]


def test_a_garment_ends_a_clothing_product_and_only_a_clothing_one() -> None:
    assert catalog.product_key("Toughlife Boots Dark Red", "footwear") == "toughlife"
    assert catalog.product_key("Keldur Hat and Hickory Goggles", "hat") == "keldur"
    assert catalog.product_key("Bello T-Shirt Maroon", "shirt") == "bello"
    # Armour never reads the garment list, so no armour key can move.
    assert catalog.product_key("Toughlife Boots Dark Red", "legs") == "toughlife boots dark red"
    assert catalog.product_key("Toughlife Boots Dark Red") == "toughlife boots dark red"


def test_npc_items_excluded_by_default(loc: Localization) -> None:
    from sc_extract.dcb import Record

    index = Index()
    data = {
        # A real record names its own type here, and the catalogue now reads it:
        # only entities become items. Without it this record is a typeless one
        # the build skips, which is not what this test is about.
        "_RecordName_": "EntityClassDefinition.npc_guard_torso",
        "Components": {"SAttachableComponentParams": {"AttachDef": {"Type": "Char_Armor_Torso"}}},
    }
    index.add(Record(id="n1", class_name="npc_guard_torso", path=None, data=data))

    manifest, _ = catalog.build(index, loc)
    assert manifest.items == []

    manifest, _ = catalog.build(index, loc, include_npc=True)
    assert len(manifest.items) == 1


def test_asset_paths_collapse_repeated_separators() -> None:
    assert catalog._normalize_asset_path("Data\\\\Objects//x.skin") == "Data/Objects/x.skin"
    assert catalog._normalize_asset_path("/Data/x.skin") == "Data/x.skin"


def test_a_rigid_piece_finds_its_palette_off_the_worn_node() -> None:
    """Backpacks hang the palette on a node that is not the worn mesh.

    The CSP-68H Red Alert names its IAE palette on one geometry node, and it is
    not the one select_wearables keeps. Searching only the worn nodes found
    nothing, so 16 of the pack's 23 palette-tinted layers fell back to neutral
    grey and the red pack rendered grey.
    """
    worn = [GeoNode(path="backpack.cga", material="m.mtl", depth=1, palette=None)]
    other = worn + [
        GeoNode(path="prop.cgf", material=None, depth=0, palette="file://./pal.json")
    ]

    assert catalog.tint_for(worn, _EmptyIndex()) is None
    found = catalog.tint_for(worn, _EmptyIndex(), fallback=other)
    assert found is not None
    assert found["palette_ref"] == "pal"


class _EmptyIndex:
    """Enough of Index for tint_for: a ref that resolves to nothing."""

    @staticmethod
    def resolve_ref(_ref, *, record_type=None):
        return None

    @staticmethod
    def ref_name(ref):
        from sc_extract.dcb import Index

        return Index.ref_name(ref)


def test_a_reference_resolves_to_the_right_record_type() -> None:
    """A record name is not unique across types.

    The VGL Warden backpack ships an entity and a tint palette both named
    vgl_combat_heavy_backpack_01_03_01. Whichever loaded first used to win the
    name, so 165 items resolved their palette reference to an entity record and
    came out with no colours.
    """
    from pathlib import Path

    from sc_extract.dcb import Index, Record

    entity = Record(
        id="e1",
        class_name="shared_name",
        path=Path("entity.json"),
        data={"_RecordName_": "EntityClassDefinition.shared_name"},
    )
    palette = Record(
        id="p1",
        class_name="shared_name",
        path=Path("palette.json"),
        data={"_RecordName_": "TintPaletteTree.shared_name"},
    )
    index = Index()
    index.add(entity)
    index.add(palette)

    assert index.resolve_ref("file://./shared_name.json") is entity
    assert index.resolve_ref("file://./shared_name.json", record_type="TintPaletteTree") is palette
    assert entity.record_type == "EntityClassDefinition"
    assert palette.record_type == "TintPaletteTree"


_ARMOR = "Objects/Characters/Human"


def _geometry_record(male_material: str | None, female_material: str | None) -> Record:
    """A record shaped like the real ones: crate at the root, a skin per gender."""

    def node(path: str, material: str | None) -> dict:
        inner: dict = {"Geometry": {"path": path}}
        if material is not None:
            inner["Material"] = {"path": material}
        return {"Geometry": inner}

    return Record(
        id="x",
        class_name="cds_armor_heavy_arms_01_01_01",
        path=None,
        data={
            "_RecordValue_": {
                "Components": [
                    {
                        "_Type_": "SGeometryResourceParams",
                        "Geometry": {
                            "Geometry": {
                                "Geometry": {"path": "crate_armor_arms_1_005x005x005.cgf"}
                            },
                            "SubGeometry": [
                                node(f"{_ARMOR}/female_v2/f_cds_heavy_armor_01_arms.skin", female_material),
                                node(f"{_ARMOR}/male_v7/m_cds_heavy_armor_01_arms.skin", male_material),
                            ],
                        },
                    }
                ]
            }
        },
    )


def test_material_falls_back_to_the_other_gender_s_worn_node() -> None:
    """The material is often authored on one gender's node only.

    ADP, Aril and Aves put it on the female skin and leave the male one null.
    An item with no material does not render untinted -- it wears whatever
    baked the shared GLB, which is how Citadel-SE Arms Maroon came out as
    Citadel Arms Brimstone. 82 of 146 such items are this case.
    """
    record = _geometry_record(male_material=None, female_material="m_cds_heavy_armor.mtl")
    assert catalog.materials_for(record, "male") == ["m_cds_heavy_armor.mtl"]

    # The male node's own material still wins when it has one.
    record = _geometry_record(male_material="male.mtl", female_material="female.mtl")
    assert catalog.materials_for(record, "male") == ["male.mtl"]


def test_material_fallback_never_takes_the_carry_crate_s() -> None:
    """The root node is the dropped-item prop, and its material is a crate.

    Falling back to *any* node rather than to the other skeleton's worn node
    would paint the armour as a storage box.
    """
    record = _geometry_record(male_material=None, female_material=None)
    record.data["_RecordValue_"]["Components"][0]["Geometry"]["Geometry"]["Material"] = {
        "path": "crate_armor.mtl"
    }
    assert catalog.materials_for(record, "male") == []
