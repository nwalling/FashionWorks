import { describe, expect, it } from 'vitest';

import type { CatalogueItem, WearSlot } from '../src/archive/catalogue';
import { layerOf, outfitFor, outfitSlots, viewOf } from '../src/three/outfit';

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

describe('the layer a piece sits at', () => {
  it('is its chunks\' when it has them, else its slot\'s', () => {
    expect(layerOf(item('jacket', { chunks: [{ zone: 'torso01_zone', layer: 2, visible: [] }] }))).toBe(2);
    expect(layerOf(item('footwear'))).toBe(1);
    expect(layerOf(item('undersuit'))).toBe(3);
    expect(layerOf(item('torso'))).toBe(4);
  });
});
