import { describe, expect, it } from 'vitest';

import type { CatalogueItem, WearSlot } from '../src/archive/catalogue';
import { addedTags, holdsTag, layerOf, offZones, outfitFor, outfitSlots, portHolders, viewOf } from '../src/three/outfit';

function item(slot: WearSlot, partial: Partial<CatalogueItem> = {}): CatalogueItem {
  return {
    id: `${slot}-1`,
    class_name: `${slot}_01`,
    name: slot,
    slot,
    set: null,
    variant_of: null,
    bind_mode: 'skinned',
    socket: null,
    flags: [],
    weight_class: null,
    geometry: [{ source: `${slot}.skin`, side: null }],
    materials: [],
    ...partial,
  };
}

const worn = (...items: CatalogueItem[]) => new Map(items.map((i) => [i.slot as WearSlot, i]));

describe('the outfits', () => {
  it('keeps armour and clothing apart, and the head in neither', () => {
    expect(outfitSlots('armour')).toEqual(['helmet', 'torso', 'arms', 'legs', 'undersuit', 'backpack']);
    expect(outfitSlots('clothing')).not.toContain('hat');
    expect(outfitSlots('clothing')).toContain('jacket');
    expect(outfitFor('shirt')).toBe('clothing');
    expect(outfitFor('undersuit')).toBe('armour');
    expect(outfitFor('hat')).toBeNull();
  });
});

describe('what an outfit hides', () => {
  it('hides a piece whose port another lists', () => {
    // 288 of 558 jackets hide the shirt beneath them.
    const view = viewOf(worn(item('shirt'), item('jacket', { hidden: ['Clothing_Torso_0'] })));
    expect([...view.hiddenSlots]).toEqual(['shirt']);
  });

  it('reads port names without regard to case', () => {
    // The records spell the hair port both ways.
    expect(viewOf(worn(item('jacket', { hidden: ['Hair_itemPort'] }))).hideHair).toBe(true);
  });

  it('counts no zones for a piece that is hidden', () => {
    const shirt = item('shirt', { chunks: [{ zone: 'hips_zone', layer: 1, visible: [] }] });
    const jacket = item('jacket', {
      hidden: ['Clothing_Torso_0'],
      chunks: [{ zone: 'torso01_zone', layer: 2, visible: [] }],
    });
    expect(viewOf(worn(shirt, jacket)).chunks.map((c) => c.zone)).toEqual(['torso01_zone']);
  });

  it('hides the hair under any helmet, and the head only where the record says', () => {
    const open = viewOf(worn(item('helmet', { hidden: ['Hat_ItemPort'] })));
    expect(open.hideHair).toBe(true);
    expect(open.hideHead).toBe(false);
    const closed = viewOf(worn(item('helmet', { hidden: ['Head_ItemPort'] })));
    expect(closed.hideHead).toBe(true);
  });

  it('hides a hat under a helmet', () => {
    const view = viewOf(worn(item('hat'), item('helmet', { hidden: ['Hat_ItemPort'] })));
    expect(view.hiddenSlots.has('hat')).toBe(true);
  });
});

describe('the hair under a hat', () => {
  it('reads the tags a piece adds from its directives', () => {
    expect(addedTags(item('hat', { tags: ['cbd_hat', 'Set_03', '$hatHair+'] }))).toEqual(['hatHair']);
    expect(addedTags(item('backpack', { tags: ['$$Pack++', '$environment'] }))).toEqual(['Pack']);
  });

  it('asks for the variant a drawn hat names, the mask cut first', () => {
    expect(viewOf(worn(item('hat', { tags: ['$hatHair+'] }))).hairTag).toBe('hatHair');
    expect(viewOf(worn(item('hat', { tags: ['$hatHair+', '$hatHair_mask+'] }))).hairTag).toBe('hatHair_mask');
    expect(viewOf(worn(item('hat'))).hairTag).toBeUndefined();
  });

  it('asks for nothing from a hat a helmet hides', () => {
    const view = viewOf(worn(item('hat', { tags: ['$hatHair+'] }), item('helmet', { hidden: ['Hat_ItemPort'] })));
    expect(view.hairTag).toBeUndefined();
    expect(view.hideHair).toBe(true);
  });
});

