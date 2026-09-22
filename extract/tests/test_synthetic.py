from __future__ import annotations

import json
from pathlib import Path

from sc_extract.config import load_settings
from sc_extract.synthetic import build_manifest

CONFIG = '[paths]\nsc_root = ""\nout_dir = "out"\n'


def test_descriptors_become_a_valid_manifest(tmp_path: Path) -> None:
    config = tmp_path / "settings.toml"
    config.write_text(CONFIG)
    settings = load_settings(config, local_path=None, environ={}, root=tmp_path)

    descriptors = tmp_path / "synth-items.json"
    descriptors.write_text(
        json.dumps(
            {
                "skeleton": "male",
                "sockets": ["back_socket"],
                "base_glb": "base/male.glb",
                "items": [
                    {
                        "id": "a",
                        "class_name": "set_helmet_slate",
                        "name": "Aegis Vanguard Helmet (Slate)",
                        "slot": "helmet",
                        "weight_class": "light",
                        "manufacturer": {"code": "AEG", "name": "Aegis"},
                        "set": "set",
                        "bind_mode": "skinned",
                        "socket": None,
                        "glb": "items/a/item.glb",
                        "color": [1, 0, 0, 1],
                        "flags": ["synthetic"],
                    },
                    {
                        "id": "b",
                        "class_name": "set_helmet_sand",
                        "name": "Aegis Vanguard Helmet (Sand)",
                        "slot": "helmet",
                        "weight_class": "light",
                        "manufacturer": {"code": "AEG", "name": "Aegis"},
                        "set": "set",
                        "bind_mode": "skinned",
                        "socket": None,
                        "glb": "items/b/item.glb",
                        "color": [0, 1, 0, 1],
                        "flags": ["synthetic"],
                    },
                    {
                        "id": "c",
                        "class_name": "set_backpack_slate",
                        "name": "Aegis Vanguard Backpack (Slate)",
                        "slot": "backpack",
                        "weight_class": "light",
                        "manufacturer": {"code": "AEG", "name": "Aegis"},
                        "set": "set",
                        "bind_mode": "socket",
                        "socket": "back_socket",
                        "glb": "items/c/item.glb",
                        "color": [0, 0, 1, 1],
                        "flags": ["synthetic"],
                    },
                ],
            }
        )
    )

    manifest = build_manifest(settings, descriptors)
    assert len(manifest.items) == 3
    assert manifest.skeletons["male"].glb == "base/male.glb"
    assert manifest.sockets == ["back_socket"]

    backpack = next(i for i in manifest.items if i.slot == "backpack")
    assert backpack.bind_mode == "socket"
    assert backpack.socket == "back_socket"

    helmets = [i for i in manifest.items if i.slot == "helmet"]
    assert sum(1 for i in helmets if i.variant_of) == 1, "colour variants must link"
    assert all(i.set == "set" for i in manifest.items)
