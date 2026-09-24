import { describe, expect, it } from 'vitest';

import { readCatalogue, type CatalogueItem, type Port } from '../src/archive/catalogue';
import {
  describePorts,
  portFor,
  portLabel,
  portShort,
  portServes,
  refusal,
  resolvePorts,
  revalidate,
} from '../src/gear/ports';
import { decodeGear, decodeLoadout, encodeLoadout } from '../src/three/kitbasher';

function port(name: string, types: Array<[string, string[]]>, min: number, max: number, extra: Partial<Port> = {}): Port {
  return {
    name,
    types: types.map(([type, subtypes]) => ({ type, subtypes })),
    min_size: min,
    max_size: max,
    helper: `${name}_override`,
    offset: 'attach_offset_left_01',
    select_tag: null,
    ...extra,
  };
}

function armour(id: string, slot: string, ports: Port[]): CatalogueItem {
  return {
    id, class_name: id, name: id, slot, set: null, variant_of: null, bind_mode: slot === 'backpack' ? 'socket' : 'skinned',
    socket: null, flags: [], weight_class: null, geometry: [{ source: `${id}.skin`, side: null }], materials: [], ports,
  };
}

function gear(id: string, slot: string, type: string, subtype: string, size: number): CatalogueItem {
  return {
    id, class_name: id, name: id, slot, set: null, variant_of: null, bind_mode: 'gear', socket: null, flags: [],
    weight_class: null, geometry: [{ source: `${id}.cdf`, side: null }], materials: [],
    attach: { type, subtype, size, tags: [] },
  };
}

const RIFLE_LEFT = port('wep_stocked_2', [['WeaponPersonal', ['Medium']], ['WeaponPersonal', ['Gadget']]], 2, 4, { select_tag: 'backLeft' });
const RIFLE_RIGHT = port('wep_stocked_3', [['WeaponPersonal', ['Medium', 'Large']]], 2, 5, { select_tag: 'backRight' });
const GRENADE = (n: number) => port(`grenade_attach_${n}`, [['WeaponPersonal', ['Grenade']], ['FPS_Deployable', ['Small']]], 1, 1);
const BACKPACK_PORT = port('backpack', [['Char_Armor_Backpack', []]], 1, 3);

const heavyCore = armour('heavy', 'torso', [RIFLE_LEFT, RIFLE_RIGHT, GRENADE(1), GRENADE(2), BACKPACK_PORT]);
const lightCore = armour('light', 'torso', [RIFLE_RIGHT, GRENADE(1)]);
const pack = armour('pack', 'backpack', [RIFLE_LEFT, RIFLE_RIGHT]);

const rifle = gear('p4ar', 'primary', 'WeaponPersonal', 'Medium', 2);
const launcher = gear('animus', 'primary', 'WeaponPersonal', 'Large', 5);
const grenade = gear('mk4', 'grenade', 'WeaponPersonal', 'Grenade', 1);

