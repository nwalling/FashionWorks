import { describe, expect, it } from 'vitest';

import { readCatalogue, type CatalogueItem, type WearSlot } from '../src/archive/catalogue';
import { kitOutfit, kitPieces, kitReach, suggestKitName } from '../src/kits';
import { snapshotView } from '../src/three/portrait';

function item(partial: Partial<CatalogueItem> & { id: string }): CatalogueItem {
  return {
    class_name: partial.id,
    name: partial.id,
    slot: 'legs',
    set: null,
    variant_of: null,
    bind_mode: 'skinned',
    socket: null,
    flags: [],
    weight_class: null,
    geometry: [{ source: 'm.skin', side: null }],
    materials: [],
    ...partial,
  };
}

const helmet = item({ id: 'helmet', slot: 'helmet', name: 'Arden-SL Helmet' });
const core = item({ id: 'core', slot: 'torso', name: 'Arden-SL Core' });
const otherCore = item({ id: 'core2', slot: 'torso', name: 'Defiance Core' });
const shirt = item({ id: 'shirt', slot: 'shirt', name: 'Deo Shirt' });
const rifle = item({ id: 'rifle', slot: 'primary', name: 'P4-AR Rifle' });
const catalogue = readCatalogue(JSON.stringify({ items: [helmet, core, otherCore, shirt], gear: [rifle] }));

describe('kits', () => {
  it('saves what is on, the gear with it, and the loadout as it stands', () => {
    const wearing = new Map<WearSlot, CatalogueItem>([['helmet', helmet], ['torso', core]]);
    const outfit = kitOutfit(wearing, new Map([['wep_stocked_3', rifle]]), 'helmet,core;wep_stocked_3=rifle', 'male');
    expect(outfit.version).toBe(1);
    expect(outfit.loadout).toBe('helmet,core;wep_stocked_3=rifle');
    expect(outfit.items).toEqual([
      { id: 'helmet', slot: 'helmet', name: 'Arden-SL Helmet' },
      { id: 'core', slot: 'torso', name: 'Arden-SL Core' },
      { id: 'rifle', slot: 'primary', name: 'P4-AR Rifle' },
    ]);
  });

  it('names a kit after its torso piece', () => {
    expect(suggestKitName(new Map<WearSlot, CatalogueItem>([['helmet', helmet], ['torso', core]]))).toBe('Arden-SL Core');
    expect(suggestKitName(new Map())).toBe('Outfit');
  });

  it('wears a blueprint kit one piece a slot, in one outfit, passing over what it cannot show', () => {
    const { wear, carry } = kitPieces(['core', 'core2', 'helmet', 'shirt', 'rifle', 'a-ship-component'], catalogue);
    // The first torso wins; the lone shirt is the other outfit and loses to two armour pieces.
    expect(wear.map((i) => i.id)).toEqual(['core', 'helmet']);
    expect(carry.map((i) => i.id)).toEqual(['rifle']);
  });

  it('counts what a kit can show', () => {
    expect(kitReach({ id: 'k', name: 'k', itemIds: ['core', 'rifle', 'nope'] }, catalogue)).toBe(2);
    const saved = kitOutfit(new Map<WearSlot, CatalogueItem>([['torso', core]]), new Map(), 'core', 'male');
    expect(kitReach({ id: 's', name: 's', outfit: saved, itemIds: [] }, catalogue)).toBe(1);
  });
});

describe('the square picture', () => {
  it('stands back along the camera\'s own direction until the figure fits', () => {
    const view = snapshotView([0, 1, 0], [0.8, 2, 0.4], [0, 0, -2], 40, 1);
    expect(view.target).toEqual([0, 1, 0]);
    expect(view.position[0]).toBeCloseTo(0);
    expect(view.position[1]).toBeCloseTo(1);
    // Two metres tall in a 40-degree square: 1 / tan(20deg) metres back.
    expect(view.position[2]).toBeCloseTo(-1 / Math.tan((20 * Math.PI) / 180));
  });
});
