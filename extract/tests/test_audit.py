from __future__ import annotations

from sc_extract import audit
from sc_extract.manifest import Assets, Item, Manifest, MaterialOverride


def _item(name: str, *, glb: str | None = None, materials=None, overrides=None,
          variant_of: str | None = None, slot: str = "arms") -> Item:
    return Item(
        id=name.lower().replace(" ", "-"),
        class_name=name.lower().replace(" ", "_"),
        name=name,
        slot=slot,
        materials=materials or [],
        material_overrides=overrides or [],
        variant_of=variant_of,
        assets=Assets(glb=glb, thumb=None),
    )


def _manifest(*items: Item) -> Manifest:
    return Manifest(items=list(items))


def _report(check, manifest: Manifest) -> audit.AuditReport:
    report = audit.AuditReport()
    check(None, manifest, report)  # these two checks never touch settings
    return report


def test_an_item_with_no_surface_is_reported_as_borrowing_one() -> None:
    """A variant with no material wears whatever baked the shared GLB.

    Citadel-SE Arms Maroon rendered as Citadel Arms Brimstone this way, which
    is worse than a missing texture because it looks deliberate.
    """
    shared = "items/abc/item.glb"
    manifest = _manifest(
        _item("Citadel Arms Brimstone", glb=shared, materials=["brimstone.mtl"]),
        _item("Citadel-SE Arms Maroon", glb=shared, variant_of="citadel-arms-brimstone"),
    )
    report = _report(audit.check_has_own_surface, manifest)
    assert report.counts["surface-borrowed"] == 1
    finding = next(f for f in report.findings if f.check == "surface-borrowed")
    assert finding.item == "Citadel-SE Arms Maroon"
    assert "Citadel Arms Brimstone" in finding.detail


def test_an_item_alone_on_its_mesh_is_only_a_warning() -> None:
    """Nothing else baked that GLB, so there is no wrong surface to inherit."""
    manifest = _manifest(_item("Palatino Arms Mark I", glb="items/solo/item.glb"))
    report = _report(audit.check_has_own_surface, manifest)
    assert report.counts["surface-borrowed"] == 0
    assert report.counts["surface-missing"] == 1


def test_an_item_with_its_own_material_is_not_reported() -> None:
    manifest = _manifest(
        _item("Aril Arms", glb="items/x/item.glb", materials=["aril.mtl"]),
        _item("Aril Arms Black Cherry", glb="items/x/item.glb",
              overrides=[MaterialOverride(name="arms_m", base_color="a.png", orm="a_orm.png")]),
    )
    report = _report(audit.check_has_own_surface, manifest)
    assert report.findings == []


def test_two_colourways_baking_the_same_textures_are_reported() -> None:
    """The palette-specular bug presented exactly this way.

    Lynx Blue, Green, Purple, Seagreen and Violet baked byte-identical textures
    because layered_key hashed only the palette's colour while their whole
    colourway lives in its specular.
    """
    same = [MaterialOverride(name="gauntlets_m", base_color="g__abc_albedo.png",
                             orm="g__abc_orm.png")]
    manifest = _manifest(
        _item("Lynx Arms Blue", glb="g", overrides=same, variant_of="lynx"),
        _item("Lynx Arms Green", glb="g", overrides=list(same), variant_of="lynx"),
    )
    report = _report(audit.check_variant_surfaces_differ, manifest)
    assert report.counts["variant-surfaces-identical"] == 1
    assert "Lynx Arms Green" in report.findings[0].detail


def test_colourways_with_different_bakes_are_not_reported() -> None:
    manifest = _manifest(
        _item("Lynx Arms Blue", glb="g", variant_of="lynx",
              overrides=[MaterialOverride(name="g_m", base_color="b.png", orm="b_orm.png")]),
        _item("Lynx Arms Green", glb="g", variant_of="lynx",
              overrides=[MaterialOverride(name="g_m", base_color="g.png", orm="g_orm.png")]),
    )
    report = _report(audit.check_variant_surfaces_differ, manifest)
    assert report.findings == []
