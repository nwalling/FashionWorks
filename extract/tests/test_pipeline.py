from __future__ import annotations

from pathlib import Path

from sc_extract import pipeline
from sc_extract.config import load_settings
from sc_extract.manifest import Geometry, Item

CONFIG = """
[paths]
sc_root = ""
raw_dir = "raw"
out_dir = "out"
interim_dir = "interim"
[convert]
blender_batch_size = 3
"""


def settings_for(tmp_path: Path):
    config = tmp_path / "settings.toml"
    config.write_text(CONFIG)
    return load_settings(config, local_path=None, environ={}, root=tmp_path)


def test_batches_are_exact() -> None:
    assert pipeline._batches([1, 2, 3, 4, 5], 2) == [[1, 2], [3, 4], [5]]
    assert pipeline._batches([], 3) == []


def test_hash_changes_with_input_content(tmp_path: Path) -> None:
    settings = settings_for(tmp_path)
    source = settings.raw_dir / "a" / "helmet.skin"
    source.parent.mkdir(parents=True)
    source.write_text("one")

    item = Item(
        id="i", class_name="c", name="n", slot="helmet", geometry=[Geometry(source="a/helmet.skin")]
    )
    first = pipeline.input_hash(settings, item)

    source.write_text("a much longer body than before")
    assert pipeline.input_hash(settings, item) != first


def test_is_current_requires_glb_and_matching_hash(tmp_path: Path) -> None:
    settings = settings_for(tmp_path)
    item = Item(id="i", class_name="c", name="n", slot="helmet", geometry=[])

    assert pipeline.is_current(settings, item) is False

    out = settings.item_dir("i")
    out.mkdir(parents=True)
    (out / "item.glb").write_bytes(b"glTF")
    assert pipeline.is_current(settings, item) is False, "no hash sidecar yet"

    (out / ".hash").write_text(pipeline.input_hash(settings, item))
    assert pipeline.is_current(settings, item) is True

    (out / ".hash").write_text("stale")
    assert pipeline.is_current(settings, item) is False