describe('a chunk that answers to a partner', () => {
  // The Artimex helmet's cowl and breathing tube, as its record conditions them.
  const artimexHelmet = item('helmet', {
    chunks: [{ zone: 'theta_head_zone', layer: 2, visible: [] }],
    visibility: [{ zone: 'theta_head_zone', when: [[{
      ports: ['Armor_Torso'],
      active: ['Global/Manufacturer/QuirinusTech', 'Armor/FPS/Archetype/Specialist', 'Armor/FPS/Type/Medium', 'Theta/Variant'],
      disable: [],
    }]] }],
  });
  const artimexCore = item('torso', {
    tagged: ['Armor/FPS/Archetype/Specialist', 'Armor/FPS/Type/Medium', 'Global/Manufacturer/QuirinusTech', 'Theta/Variant/01'],
  });
  // A medium core from another maker: everything but the manufacturer.
  const otherCore = item('torso', {
    tagged: ['Armor/FPS/Archetype/Specialist', 'Armor/FPS/Type/Medium', 'Global/Manufacturer/RRS', 'Theta/Variant/01'],
  });

  it('holds a tag through the tree', () => {
    expect(holdsTag('Theta/Variant/01', 'Theta/Variant')).toBe(true);
    expect(holdsTag('Theta/Variant', 'Theta/Variant')).toBe(true);
    expect(holdsTag('Theta/Variants', 'Theta/Variant')).toBe(false);
    expect(holdsTag('Theta', 'Theta/Variant')).toBe(false);
  });

  it('draws the Artimex cowl only with an Artimex core', () => {
    expect(viewOf(worn(artimexHelmet, artimexCore)).off.get('helmet')).toBeUndefined();
    expect([...viewOf(worn(artimexHelmet, otherCore)).off.get('helmet') ?? []]).toEqual(['theta_head_zone']);
    expect([...viewOf(worn(artimexHelmet)).off.get('helmet') ?? []]).toEqual(['theta_head_zone']);
  });

  it('keeps covering what a chunk that is off covers', () => {
    // The Clash core's back goes off under a pack; the undersuit's chest piece
    // under the core stays covered.
    expect(viewOf(worn(artimexHelmet, otherCore)).chunks).toHaveLength(1);
  });

  it('reads a holster and the hand for gear', () => {
    // A Morozov-SH-I Stronghold pouch: off while a magazine is in its holster.
    const core = item('torso', { visibility: [{ zone: 'theta_pouch01_zone', when: [[
      { ports: ['magazine_attach_2'], active: [], disable: ['Weapon/FPS/Attachment/Magazine'] },
    ]] }] });
    const magazine = item('magazine' as WearSlot, { tagged: ['Weapon/FPS/Attachment/Magazine'] });
    expect(viewOf(worn(core)).off.get('torso')).toBeUndefined();
    expect([...viewOf(worn(core), new Map([['magazine_attach_2', magazine]])).off.get('torso') ?? []])
      .toEqual(['theta_pouch01_zone']);
    expect(viewOf(worn(core), new Map([['magazine_attach_3', magazine]])).off.get('torso')).toBeUndefined();
  });

  it('reads a core another piece hides as no core', () => {
    const view = viewOf(worn(artimexHelmet, artimexCore, item('arms', { hidden: ['Armor_Torso'] })));
    expect(view.off.get('helmet')?.has('theta_head_zone')).toBe(true);
  });

  it('draws a zone while any condition holds, and holds a condition only when every check passes', () => {
    // The Aril arms: an Aril core and an Aril pack, together.
    const arms = item('arms', { visibility: [{ zone: 'theta_arms_zone', when: [[
      { ports: ['Armor_Torso'], active: ['Armor/FPS/Set/Greycat'], disable: [] },
      { ports: ['backpack'], active: ['Armor/FPS/Set/Greycat'], disable: [] },
    ]] }] });
    const core = item('torso', { tagged: ['Armor/FPS/Set/Greycat'] });
    const pack = item('backpack', { tagged: ['Armor/FPS/Set/Greycat'] });
    expect(offZones(arms, portHolders(worn(arms, core))).has('theta_arms_zone')).toBe(true);
    expect(offZones(arms, portHolders(worn(arms, core, pack))).size).toBe(0);
    // The Arden-SL helmet: its core in either of two ports.
    const helmet = item('helmet', { visibility: [{ zone: 'theta_head_zone', when: [
      [{ ports: ['Armor_Torso'], active: ['Global/Manufacturer/RRS'], disable: [] }],
      [{ ports: ['Torso_1'], active: ['Global/Manufacturer/RRS'], disable: [] }],
    ] }] });
    expect(offZones(helmet, portHolders(worn(helmet, otherCore))).size).toBe(0);
  });

  it('draws a chunk that a tag turns off until something holding it goes on', () => {
    // The Clash core's back: drawn until any pack goes on.
    const core = item('torso', { visibility: [{ zone: 'omega_core_zone', when: [[
      { ports: ['backpack'], active: [], disable: ['Armor/FPS/Part/Backpack'] },
    ]] }] });
    expect(offZones(core, portHolders(worn(core))).size).toBe(0);
    const pack = item('backpack', { tagged: ['Armor/FPS/Part/Backpack'] });
    expect([...offZones(core, portHolders(worn(core, pack)))]).toEqual(['omega_core_zone']);
  });
});

describe('the layer a piece sits at', () => {
  it('is its chunks\' when it has them, else its slot\'s', () => {
    expect(layerOf(item('jacket', { chunks: [{ zone: 'torso01_zone', layer: 2, visible: [] }] }))).toBe(2);
    expect(layerOf(item('footwear'))).toBe(1);
    expect(layerOf(item('undersuit'))).toBe(3);
    expect(layerOf(item('torso'))).toBe(4);
  });
});
