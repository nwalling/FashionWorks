import { describe, expect, it } from 'vitest';

import {
  colourwayName,
  familyRoot,
  readCatalogue,
  sharedName,
  type CatalogueItem,
} from '../src/archive/catalogue';

function item(partial: Partial<CatalogueItem> & { id: string }): CatalogueItem {
  return {
    class_name: partial.id,
    name: null,
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

function catalogue(items: CatalogueItem[]) {
  return readCatalogue(JSON.stringify({ items }));
}

describe('reading the catalogue', () => {
  it('drops records that are not wearable', () => {
    const read = catalogue([
      item({ id: 'real', name: 'Defiance Legs' }),
      item({ id: 'shop', name: 'Shop display', flags: ['not_wearable'] }),
      item({ id: 'junk', name: 'placeholder', flags: ['placeholder'] }),
      item({ id: 'npc', name: 'npc only', flags: ['npc'] }),
    ]);
    expect(read.items.map((i) => i.id)).toEqual(['real']);
  });

  it('keeps an unnamed piece, which is real armour with an unresolved key', () => {
    // `unnamed` is deliberately not a hidden flag: the piece is real and shows
    // under its class name.
    const read = catalogue([item({ id: 'x', class_name: 'vgl_01', flags: ['unnamed'] })]);
    expect(read.items).toHaveLength(1);
  });

  it('drops a record with no geometry, which cannot be rendered', () => {
    const read = catalogue([item({ id: 'x', geometry: [] })]);
    expect(read.items).toEqual([]);
  });

  it('groups a colourway family under its root', () => {
    const read = catalogue([
      item({ id: 'root', name: 'Defiance Legs Tactical' }),
      item({ id: 'sun', name: 'Defiance Legs Sunchaser', variant_of: 'root' }),
      item({ id: 'char', name: 'Defiance Legs Charcoal', variant_of: 'root' }),
    ]);
    expect(read.families.get('root')).toHaveLength(3);
    expect(familyRoot(read.items[1]!)).toBe('root');
  });

  it('buckets by slot and sorts by display name', () => {
    const read = catalogue([
      item({ id: 'b', name: 'Beta', slot: 'helmet' }),
      item({ id: 'a', name: 'Alpha', slot: 'helmet' }),
      item({ id: 'c', name: 'Gamma', slot: 'arms' }),
    ]);
    expect(read.bySlot.get('helmet')!.map((i) => i.name)).toEqual(['Alpha', 'Beta']);
    expect(read.bySlot.get('arms')!.map((i) => i.name)).toEqual(['Gamma']);
    expect(read.bySlot.get('legs')).toEqual([]);
  });
});

describe('what a family is called', () => {
  it('takes the words its members share, not the root member s name', () => {
    // The root is often an *edition*, so titling with it hides the rest under a
    // name they do not share. This is the Defiance legs case exactly.
    expect(sharedName([
      'Defiance Legs Tactical',
      'Defiance Legs Sunchaser',
      'Defiance Legs Charcoal',
    ])).toBe('Defiance Legs');
  });

  it('falls back to the first name when nothing is shared', () => {
    expect(sharedName(['Defiance Legs Sunchaser', 'ADP-mk4 Legs Woodland']))
      .toBe('Defiance Legs Sunchaser');
  });

  it('is the name itself for a family of one', () => {
    expect(sharedName(['Defiance Legs (Modified)'])).toBe('Defiance Legs (Modified)');
  });

  it('names a colourway by what is left over', () => {
    expect(colourwayName('Defiance Legs Sunchaser', 'Defiance Legs')).toBe('Sunchaser');
    // A member whose whole name is the shared part is the plain one.
    expect(colourwayName('Defiance Legs', 'Defiance Legs')).toBe('Standard');
  });
});
