/** Holsters: which piece owns each port, what a port takes, and why not.
 *
 * The data, from LOADOUT.md: armour declares its holsters as item ports, and
 * the count follows the torso's weight class -- a light core carries one rifle
 * holster, two grenade and four magazine points; a heavy one two, four and
 * eight. Legs carry the sidearm, the two thigh utility points and four pen
 * points. A backpack re-declares the two rifle holsters and the gadget point
 * and carries its own nodes for them, one either side of the pack.
 *
 * **Nothing in the records says which owner wins** when the torso and the
 * backpack both declare `wep_stocked_3`: `linkedItemPorts`, `itemPortRules`
 * and the port tags are empty on every one. This reads it as *the outermost
 * piece wins* -- backpack over torso over undersuit for the back, legs over
 * undersuit for the thigh -- which is where a pack-wearer's rifles visibly sit.
 *
 * **Acceptance is the port's own declaration and nothing else**: the item's
 * `(type, subtype)` must be in the port's list and its size within the port's
 * range. A Large weapon (size 5) fits only the right side of the back.
 */

import type { CatalogueItem, GearSlot, Port, Slot } from '../archive/catalogue';

/** Lowest first: a later slot's port replaces an earlier one's of the same name. */
export const PORT_OWNERS: readonly Slot[] = ['undersuit', 'helmet', 'arms', 'legs', 'torso', 'backpack'];

/** Item types a holster can take. The `backpack` and `helmethook_attach`
 * ports are armour-on-armour and are not holsters. */
const GEAR_TYPES = ['weaponpersonal', 'weaponattachment', 'fps_consumable', 'gadget', 'fps_deployable'];

export interface OwnedPort {
  readonly port: Port;
  /** The slot of the piece that declares it. */
  readonly owner: Slot;
  readonly item: CatalogueItem;
}

export function isHolster(port: Port): boolean {
  return port.types.some((t) => GEAR_TYPES.includes(t.type.toLowerCase()));
}

/** Every holster on the body, each from the outermost piece that declares it. */
export function resolvePorts(wearing: ReadonlyMap<Slot, CatalogueItem>): Map<string, OwnedPort> {
  const out = new Map<string, OwnedPort>();
  for (const owner of PORT_OWNERS) {
    const item = wearing.get(owner);
    for (const port of item?.ports ?? []) {
      if (isHolster(port)) out.set(port.name, { port, owner, item: item! });
    }
  }
  return out;
}

/** A holster's name as a person would say it. */
export function portLabel(port: Port): string {
  const n = port.name.toLowerCase();
  const number = /_(\d+)$/.exec(n)?.[1] ?? '';
  if (port.select_tag === 'backLeft' || n === 'wep_stocked_2') return 'back left';
  if (port.select_tag === 'backRight' || n === 'wep_stocked_3') return 'back right';
  if (n === 'wep_sidearm') return 'sidearm';
  if (n === 'utility_attach_1') return 'left thigh';
  if (n === 'utility_attach_2') return 'right thigh';
  if (n.startsWith('grenade_attach')) return `grenade ${number}`;
  if (n.startsWith('magazine_attach')) return `magazine ${number}`;
  if (n.startsWith('magattach')) return `pack magazine ${number}`;
  if (n.startsWith('medpen_attach')) return `medpen ${number}`;
  if (n.startsWith('oxypen_attach')) return `oxypen ${number}`;
  if (n.startsWith('gadget_attach')) return 'back gadget';
  return port.name.replace(/_/g, ' ');
}

/** A holster's name in a chip's width: a whole slot's holsters sit on one
 * line of the side panel, twelve of them for magazines under an ammo pack.
 * The full name goes in the chip's tooltip. */
export function portShort(port: Port): string {
  const n = port.name.toLowerCase();
  const number = /_(\d+)$/.exec(n)?.[1] ?? '';
  if (port.select_tag === 'backLeft' || n === 'wep_stocked_2') return 'left';
  if (port.select_tag === 'backRight' || n === 'wep_stocked_3') return 'right';
  if (n === 'wep_sidearm') return 'hip';
  if (n === 'utility_attach_1') return 'L thigh';
  if (n === 'utility_attach_2') return 'R thigh';
  if (n.startsWith('gadget_attach')) return 'back';
  if (n.startsWith('grenade_attach') || n.startsWith('magazine_attach')) return number;
  if (n.startsWith('magattach')) return `P${number}`;
  if (n.startsWith('medpen_attach')) return `med ${number}`;
  if (n.startsWith('oxypen_attach')) return `oxy ${number}`;
  return portLabel(port);
}

/** What a gear item is, in a word, for a sentence. */
export function itemNoun(item: CatalogueItem): string {
  const attach = item.attach;
  if (!attach) return 'piece';
  const sub = attach.subtype.toLowerCase();
  if (attach.type.toLowerCase() === 'weaponpersonal') {
    if (sub === 'large') return 'large weapon';
    if (sub === 'medium') return 'rifle';
    if (sub === 'small') return 'pistol';
    return sub || 'weapon';
  }
  if (attach.type.toLowerCase() === 'weaponattachment') return sub || 'attachment';
  if (attach.type.toLowerCase() === 'fps_consumable') return 'pen';
  return 'gadget';
}

