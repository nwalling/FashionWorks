/** The catalogue the worker builds, as the component consumes it.
 *
 * The core returns JSON rather than a structured value, because it crosses a
 * worker boundary and a 2,475-item object graph is cheaper to hand over as one
 * string than as a structured clone. This parses it once and groups it the way
 * the listing needs.
 */

export interface CatalogueItem {
  id: string;
  class_name: string;
  name: string | null;
  slot: string;
  set: string | null;
  variant_of: string | null;
  bind_mode: string;
  socket: string | null;
  flags: string[];
  weight_class: string | null;
  manufacturer?: { code?: string | null; name?: string | null };
  tint?: { layers?: Array<{ color: string; spec: string; glossiness: number }> } | null;
  geometry: Array<{ source: string; side: string | null }>;
  materials: string[];
}

export const SLOTS = ['helmet', 'torso', 'arms', 'legs', 'undersuit', 'backpack'] as const;
export type Slot = (typeof SLOTS)[number];

/** Flags that keep a record out of the listing.
 *
 * Shop displays, the loot containers armour drops into and outright
 * placeholders all carry an armour attach type without being wearable.
 * `unnamed` is deliberately **not** here: that is a real piece whose
 * localisation key did not resolve, and it stays visible under its class name.
 */
export const HIDDEN_FLAGS = ['npc', 'placeholder', 'not_wearable', 'test'];

export interface Catalogue {
  readonly items: CatalogueItem[];
  readonly bySlot: Map<Slot, CatalogueItem[]>;
  /** Every member of a colourway family, keyed by the family's root id. */
  readonly families: Map<string, CatalogueItem[]>;
  /** Every member of a product line in one slot, keyed by {@link lineKey}.
   *
   * Wider than a family: a family is one mesh in many colours, while a line is
   * everything sold under one product name -- the Defiance core in all its
   * colours *and* its (Modified) build, which has a mesh of its own. */
  readonly lines: Map<string, CatalogueItem[]>;
}

/** Words that end the product part of a name. Mirrors the pipeline's
 * `_NAME_SLOT_WORD`. */
const SLOT_WORD = /^(helmet|helm|core|torso|arms|arm|legs|leg|backpack|pack|undersuit|suit|flight)$/i;

/** Leading words too generic to name a product on their own. */
const ARTICLES = new Set(['the', 'a', 'an']);

/** The product a piece is sold as: its first word, lowercased.
 *
 * **The first word, not everything before the slot word.** An edition
 * sometimes sits *between* the product and the slot -- "Aves Shrike Core",
 * "Aztalan Galena Arms", "Carnifex Armor Lucky Break" -- and splitting at the
 * slot word gave each of those a row of its own beside "Aves Core". Read
 * across the catalogue, every first word shared within a slot is one product
 * line, with one exception: "The Butcher" and "The Hill Horror" share only an
 * article, so after one the second word joins the key.
 *
 * Null for a piece with no real name: an unnamed item's "name" is its class
 * name, which stays in its own colourway family. */
