import { describe, expect, it } from 'vitest';

import {
  colourwayName,
  familyRoot,
  lineKey,
  lineOf,
  lineRepresentative,
  lineTitle,
  outfitOf,
  productLine,
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

  it('buckets clothing in its own slots, apart from armour', () => {
    const read = catalogue([
      item({ id: 'j', name: 'Adiva Jacket', slot: 'jacket', outfit: 'clothing' }),
      item({ id: 'h', name: 'Ready-Up Helmet', slot: 'hat', outfit: 'clothing' }),
    ]);
    expect(read.bySlot.get('jacket')!.map((i) => i.id)).toEqual(['j']);
    expect(read.bySlot.get('hat')!.map((i) => i.id)).toEqual(['h']);
    expect(read.bySlot.get('helmet')).toEqual([]);
    expect(outfitOf('jacket')).toBe('clothing');
    expect(outfitOf('torso')).toBe('armour');
  });

  it('titles a clothing row by its garment, as armour by its slot', () => {
    const read = catalogue([
      item({ id: 'a', name: 'Frontier 05 Pants Classic', slot: 'trousers', variant_of: null }),
      item({ id: 'b', name: 'Frontier 11 Pants Harvest', slot: 'trousers', variant_of: null }),
    ]);
    // "Frontier" is what they share; the garment is put back, as "Core" is.
    expect(lineTitle(lineOf(read, read.items[0]!))).toBe('Frontier Pants');
  });

  it('hides Squadron 42 crew uniforms', () => {
    const read = catalogue([
      item({ id: 'pu', name: 'Clempt Pants', slot: 'trousers' }),
      item({ id: 's42', name: 'Navy BDU Pants', slot: 'trousers', flags: ['squadron42'] }),
    ]);
    expect(read.items.map((i) => i.id)).toEqual(['pu']);
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

describe('anatomy', () => {
  it('keeps the medical bay\'s body and skeleton meshes out of the listing', () => {
    const read = catalogue([
      item({ id: 'arm', name: 'Body', slot: 'arms',
        geometry: [{ source: 'Objects/Characters/Human/male_v7/body/anatomy/m_body_armL.skin', side: null }] }),
      item({ id: 'real', name: 'Defiance Arms', slot: 'arms' }),
    ]);
    expect(read.items.map((i) => i.id)).toEqual(['real']);
  });
});

describe('product lines', () => {
  it('puts a (Modified) build under its product, whatever its mesh', () => {
    // The Defiance core's (Modified) build has a mesh of its own, so as a
    // colourway family it was a row of its own; the arms' shares a mesh, so it
    // was a colour. Both are now colours of their product.
    const read = catalogue([
      item({ id: 'sun', name: 'Defiance Core Sunchaser', slot: 'torso' }),
      item({ id: 'tac', name: 'Defiance Core Tactical', slot: 'torso', variant_of: 'sun' }),
      item({ id: 'mod', name: 'Defiance Core (Modified)', slot: 'torso' }),
      item({ id: 'adp', name: 'ADP-mk4 Core Woodland', slot: 'torso' }),
      item({ id: 'boss', name: 'ADP-mk4 Core Big Boss', slot: 'torso' }),
    ]);
    const defiance = lineOf(read, read.items.find((i) => i.id === 'mod')!);
    expect(defiance.map((i) => i.id).sort()).toEqual(['mod', 'sun', 'tac']);
    expect(sharedName(defiance.map((i) => i.name!))).toBe('Defiance Core');
    // Two meshes, one product: one row.
    expect(lineKey(read.items.find((i) => i.id === 'adp')!))
      .toBe(lineKey(read.items.find((i) => i.id === 'boss')!));
  });

  it('keeps slots apart and names the product by the words before the slot word', () => {
    expect(productLine(item({ id: 'a', name: 'Odyssey II Undersuit Alpha' }))).toBe('odyssey');
    expect(productLine(item({ id: 'b', name: 'CSP-68H Backpack Red Alert' }))).toBe('csp-68h');
    // An edition before the slot word is still the product's.
    expect(productLine(item({ id: 'e', name: 'Aves Shrike Core' }))).toBe('aves');
    // An article is not a product.
    expect(productLine(item({ id: 'f', name: 'The Butcher Helmet' })))
      .not.toBe(productLine(item({ id: 'g', name: 'The Hill Horror Helmet' })));
    expect(lineKey(item({ id: 'c', name: 'Defiance Arms', slot: 'arms' })))
      .not.toBe(lineKey(item({ id: 'd', name: 'Defiance Legs', slot: 'legs' })));
  });

  it('leaves an unnamed piece in its own family', () => {
    // An unnamed item's "name" is its class name: no slot word to split on.
    const unnamed = item({ id: 'x', name: 'doom_combat_medium_arms_01_01_01', flags: ['unnamed'] });
    expect(productLine(unnamed)).toBeNull();
    expect(lineKey(unnamed)).toBe(`family|${familyRoot(unnamed)}`);
  });

  it('titles a row with its product and slot', () => {
    expect(lineTitle([
      item({ id: 'a', name: 'Aves Core', slot: 'torso' }),
      item({ id: 'b', name: 'Aves Shrike Core', slot: 'torso' }),
    ])).toBe('Aves Core');
    expect(lineTitle([
      item({ id: 'c', name: 'Defiance Core Sunchaser' }),
      item({ id: 'd', name: 'Defiance Core (Modified)' }),
    ])).toBe('Defiance Core');
  });

  it('titles a gear row with the words all its members share', () => {
    expect(lineTitle([
      item({ id: 'a', name: 'P4-AR Rifle', slot: 'primary' }),
      item({ id: 'b', name: 'P4-AR "Blacklist" Rifle', slot: 'primary' }),
    ])).toBe('P4-AR Rifle');
  });

  it('shows the plainest member on the row', () => {
    const line = [
      item({ id: 'ed', name: 'ADP Core Crusader Edition' }),
      item({ id: 'var', name: 'ADP Core', variant_of: 'base' }),
      item({ id: 'base', name: 'ADP Core' }),
    ];
    expect(lineRepresentative(line).id).toBe('base');
  });
});
