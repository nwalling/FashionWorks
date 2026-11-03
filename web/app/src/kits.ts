/** Kits: an outfit saved to the visitor's profile on the host, and worn again.
 *
 * Hangarworks keeps a visitor's kits ("My Kits", a list of blueprints the org
 * can be asked to craft). FashionWorks stores nothing itself (WEB-LEGAL.md):
 * it hands the host a `KitOutfit` to save and reads kits back through
 * `KitsHost`. A kit saved from here carries its outfit, so wearing it again
 * puts back exactly what was on; a kit made on the profile page carries only
 * its blueprints, and the host passes the item each one makes
 * (`productEntityClass`, the DataCore id this catalogue uses), so its armour
 * and weapons can still be worn. The contract is WEB-INTEGRATION.md §3.3.
 */

import {
  displayName,
  isGearSlot,
  outfitOf,
  type Catalogue,
  type CatalogueItem,
  type Outfit,
  type WearSlot,
} from './archive/catalogue';

/** What FashionWorks saves into a kit: enough to put the outfit back. */
export interface KitOutfit {
  readonly version: 1;
  /** The share link's encoding: worn ids, gear by holster, what is held.
   * Opaque to the host. */
  readonly loadout: string;
  /** Every piece, for the host to match to blueprints and to list by name. */
  readonly items: readonly KitPiece[];
  readonly body: 'male' | 'female';
}

export interface KitPiece {
  /** DataCore id: a blueprint's `productEntityClass`. */
  readonly id: string;
  /** Where it goes: a wear slot (`helmet`, `torso`, ...) or a gear slot. */
  readonly slot: string;
  /** Its name in the game. */
  readonly name: string;
}

/** A kit as the host keeps it. */
export interface HostKit {
  readonly id: string;
  readonly name: string;
  /** The outfit FashionWorks saved with it, as it was handed over; absent on
   * a kit made elsewhere. */
  readonly outfit?: KitOutfit | null;
  /** The ids of the items it holds: its blueprints' `productEntityClass`,
   * and the record GUIDs of any other item in it -- DataCore GUIDs either
   * way. Ids this catalogue does not have (a ship component, a medpen) are
   * passed over. */
  readonly itemIds: readonly string[];
}

/** The host's side: where kits are kept and how a visitor gets a profile. */
export interface KitsHost {
  /** Whether the visitor has a profile to keep kits in. Without one the
   * panel suggests starting one rather than offering to save. */
  readonly signedIn: boolean;
  /** The visitor's kits, in the order to list them. */
  readonly kits: readonly HostKit[];
  /** Save the outfit as a new kit called `name`. Rejects with an `Error`
   * whose message the panel shows. */
  save(name: string, outfit: KitOutfit): Promise<void>;
  /** Take the visitor to start a profile, or to sign in to theirs. */
  startProfile(): void;
}

/** The outfit on the body as a kit: what is worn in the outfit that is on,
 * and the gear carried. The outfit kept aside is not part of the look. */
export function kitOutfit(
  wearing: ReadonlyMap<WearSlot, CatalogueItem>,
  carrying: ReadonlyMap<string, CatalogueItem>,
  loadout: string,
  body: 'male' | 'female',
): KitOutfit {
  const pieces = [...wearing.values(), ...carrying.values()];
  const seen = new Set<string>();
  const items = pieces
    .filter((item) => !seen.has(item.id) && Boolean(seen.add(item.id)))
    .map((item) => ({ id: item.id, slot: item.slot, name: displayName(item) }));
  return { version: 1, loadout, items, body };
}

/** A name to start from: the torso piece's, else the first worn. */
export function suggestKitName(wearing: ReadonlyMap<WearSlot, CatalogueItem>): string {
  const anchor = wearing.get('torso') ?? wearing.get('jacket') ?? wearing.get('shirt') ?? [...wearing.values()][0];
  return anchor ? displayName(anchor) : 'Outfit';
}

/** A kit with no outfit of its own, as pieces this catalogue can put on: one
 * per slot, in one outfit (the game wears armour or clothing, not both; the
 * one with more pieces wins), and the gear. */
export function kitPieces(
  itemIds: readonly string[],
  catalogue: Catalogue,
): { wear: CatalogueItem[]; carry: CatalogueItem[] } {
  const wearable = new Map(catalogue.items.map((item) => [item.id, item]));
  const gear = new Map(catalogue.gear.map((item) => [item.id, item]));
  const bySlot = new Map<string, CatalogueItem>();
  const carry: CatalogueItem[] = [];
  for (const id of new Set(itemIds)) {
    const worn = wearable.get(id);
    if (worn && !bySlot.has(worn.slot)) bySlot.set(worn.slot, worn);
    const carried = gear.get(id);
    if (carried && isGearSlot(carried.slot)) carry.push(carried);
  }
  const count = (outfit: Outfit) => [...bySlot.values()].filter((i) => outfitOf(i.slot) === outfit).length;
  const outfit: Outfit = count('clothing') > count('armour') ? 'clothing' : 'armour';
  return { wear: [...bySlot.values()].filter((i) => outfitOf(i.slot) === outfit), carry };
}

/** How many of a kit's pieces this catalogue can show. */
export function kitReach(kit: HostKit, catalogue: Catalogue): number {
  if (kit.outfit?.items.length) {
    const known = new Set([...catalogue.items, ...catalogue.gear].map((item) => item.id));
    return kit.outfit.items.filter((piece) => known.has(piece.id)).length;
  }
  const { wear, carry } = kitPieces(kit.itemIds, catalogue);
  return wear.length + carry.length;
}
