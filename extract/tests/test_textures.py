from __future__ import annotations

from pathlib import Path

from sc_extract import textures


def test_channel_roles() -> None:
    assert textures.channel_role("x/y_diff.dds") == "base_color"
    assert textures.channel_role("x/y_ddna.dds.3") == "normal_gloss"
    assert textures.channel_role("x/y_spec.dds") == "specular"
    assert textures.channel_role("x/y.dds") is None


def test_base_dds_strips_mip_suffix() -> None:
    assert textures.base_dds(Path("a/x_diff.dds.5")).name == "x_diff.dds"
    assert textures.base_dds(Path("a/x_diff.dds.5a")).name == "x_diff.dds"
    assert textures.base_dds(Path("a/x_diff.dds")).name == "x_diff.dds"


def test_group_mips() -> None:
    paths = [Path("a/x_diff.dds"), Path("a/x_diff.dds.1"), Path("a/y_spec.dds")]
    groups = textures.group_mips(paths)
    assert len(groups) == 2
    assert len(groups[Path("a/x_diff.dds")]) == 2
