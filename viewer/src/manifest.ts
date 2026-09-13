import { z } from 'zod';

/**
 * Mirror of `extract/sc_extract/manifest.py`. Bump SCHEMA_VERSION on both
 * sides together; the loader refuses a manifest it was not written for.
 */
export const SCHEMA_VERSION = 1;

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
  geometry: z.array(geometrySchema).default([]),
  materials: z.array(z.string()).default([]),
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

/** Items that are renderable and not hidden behind a flag. */
export function selectableItems(manifest: Manifest): Item[] {
  return manifest.items.filter((item) => item.assets.glb !== null && !item.flags.includes('npc'));
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