describe('holsters', () => {
  it('are the armour ports that take gear, not the backpack port', () => {
    const ports = resolvePorts(new Map([['torso', heavyCore]]));
    expect([...ports.keys()]).toEqual(['wep_stocked_2', 'wep_stocked_3', 'grenade_attach_1', 'grenade_attach_2']);
  });

  it('belong to the outermost piece that declares them', () => {
    // The backpack re-declares the rifle holsters and carries them on its own
    // nodes; the torso's grenade points are still the torso's.
    const ports = resolvePorts(new Map([['torso', heavyCore], ['backpack', pack]]));
    expect(ports.get('wep_stocked_3')!.owner).toBe('backpack');
    expect(ports.get('grenade_attach_1')!.owner).toBe('torso');
  });

  it('take what their types and sizes say, and say why not', () => {
    expect(refusal(RIFLE_RIGHT, launcher)).toBeNull();
    expect(refusal(RIFLE_LEFT, launcher)).toContain('does not take a large weapon');
    expect(refusal(RIFLE_LEFT, gear('tiny', 'primary', 'WeaponPersonal', 'Medium', 1)))
      .toBe('the back left holster takes sizes 2-4, and this is size 1');
    expect(refusal(GRENADE(1), rifle)).toContain('does not take a rifle');
  });

  it('fill the first free port that takes the item, then report full', () => {
    const ports = resolvePorts(new Map([['torso', heavyCore]]));
    const first = portFor(grenade, ports, new Set());
    expect('port' in first && first.port.port.name).toBe('grenade_attach_1');
    const second = portFor(grenade, ports, new Set(['grenade_attach_1']));
    expect('port' in second && second.port.port.name).toBe('grenade_attach_2');
    const none = portFor(grenade, ports, new Set(['grenade_attach_1', 'grenade_attach_2']));
    expect('reason' in none && none.reason).toBe('every holster that takes a grenade is full (2)');
  });

  it('send a large weapon to the only side that takes it', () => {
    const ports = resolvePorts(new Map([['torso', heavyCore]]));
    const where = portFor(launcher, ports, new Set());
    expect('port' in where && where.port.port.name).toBe('wep_stocked_3');
  });

  it('shed what a lighter core cannot hold, and keep what it can', () => {
    const carried = new Map([
      ['wep_stocked_2', { item: rifle }],
      ['wep_stocked_3', { item: launcher }],
      ['grenade_attach_1', { item: grenade }],
      ['grenade_attach_2', { item: grenade }],
    ]);
    const { kept, removed } = revalidate(carried, resolvePorts(new Map([['torso', lightCore]])));
    expect(kept.map((k) => k.port)).toEqual(['wep_stocked_3', 'grenade_attach_1']);
    expect(removed.map((r) => r.port)).toEqual(['wep_stocked_2', 'grenade_attach_2']);
  });

  it('move a holstered item to the backpack when one goes on', () => {
    const carried = new Map([['wep_stocked_3', { item: rifle }]]);
    const { kept } = revalidate(carried, resolvePorts(new Map([['torso', heavyCore], ['backpack', pack]])));
    expect(kept[0]!.owned.owner).toBe('backpack');
  });

  it('explain an empty body', () => {
    const where = portFor(rifle, resolvePorts(new Map()), new Set());
    expect('reason' in where && where.reason).toBe('nothing worn has a holster for a rifle');
  });

  it('are counted the way the status reads them', () => {
    expect(describePorts(resolvePorts(new Map([['torso', lightCore]]))))
      .toBe('one rifle holster, one grenade point, no magazine points');
  });

  it('are named as a person would say them, and matched to gear slots', () => {
    expect(portLabel(RIFLE_LEFT)).toBe('back left');
    expect(portLabel(GRENADE(3))).toBe('grenade 3');
    expect(portShort(RIFLE_LEFT)).toBe('left');
    expect(portShort(GRENADE(3))).toBe('3');
    expect(portServes(RIFLE_RIGHT, 'primary')).toBe(true);
    expect(portServes(RIFLE_RIGHT, 'grenade')).toBe(false);
    expect(portServes(RIFLE_LEFT, 'gadget')).toBe(true);
  });
});

describe('the share string, version 2', () => {
  const catalogue = readCatalogue(JSON.stringify({
    items: [heavyCore],
    gear: [rifle, grenade],
  }));

  it('appends gear and the held port, and still decodes a version-1 string', () => {
    const encoded = encodeLoadout(
      new Map([['torso', heavyCore]]),
      new Map([['wep_stocked_2', rifle], ['grenade_attach_1', grenade]]),
      'wep_stocked_2',
    );
    expect(encoded).toBe('heavy;wep_stocked_2=p4ar;grenade_attach_1=mk4;hold=wep_stocked_2');
    expect(decodeLoadout(encoded, catalogue).map((i) => i.id)).toEqual(['heavy']);
    const back = decodeGear(encoded, catalogue);
    expect(back.carrying.map((c) => `${c.port}=${c.item.id}`)).toEqual(['wep_stocked_2=p4ar', 'grenade_attach_1=mk4']);
    expect(back.holding).toBe('wep_stocked_2');
    // An old link: armour only.
    expect(decodeLoadout('heavy', catalogue).map((i) => i.id)).toEqual(['heavy']);
    expect(decodeGear('heavy', catalogue).carrying).toEqual([]);
  });

  it('carries clothing in the same segment, with no marker needed', () => {
    // A slot belongs to one outfit, so the ids alone say which is on.
    const shirt = { ...armour('tee', 'shirt', []), outfit: 'clothing' as const };
    const jacket = { ...armour('coat', 'jacket', []), outfit: 'clothing' as const };
    const hat = { ...armour('cap', 'hat', []), outfit: 'clothing' as const };
    const withClothing = readCatalogue(JSON.stringify({ items: [heavyCore, shirt, jacket, hat] }));
    const encoded = encodeLoadout(new Map([['jacket', jacket], ['hat', hat], ['shirt', shirt]]));
    expect(encoded).toBe('cap,tee,coat');
    expect(decodeLoadout(encoded, withClothing).map((i) => i.slot)).toEqual(['hat', 'shirt', 'jacket']);
  });
});