/** Why a port will not take an item, or `null` when it will. */
export function refusal(port: Port, item: CatalogueItem): string | null {
  const attach = item.attach;
  if (!attach) return `${portLabel(port)} holds gear, not armour`;
  const type = attach.type.toLowerCase();
  const sub = attach.subtype.toLowerCase();
  const typed = port.types.some((t) => t.type.toLowerCase() === type
    && (t.subtypes.length === 0 || t.subtypes.some((s) => s.toLowerCase() === sub)));
  if (!typed) return `the ${portLabel(port)} holster does not take a ${itemNoun(item)}`;
  const limited = port.min_size > 0 || port.max_size > 0;
  if (limited && (attach.size < port.min_size || attach.size > port.max_size)) {
    const range = port.min_size === port.max_size ? `size ${port.min_size}` : `sizes ${port.min_size}-${port.max_size}`;
    return `the ${portLabel(port)} holster takes ${range}, and this is size ${attach.size}`;
  }
  return null;
}

/** Where an item goes: the preferred port if it will take it, else the first
 * free one that will. Or why nowhere will. */
export function portFor(
  item: CatalogueItem,
  ports: ReadonlyMap<string, OwnedPort>,
  occupied: ReadonlySet<string>,
  preferred?: string | null,
): { port: OwnedPort } | { reason: string } {
  if (preferred) {
    const want = ports.get(preferred);
    if (want) {
      const why = refusal(want.port, item);
      if (!why) return { port: want };
      return { reason: why };
    }
  }
  const all = [...ports.values()];
  const taking = all.filter((p) => refusal(p.port, item) === null);
  const free = taking.find((p) => !occupied.has(p.port.name));
  if (free) return { port: free };
  if (taking.length) {
    return {
      reason: `every holster that takes a ${itemNoun(item)} is full (${taking.length})`,
    };
  }
  // Say the most useful thing: a size refusal names the limit, which is the
  // one a visitor can act on.
  const sized = all
    .map((p) => refusal(p.port, item))
    .find((why) => why && why.includes('size'));
  if (sized) return { reason: sized };
  return { reason: `nothing worn has a holster for a ${itemNoun(item)}` };
}

/** How a set of holsters reads in a sentence: "two rifle holsters, four
 * grenade points and eight magazine points". */
export function describePorts(ports: ReadonlyMap<string, OwnedPort>): string {
  const counts = { rifle: 0, grenade: 0, magazine: 0 };
  for (const { port } of ports.values()) {
    const n = port.name.toLowerCase();
    if (n.startsWith('wep_stocked')) counts.rifle += 1;
    else if (n.startsWith('grenade_attach')) counts.grenade += 1;
    else if (n.startsWith('magazine_attach') || n.startsWith('magattach')) counts.magazine += 1;
  }
  const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const say = (n: number, noun: string) => `${words[n] ?? String(n)} ${noun}${n === 1 ? '' : 's'}`;
  return [
    say(counts.rifle, 'rifle holster'),
    say(counts.grenade, 'grenade point'),
    say(counts.magazine, 'magazine point'),
  ].join(', ');
}

/** The item types each gear slot's items carry, for asking which holsters
 * serve a slot before anything is chosen. */
const SLOT_TYPES: Record<GearSlot, ReadonlyArray<readonly [string, readonly string[]]>> = {
  primary: [['weaponpersonal', ['medium', 'large']]],
  sidearm: [['weaponpersonal', ['small']]],
  knife: [['weaponpersonal', ['knife']]],
  gadget: [['weaponpersonal', ['gadget']], ['gadget', []]],
  grenade: [['weaponpersonal', ['grenade']]],
  magazine: [['weaponattachment', ['magazine']]],
  consumable: [['fps_consumable', []]],
};

/** Whether a holster could take anything from a gear slot. */
export function portServes(port: Port, slot: GearSlot): boolean {
  return SLOT_TYPES[slot].some(([type, subtypes]) => port.types.some((t) => (
    t.type.toLowerCase() === type
    && (t.subtypes.length === 0 || subtypes.length === 0
      || t.subtypes.some((s) => subtypes.includes(s.toLowerCase())))
  )));
}

/** Which carried items survive an armour change, and which come off.
 *
 * An item stays when its port still exists and still takes it -- possibly
 * from a different owner, as when a backpack goes on and takes over the rifle
 * holsters -- and comes off otherwise. */
export function revalidate<T extends { readonly item: CatalogueItem }>(
  carried: ReadonlyMap<string, T>,
  ports: ReadonlyMap<string, OwnedPort>,
): { kept: Array<{ port: string; carried: T; owned: OwnedPort }>; removed: Array<{ port: string; carried: T }> } {
  const kept: Array<{ port: string; carried: T; owned: OwnedPort }> = [];
  const removed: Array<{ port: string; carried: T }> = [];
  for (const [port, entry] of carried) {
    const owned = ports.get(port);
    if (owned && refusal(owned.port, entry.item) === null) kept.push({ port, carried: entry, owned });
    else removed.push({ port, carried: entry });
  }
  return { kept, removed };
}
