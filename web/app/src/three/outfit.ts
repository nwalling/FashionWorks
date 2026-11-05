/** The outfit model: which ports a piece plugs into, which it hides, and what
 * of the layers beneath it is drawn. CLOTHING.md Phase 2.
 *
 * The character is a chain of item ports. The body takes the undersuit and the
 * clothing; the undersuit takes the armour; the head takes the hat. Every worn
 * piece lists, in `hidden`, the ports it hides while worn -- an undersuit the
 * five clothing ports, a jacket the shirt beneath it, a helmet the hat and the
 * hair -- and, in `chunks`, the body zones it covers and the layer it covers
 * them at. Both are data; nothing here is a rule about particular items.
 *
 * **The two outfits are exclusive.** 215 of 222 undersuits hide every clothing
 * port, so in the game a character wears armour on an undersuit or clothing on
 * the body, never both. The engine keeps one outfit on the body and the other
 * aside, so switching loses nothing. Head items are worn in either: the head's
 * ports are not the body's, and an undersuit hides none of them.
 *
 * **Some chunks answer to a partner.** An Artimex helmet's cowl and breathing
 * tube plug into the Artimex core, and are drawn only with one in the torso
 * port; the game's own icon shows the helmet bare. Each piece's `visibility`
 * says which of its zones wait on what (`catalog::visibility` in the core
 * reads it), and `offZones` decides them against what is worn.
 */

import {
  CLOTHING_SLOTS,
  outfitOf,
  SLOTS,
  type CatalogueItem,
  type Outfit,
  type PortCheck,
  type WearSlot,
} from '../archive/catalogue';
import type { ZoneChunk } from './zones';

/** The port each slot's piece plugs into, as the records name it. */
export const SLOT_PORT: Readonly<Record<WearSlot, string>> = {
  undersuit: 'Armor_Undersuit',
  helmet: 'Armor_Helmet',
  torso: 'Armor_Torso',
  arms: 'Armor_Arms',
  legs: 'Armor_Legs',
  // The armour torso's port; a clothing pack hangs off a jacket's port of the
  // same name (`grin_refinery_apron`).
  backpack: 'backpack',
  hat: 'Hat_ItemPort',
  eyewear: 'Eye_Accessories_ItemPort',
  shirt: 'Clothing_Torso_0',
  jacket: 'Clothing_Torso_1',
  accessory: 'Clothing_Torso2',
  gloves: 'Clothing_Hands',
  trousers: 'Clothing_Legs',
  footwear: 'Clothing_Feet',
  pack: 'backpack',
};

/** The head's own ports, for the figure's parts. */
export const HAIR_PORT = 'Hair_ItemPort';
export const HEAD_PORT = 'Head_ItemPort';

/** A slot's layer when its record lists no chunks: 1 under-layer clothing, 2 a
 * jacket, 3 the undersuit, 4 armour -- the layers every record that does list
 * chunks uses. */
const SLOT_LAYER: Readonly<Record<WearSlot, number>> = {
  shirt: 1,
  trousers: 1,
  footwear: 1,
  gloves: 1,
  jacket: 2,
  accessory: 2,
  pack: 2,
  undersuit: 3,
  helmet: 4,
  torso: 4,
  arms: 4,
  legs: 4,
  backpack: 4,
  hat: 4,
  eyewear: 4,
};

/** Slots worn whichever outfit is on: the head's. A helmet hides the hat on all
 * 683 records and the eyewear on 355; 21 hats hide the eyewear too. */
export const HEAD_SLOTS: readonly WearSlot[] = ['hat', 'eyewear'];

/** The slots that belong to one outfit and come off when the other goes on. */
export function outfitSlots(outfit: Outfit): readonly WearSlot[] {
  const all: readonly WearSlot[] = outfit === 'clothing' ? CLOTHING_SLOTS : SLOTS;
  return all.filter((slot) => !HEAD_SLOTS.includes(slot));
}

/** Which outfit a piece puts on the body, or null for a head item. */
export function outfitFor(slot: WearSlot): Outfit | null {
  return HEAD_SLOTS.includes(slot) ? null : outfitOf(slot);
}

/** Every port something worn hides, lowercased: the records spell the hair
 * port both `Hair_ItemPort` and `Hair_itemPort`. */
export function hiddenPorts(worn: Iterable<CatalogueItem>): Set<string> {
  const out = new Set<string>();
  for (const item of worn) for (const port of item.hidden ?? []) out.add(port.toLowerCase());
  return out;
}

export function portHidden(port: string, hidden: ReadonlySet<string>): boolean {
  return hidden.has(port.toLowerCase());
}

/** The layer a piece's own meshes sit at: the highest its chunks name, else
 * its slot's. */
export function layerOf(item: CatalogueItem): number {
  const layers = (item.chunks ?? []).map((c) => c.layer);
  return layers.length ? Math.max(...layers) : SLOT_LAYER[item.slot as WearSlot] ?? 4;
}

/** Whether `held` is the tag `wanted` or sits under it in the tag tree: a
 * core's `Theta/Variant/01` answers a helmet asking for `Theta/Variant`. */
export function holdsTag(held: string, wanted: string): boolean {
  return held === wanted || (held.startsWith(wanted) && held.charAt(wanted.length) === '/');
}