export function productLine(item: CatalogueItem): string | null {
  if (!item.name || item.flags.includes('unnamed')) return null;
  const words = item.name
    .split(/\s+/)
    .map((w) => w.replace(/["'()]/g, '').toLowerCase())
    .filter(Boolean);
  if (!words.length) return null;
  return words.slice(0, ARTICLES.has(words[0]!) ? 2 : 1).join(' ');
}

/** A listing row's title: the words its members share, ending in the slot.
 *
 * "Defiance Core" for the Defiance line. Where the shared words stop before
 * the slot word -- "Aves Core" and "Aves Shrike Core" share only "Aves" --
 * the slot word is put back, so the row still says what it is. */
export function lineTitle(line: readonly CatalogueItem[]): string {
  const names = line.map(displayName);
  const shared = sharedName(names);
  if (line.length < 2 || shared.split(/\s+/).some((w) => SLOT_WORD.test(w.replace(/["'()]/g, '')))) {
    return shared;
  }
  const words = displayName(lineRepresentative(line)).split(/\s+/);
  const slotWord = words.find((w) => SLOT_WORD.test(w.replace(/["'()]/g, '')));
  return slotWord ? `${shared} ${slotWord}` : shared;
}

/** Which listing row a piece belongs under.
 *
 * **By product line, not by mesh.** Keyed by mesh, the listing was
 * inconsistent in a way that looked arbitrary: "Defiance Arms (Modified)"
 * appeared as a colour of Defiance Arms because it shares their mesh, while
 * "Defiance Core (Modified)" -- a mesh of its own -- got a row of its own,
 * and "ADP-mk4 Core" appeared twice. Every piece now sits under its product
 * name, and the variants, whatever their mesh, are its colours. */
export function lineKey(item: CatalogueItem): string {
  const product = productLine(item);
  return product ? `${item.slot}|${product}` : `family|${familyRoot(item)}`;
}

/** The id of the item whose GLB a piece's family is rooted on. */
export function familyRoot(item: CatalogueItem): string {
  return item.variant_of ?? item.id;
}

/** What a family of colourways is called.
 *
 * **Not the canonical member's name.** The canonical item is whichever the
 * catalogue made the root, and it is often an *edition*, so titling the row
 * with it hides the rest under a name they do not share. The words the members
 * actually have in common give "Defiance Legs", with every colourway under it.
 */
export function sharedName(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  const split = names.map((n) => n.split(/\s+/).filter(Boolean));
  const shared: string[] = [];
  for (let i = 0; i < split[0]!.length; i += 1) {
    const word = split[0]![i]!;
    if (split.every((words) => words[i] === word)) shared.push(word);
    else break;
  }
  // A family whose names diverge from the first word has nothing to share; the
  // canonical name is still better than an empty row.
  return shared.length ? shared.join(' ') : names[0]!;
}

/** What distinguishes one colourway from its family. */
export function colourwayName(name: string, shared: string): string {
  const rest = name.startsWith(shared) ? name.slice(shared.length).trim() : name;
  return rest || 'Standard';
}

export function displayName(item: CatalogueItem): string {
  return item.name ?? item.class_name;
}

/** The medical bay's anatomy meshes -- a body and a skeleton, cut into arms,
 * legs and torso -- carry armour attach types and are named "Body". Ten rows
 * of flesh and bone in an armour listing. */
function isAnatomy(item: CatalogueItem): boolean {
  return item.geometry.some((g) => /\/body\/anatomy\//i.test(g.source.replace(/\\/g, '/')));
}

export function readCatalogue(json: string): Catalogue {
  const parsed = JSON.parse(json) as { items: CatalogueItem[] };
  const items = parsed.items.filter(
    (item) => item.geometry.length > 0
      && !item.flags.some((f) => HIDDEN_FLAGS.includes(f))
      && !isAnatomy(item),
  );

  const bySlot = new Map<Slot, CatalogueItem[]>(SLOTS.map((s) => [s, []]));
  const families = new Map<string, CatalogueItem[]>();
  for (const item of items) {
    bySlot.get(item.slot as Slot)?.push(item);
    const root = familyRoot(item);
    const family = families.get(root) ?? [];
    family.push(item);
    families.set(root, family);
  }
  for (const list of bySlot.values()) {
    list.sort((a, b) => displayName(a).localeCompare(displayName(b)));
  }
  const lines = new Map<string, CatalogueItem[]>();
  for (const list of bySlot.values()) {
    for (const item of list) {
      const key = lineKey(item);
      const line = lines.get(key) ?? [];
      line.push(item);
      lines.set(key, line);
    }
  }
  return { items, bySlot, families, lines };
}

/** Every piece sold under the same product name in the same slot. */
export function lineOf(catalogue: Catalogue, item: CatalogueItem): CatalogueItem[] {
  return catalogue.lines.get(lineKey(item)) ?? [item];
}

/** The piece a listing row stands for, and equips when clicked.
 *
 * The plainest member: the shortest name, so "ADP Core" over "ADP Core
 * Crusader Edition", then a canonical item over a colourway of it. */
export function lineRepresentative(line: readonly CatalogueItem[]): CatalogueItem {
  return [...line].sort((a, b) => (
    displayName(a).length - displayName(b).length
    || Number(Boolean(a.variant_of)) - Number(Boolean(b.variant_of))
    || displayName(a).localeCompare(displayName(b))
  ))[0]!;
}

/** How saturated a `#rrggbb` is, 0 for a grey and 1 for a pure hue. */
function saturationOf(hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return 0;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const max = Math.max(r!, g!, b!);
  const min = Math.min(r!, g!, b!);
  return max === 0 ? 0 : (max - min) / max;
}

/** The colour to paint a piece's swatch with: its primary, as the eye sees it.
 *
 * Entry A of the tint palette is the primary colour -- measured at 81% across
 * the colourways whose name states a colour that is really in their palette.
 *
 * **But a palette entry carries two colours, and a metal takes the specular.**
 * A metal layer has no diffuse albedo, so its appearance *is* its F0. The Lynx
 * arms are the case that settles it: every colourway names the same material
 * and the same geometry, entry A's tint colour is white or near-white on all of
 * them, and the whole colourway lives in the specular -- red `#ff0000`, green
 * `#0a921c`, blue `#0314fd`. Reading the tint colour paints ten different arms
 * the same grey.
 *
 * So the more saturated of the two wins, with a margin so that a neutral
 * specular on a genuinely coloured dielectric does not steal it. Aqua and Olive
 * carry their hue in the tint colour against a neutral spec, and are the
 * internal control: they must keep reading from `color`.
 */
export function swatchColour(item: CatalogueItem): string | null {
  const entry = item.tint?.layers?.[0];
  if (!entry) return null;
  const { color, spec } = entry;
  if (!color) return spec || null;
  if (!spec) return color;

  // A saturated specular against a neutral tint: the hue is in the specular.
  if (saturationOf(spec) > saturationOf(color) + 0.15) return spec;

  // Both neutral, and the tint is white. Saturation cannot separate those, and
  // white is exactly what a metal's TintColor is -- CryEngine's signature for
  // "there is no diffuse term here". `Lynx Arms Black` is the case: tint
  // #ffffff against a #545454 specular, so reading the tint paints a piece
  // called Black white. The specular is what it looks like.
  if (isNearWhite(color) && !isNearWhite(spec)) return spec;

  return color;
}

/** Bright and colourless -- a metal's tint, rather than a white paint. */
function isNearWhite(hex: string): boolean {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return false;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return Math.min(r!, g!, b!) > 218 && saturationOf(hex) < 0.1;
}
