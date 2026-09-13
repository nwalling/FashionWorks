"""Character Definition File (``.cdf``) parsing.

Helmets (and some other pieces) do not point at a mesh directly. The DataCore
geometry path names a ``.cdf``, a CryXML document that lists the real meshes:

    <CharacterDefinition>
      <Model File="...m_cds_combat_light_helmet_03_prop_skeleton.chr" />
      <AttachmentList>
        <Attachment Type="CA_SKIN" AName="helmet"
                    Binding="...m_cds_combat_light_helmet_03_prop.skin"
                    Material="...m_cds_combat_light_03_01_01.mtl" />
      </AttachmentList>
    </CharacterDefinition>

Attachment types seen across all 640 male armor CDFs in build 1.0.191.55227:

===========  =====  =========================================================
Type         Count  Meaning
===========  =====  =========================================================
CA_SKIN        751  skinned mesh; ``Binding`` is the .skin
CA_BONE        186  rigid mesh on a bone; adds BoneName/RelPosition/RelRotation
CA_PROX        173  collision proxy; not renderable
CA_PROW        302  simulated rope/cloth strand; not renderable in v1
===========  =====  =========================================================

Extract these with ``--convert cryxml`` so they arrive as readable XML.
"""

from __future__ import annotations

import logging
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger(__name__)

RENDERABLE_TYPES = ("CA_SKIN", "CA_BONE")
SKINNED_TYPE = "CA_SKIN"
BONE_TYPE = "CA_BONE"


def normalize(path: str | None) -> str | None:
    """CryEngine paths use backslashes and inconsistent case."""
    if not path:
        return None
    return path.replace("\\", "/").strip().lstrip("/")


def _floats(value: str | None) -> tuple[float, ...] | None:
    if not value:
        return None
    parts = value.replace(",", " ").split()
    try:
        return tuple(float(p) for p in parts)
    except ValueError:
        return None


@dataclass
class Attachment:
    """One entry from a CDF's AttachmentList."""

    type: str
    name: str | None = None
    binding: str | None = None
    material: str | None = None
    bone: str | None = None
    position: tuple[float, ...] | None = None
    rotation: tuple[float, ...] | None = None

    @property
    def renderable(self) -> bool:
        return self.type in RENDERABLE_TYPES and bool(self.binding)

    @property
    def bind_mode(self) -> str:
        return "socket" if self.type == BONE_TYPE else "skinned"


@dataclass
class CharacterDefinition:
    """A parsed ``.cdf``."""

    source: Path | None = None
    model: str | None = None
    attachments: list[Attachment] = field(default_factory=list)

    def renderable(self) -> list[Attachment]:
        return [a for a in self.attachments if a.renderable]

    def skins(self) -> list[Attachment]:
        return [a for a in self.attachments if a.type == SKINNED_TYPE and a.binding]

    def bone_attachments(self) -> list[Attachment]:
        return [a for a in self.attachments if a.type == BONE_TYPE and a.binding]


def parse_text(text: str, *, source: Path | None = None) -> CharacterDefinition:
    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        log.warning("unparseable CDF %s: %s", source, exc)
        return CharacterDefinition(source=source)

    model_node = root.find("Model")
    model = normalize(model_node.get("File")) if model_node is not None else None

    attachments: list[Attachment] = []
    for node in root.findall(".//Attachment"):
        attachments.append(
            Attachment(
                type=(node.get("Type") or "").strip(),
                name=node.get("AName"),
                binding=normalize(node.get("Binding")),
                material=normalize(node.get("Material")),
                bone=node.get("BoneName"),
                position=_floats(node.get("RelPosition")),
                rotation=_floats(node.get("RelRotation")),
            )
        )
    return CharacterDefinition(source=source, model=model, attachments=attachments)


def parse(path: Path) -> CharacterDefinition:
    if not path.is_file():
        log.warning("CDF not found: %s", path)
        return CharacterDefinition(source=path)
    return parse_text(path.read_text(encoding="utf-8", errors="replace"), source=path)
