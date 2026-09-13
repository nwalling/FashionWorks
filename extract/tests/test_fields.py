from __future__ import annotations

from sc_extract import fields as F


def test_dotted_lookup() -> None:
    assert F.get({"a": {"b": {"c": 1}}}, "a.b.c") == 1


def test_missing_returns_sentinel() -> None:
    assert F.get({"a": 1}, "a.b") is F.MISSING


def test_list_wildcard() -> None:
    data = {"Components": [{"X": 1}, {"Y": {"Z": 2}}]}
    assert F.get(data, "Components.[].Y.Z") == 2


def test_implicit_list_mapping() -> None:
    """A list of components resolves without an explicit [] segment."""
    data = {"Components": [{"X": 1}, {"Y": {"Z": 2}}]}
    assert F.get(data, "Components.Y.Z") == 2


def test_dict_wildcard() -> None:
    assert F.get({"a": {"p": {"z": 3}, "q": {}}}, "a.*.z") == 3


def test_at_prefixed_and_lowercase_keys() -> None:
    assert F.get({"@Type": "x"}, "Type") == "x"
    assert F.get({"type": "x"}, "Type") == "x"


def test_first_skips_empty_values() -> None:
    data = {"a": "", "b": [], "c": {}, "d": "hit"}
    assert F.first(data, ["a", "b", "c", "d"]) == "hit"


def test_first_returns_default() -> None:
    assert F.first({}, ["a", "b"], "fallback") == "fallback"


def test_collect_dedupes() -> None:
    data = {"a": "x", "b": "x", "c": "y"}
    assert F.collect(data, ["a", "b", "c"]) == ["x", "y"]


def test_armor_attach_types_cover_every_slot() -> None:
    from sc_extract.manifest import SLOTS

    assert set(F.ARMOR_ATTACH_TYPES.values()) == set(SLOTS)