/** The piece each port holds, lowercased: what a visibility check reads. A
 * hidden piece holds nothing, and a port nothing is worn in -- a hand, a
 * magazine pouch -- reads as empty. */
export function portHolders(
  wearing: ReadonlyMap<WearSlot, CatalogueItem>,
  hiddenSlots: ReadonlySet<WearSlot> = new Set(),
): Map<string, CatalogueItem> {
  const out = new Map<string, CatalogueItem>();
  for (const [slot, item] of wearing) if (!hiddenSlots.has(slot)) out.set(SLOT_PORT[slot].toLowerCase(), item);
  return out;
}

function checkPasses(check: PortCheck, holders: ReadonlyMap<string, CatalogueItem>): boolean {
  return check.ports.some((port) => {
    const held = holders.get(port.toLowerCase())?.tagged ?? [];
    const has = (wanted: string) => held.some((tag) => holdsTag(tag, wanted));
    return check.active.every(has) && !check.disable.some(has);
  });
}

/** The zones of `item` that its visibility conditions leave undrawn beside
 * what `holders` hold. A zone is drawn while any of its conditions holds, and
 * a condition holds when all its checks pass: the Artimex cowl wants an
 * Artimex core in `Armor_Torso`, the Aril arms' chunk an Aril core *and* an
 * Aril pack, and the Clash core's back is drawn until any pack goes on. */
export function offZones(item: CatalogueItem, holders: ReadonlyMap<string, CatalogueItem>): Set<string> {
  const drawn = new Map<string, boolean>();
  for (const { zone, when } of item.visibility ?? []) {
    const holds = when.some((condition) => condition.every((check) => checkPasses(check, holders)));
    drawn.set(zone, (drawn.get(zone) ?? false) || holds);
  }
  return new Set([...drawn].filter(([, on]) => !on).map(([zone]) => zone));
}

/** What is drawn of an outfit, worked out once whenever it changes. */
export interface OutfitView {
  /** Worn slots whose port something else hides. */
  readonly hiddenSlots: ReadonlySet<WearSlot>;
  /** The zones of each worn piece its visibility conditions leave undrawn:
   * the Artimex helmet's cowl beside any core but an Artimex. */
  readonly off: ReadonlyMap<WearSlot, ReadonlySet<string>>;
  /** Every chunk a drawn piece covers: what the zone rule hides beneath. A
   * chunk its conditions leave undrawn covers nothing. */
  readonly chunks: readonly ZoneChunk[];
  readonly hideHair: boolean;
  readonly hideHead: boolean;
  /** The hair variant a drawn piece asks for, if any: `hatHair` for a cap. */
  readonly hairTag?: string;
  /** Every geometry tag a drawn piece adds -- what a character's head items
   * choose their variants by (`hatHair`, `maskFacialHair`). */
  readonly tags: ReadonlySet<string>;
  /** Every port something worn hides, lowercased, for a character's head
   * items, which each name their own. */
  readonly hiddenPorts: ReadonlySet<string>;
}

/** Hair variants, most specific first: a hat that asks for both wants the
 * one cut for a mask. */
export const HAIR_TAGS = ['hatHair_mask', 'hatHair'] as const;

/** The geometry tags a piece adds while worn, from its `$tag+` directives:
 * `$hatHair+` on a cap, `$$Pack++` on a backpack. */
export function addedTags(item: CatalogueItem): string[] {
  return (item.tags ?? []).flatMap((token) => {
    const found = /^\$+([^$+]+)\++$/.exec(token);
    return found ? [found[1]!] : [];
  });
}

export function viewOf(wearing: ReadonlyMap<WearSlot, CatalogueItem>): OutfitView {
  const hidden = hiddenPorts(wearing.values());
  const hiddenSlots = new Set<WearSlot>();
  for (const slot of wearing.keys()) if (portHidden(SLOT_PORT[slot], hidden)) hiddenSlots.add(slot);
  const holders = portHolders(wearing, hiddenSlots);
  const off = new Map<WearSlot, ReadonlySet<string>>();
  for (const [slot, item] of wearing) {
    const zones = offZones(item, holders);
    if (zones.size) off.set(slot, zones);
  }
  // A hidden piece covers nothing: a shirt under a jacket that hides it must
  // not also hide the skin at a hem the jacket leaves open.
  const chunks = [...wearing]
    .filter(([slot]) => !hiddenSlots.has(slot))
    .flatMap(([slot, item]) => (item.chunks ?? []).filter((chunk) => !off.get(slot)?.has(chunk.zone)));
  const tags = [...wearing].filter(([slot]) => !hiddenSlots.has(slot)).flatMap(([, item]) => addedTags(item));
  return {
    hiddenSlots,
    off,
    chunks,
    // Every helmet hides the hair, whatever its record says. The data hides
    // the hair port on 113 of 683 helmets; the rest rely on the game swapping
    // in a flattened hair variant, which the figure does not have, and its one
    // hairstyle pokes through every shell.
    hideHair: portHidden(HAIR_PORT, hidden) || wearing.has('helmet'),
    hideHead: portHidden(HEAD_PORT, hidden),
    hairTag: hairTagOf(tags),
    tags: new Set(tags),
    hiddenPorts: hidden,
  };
}

function hairTagOf(tags: readonly string[]): string | undefined {
  return HAIR_TAGS.find((tag) => tags.includes(tag));
}
