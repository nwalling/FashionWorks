from __future__ import annotations

from pathlib import Path

from sc_extract import gear
from sc_extract.dcb import Record


def record(class_name: str, components: list[dict], path: str = "") -> Record:
    return Record(
        id=f"id-{class_name}",
        class_name=class_name,
        path=Path(path or f"libs/foundry/records/entities/scitem/weapons/fps_weapons/{class_name}.json"),
        data={"_RecordName_": f"EntityClassDefinition.{class_name}",
              "_RecordValue_": {"_Type_": "EntityClassDefinition", "Components": components}},
    )


def port(name: str, types: list[dict], lo: int, hi: int, helper: str, offset: str, bone: bool = True) -> dict:
    return {
        "Name": name, "MinSize": lo, "MaxSize": hi, "Types": types,
        "Extension": {"SelectTag": "backRight"},
        "AttachmentImplementation": {
            "_Type_": gear.BONE_IMPLEMENTATION if bone else "SItemPortDefAttachmentImplementationSkin",
            "Helper": {"Helper": {"Name": helper, "ItemOffsetHelperName": offset}},
        },
    }


def test_a_holster_is_a_bone_port_with_its_types_and_sizes() -> None:
    torso = record("heavy_core", [{
        "_Type_": gear.PORT_COMPONENT,
        "Ports": [
            port("wep_stocked_3", [{"Type": "WeaponPersonal", "SubTypes": ["Medium", "Large", ""]}, {"Type": ""}],
                 2, 5, "wep_stocked_attach_3_override", "attach_offset_left_01"),
            port("Armor_Arms", [{"Type": "Char_Armor_Arms", "SubTypes": []}], 1, 1, "LeftForeArm", "", bone=False),
        ],
    }])
    ports = gear.ports_for(torso)
    assert [p["name"] for p in ports] == ["wep_stocked_3"], "skin ports layer armour, they hold nothing"
    assert ports[0]["types"] == [{"type": "WeaponPersonal", "subtypes": ["Medium", "Large"]}]
    assert (ports[0]["min_size"], ports[0]["max_size"]) == (2, 5)
    assert ports[0]["offset"] == "attach_offset_left_01"


def test_slots_follow_the_attach_type() -> None:
    assert gear.gear_slot_for("WeaponPersonal", "Large") == "primary"
    assert gear.gear_slot_for("WeaponPersonal", "Small") == "sidearm"
    assert gear.gear_slot_for("WeaponAttachment", "IronSight") is None, "optics are a later phase"
    assert gear.gear_slot_for("FPS_Consumable", "Hacking") is None, "hacking chips are out"
    assert gear.gear_slot_for("Gadget", "Gadget") == "gadget"


def test_a_colourway_wears_the_child_its_geometry_tags_name() -> None:
    def node(path: str, tags: str = "", material: str = "", palette: str | None = None) -> dict:
        return {"Tags": tags, "Geometry": {"Geometry": {"path": path}, "Material": {"path": material},
                                          "Palette": {"RootRecord": palette}}}

    root = node("objects/p4ar.cdf", palette="file://default.json")
    root["SubGeometry"] = [
        node("objects/p4ar.cdf", "Green01", material="objects/p4ar_green.mtl"),
        node("objects/p4ar.cdf", "Tint01", palette="file://black.json"),
    ]
    rifle = record("behr_rifle_ballistic_01_tint01", [
        {"_Type_": gear.WEAPON_COMPONENT, "geometryTags": "Tint01"},
        {"_Type_": "SGeometryResourceParams", "Geometry": root},
    ])
    chosen = gear.selected_node(rifle)
    assert chosen is not None
    assert chosen.palette == "file://black.json"
    assert chosen.material is None


def test_default_children_are_what_ships_in_the_ports() -> None:
    rifle = record("behr_rifle_ballistic_01", [{
        "_Type_": gear.LOADOUT_COMPONENT,
        "loadout": {"entries": [
            {"itemPortName": "magazine_attach", "entityClassName": "behr_rifle_ballistic_01_mag"},
            {"itemPortName": "optics_attach", "entityClassName": ""},
        ]},
    }])
    assert gear.default_children_for(rifle) == [
        {"port": "magazine_attach", "class_name": "behr_rifle_ballistic_01_mag"},
    ]


def test_scope_keeps_ship_guns_and_dev_out() -> None:
    assert gear.in_scope(record("a", []))
    assert not gear.in_scope(record("b", [], "libs/foundry/records/entities/scitem/weapons/weapon_mounted/b.json"))
    assert not gear.in_scope(record("c", [], "libs/foundry/records/entities/scitem/weapons/fps_weapons/dev/c.json"))


def test_colourways_link_on_the_mesh() -> None:
    from sc_extract.manifest import GearItem, Geometry

    items = [
        GearItem(id="1", class_name="behr_rifle_ballistic_01", name="P4-AR Rifle", slot="primary",
                 geometry=[Geometry(source="p4ar.cdf")]),
        GearItem(id="2", class_name="behr_rifle_ballistic_01_tint01", name='P4-AR "Blacklist" Rifle',
                 slot="primary", geometry=[Geometry(source="P4AR.cdf")]),
        GearItem(id="3", class_name="gmni_pistol_01", name="LH86 Pistol", slot="sidearm",
                 geometry=[Geometry(source="lh86.cdf")]),
    ]
    gear.link_gear_variants(items)
    assert items[1].variant_of == "1", "a quoted edition mid-name is still the same rifle"
    assert items[0].variants == ["2"]
    assert items[2].variant_of is None
