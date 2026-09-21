import { z } from 'zod';

/**
 * Mirror of `extract/sc_extract/manifest.py`. Bump SCHEMA_VERSION on both
 * sides together; the loader refuses a manifest it was not written for.
 */
export const SCHEMA_VERSION = 3;

export const SLOTS = ['helmet', 'torso', 'arms', 'legs', 'backpack', 'undersuit'] as const;
export type Slot = (typeof SLOTS)[number];

const manufacturerSchema = z.object({
  code: z.string().default(''),
  name: z.string().default(''),
});

const geometrySchema = z.object({
  source: z.string(),
  side: z.string().nullable().default(null),
});

/**
 * Textures a colour variant swaps onto the shared canonical mesh. Variants
 * reuse their canonical item's GLB, which is right for the geometry and wrong
 * for the surface: most name their own .mtl and many carry no tint palette at
 * all, so there was nothing to re-apply and every colourway rendered alike.
 */
const materialOverrideSchema = z.object({
  name: z.string(),
  base_color: z.string().nullable().default(null),
  orm: z.string().nullable().default(null),
  // The same surface with the wear blend skipped, so a piece can be shown as it
  // left the factory. Optional: a build made before this existed, or one run
  // with --no-unworn, simply has none and the toggle hides itself rather than
  // rendering an untextured piece.
  base_color_unworn: z.string().nullable().default(null),
  orm_unworn: z.string().nullable().default(null),
});

const assetsSchema = z.object({
  glb: z.string().nullable().default(null),
  thumb: z.string().nullable().default(null),
});

export const itemSchema = z.object({
  id: z.string(),
  class_name: z.string(),
  name: z.string(),
  slot: z.enum(SLOTS),
  name_key: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  description_key: z.string().nullable().default(null),
  sub_slot: z.string().nullable().default(null),
  weight_class: z.string().nullable().default(null),
  manufacturer: manufacturerSchema.default({ code: '', name: '' }),
  set: z.string().nullable().default(null),
  variant_of: z.string().nullable().default(null),
  variants: z.array(z.string()).default([]),
  tint: z.record(z.unknown()).nullable().default(null),
  stats: z.record(z.unknown()).default({}),
  bind_mode: z.enum(['skinned', 'socket']).default('skinned'),
  socket: z.string().nullable().default(null),
  // How far this piece shifts each attachment point from the canonical rig.
  socket_offsets: z.record(z.array(z.number())).default({}),
  geometry: z.array(geometrySchema).default([]),
  materials: z.array(z.string()).default([]),
  material_overrides: z.array(materialOverrideSchema).default([]),
  // Representative colour for the picker swatch, computed from the layers the
  // shader actually shows. The palette's first entry is not it.
  swatch: z.string().nullable().default(null),
  assets: assetsSchema.default({ glb: null, thumb: null }),
  flags: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});

export const manifestSchema = z.object({
  schema_version: z.number(),
  game_version: z.string().default('unknown'),
  generated_at: z.string().default(''),
  skeletons: z
    .record(z.object({ chr: z.string().nullable().default(null), glb: z.string().nullable().default(null) }))
    .default({}),
  sockets: z.array(z.string()).default([]),
  items: z.array(itemSchema).default([]),
});

export type Item = z.infer<typeof itemSchema>;
export type Manifest = z.infer<typeof manifestSchema>;

export const ASSET_BASE_URL: string = __ASSET_BASE_URL__;

export function assetUrl(relative: string): string {
  const base = ASSET_BASE_URL.replace(/\/$/, '');
  return `${base}/${relative.replace(/^\//, '')}`;
}

export class ManifestVersionError extends Error {}

export async function loadManifest(signal?: AbortSignal): Promise<Manifest> {
  const url = assetUrl('manifest.json');
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`manifest fetch failed (${response.status}) at ${url}`);
  }
  const manifest = manifestSchema.parse(await response.json());
  if (manifest.schema_version !== SCHEMA_VERSION) {
    throw new ManifestVersionError(
      `manifest schema_version ${manifest.schema_version} but this viewer expects ${SCHEMA_VERSION}`,
    );
  }
  return manifest;
}

/**
 * Flags that keep an item out of the default listing. Some DataCore records
 * carry an armor attach type without being wearable: shop displays, the loot
 * containers armor drops into, and outright placeholders.
 */
const HIDDEN_FLAGS = ['npc', 'placeholder', 'not_wearable', 'test'] as const;

/** Items that are renderable and not hidden behind a flag. */
export function selectableItems(manifest: Manifest): Item[] {
  return manifest.items.filter(
    (item) =>
      item.assets.glb !== null && !HIDDEN_FLAGS.some((flag) => item.flags.includes(flag)),
  );
}

export function itemsBySlot(items: Item[]): Record<Slot, Item[]> {
  const out = Object.fromEntries(SLOTS.map((slot) => [slot, [] as Item[]])) as Record<Slot, Item[]>;
  for (const item of items) out[item.slot].push(item);
  return out;
}

/**
 * The item's own tint colour from the game's palette, as #rrggbb.
 *
 * Armor ships no albedo texture; colour comes from a tint palette. A colour
 * variant borrows its canonical item's mesh, whose material carries the
 * canonical colour, so the variant's own palette colour has to be applied at
 * render time or every swatch would look identical.
 */
export function paletteColor(item: Item): string | undefined {
  // The baked swatch first: it is derived from the layers the shader shows,
  // so it is right for the 876 variants that have no palette and for those
  // whose material tints from palette entry B or C rather than A.
  if (item.swatch && /^#[0-9a-f]{6}$/i.test(item.swatch)) return item.swatch;
  const colors = (item.tint as { colors?: unknown } | null)?.colors;
  if (!Array.isArray(colors)) return undefined;
  const first = colors[0];
  return typeof first === 'string' && /^#[0-9a-f]{6}$/i.test(first) ? first : undefined;
}

/** Colour variants of an item, canonical first. */
export function variantsOf(item: Item, byId: Map<string, Item>): Item[] {
  const canonical = item.variant_of ? byId.get(item.variant_of) ?? item : item;
  const rest = canonical.variants.map((id) => byId.get(id)).filter((v): v is Item => Boolean(v));
  return [canonical, ...rest];
}
