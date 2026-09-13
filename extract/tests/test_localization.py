from __future__ import annotations

from sc_extract.localization import Localization


def test_parses_keys_and_strips_bom(loc: Localization) -> None:
    assert loc.get("@item_Name_cds_combat_light_helmet_02_02_01") == "FBL-8a Helmet SecondWind"
    assert len(loc) == 5


def test_ignores_comments() -> None:
    table = Localization.from_lines(["; note", "# note", "[section]", "a=b"])
    assert len(table) == 1
    assert table.get("a") == "b"


def test_value_may_contain_equals() -> None:
    table = Localization.from_lines(["k=a=b=c"])
    assert table.get("k") == "a=b=c"


def test_missing_keys_are_recorded(loc: Localization) -> None:
    assert loc.get("@nope", "fallback") == "fallback"
    assert "@nope" in loc.missing


def test_case_insensitive_fallback() -> None:
    table = Localization.from_lines(["Item_Name_X=Value"])
    assert table.get("@item_name_x") == "Value"
