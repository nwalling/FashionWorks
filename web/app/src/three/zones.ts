/** Body zones: what a worn item hides of the layers under it.
 * CLOTHING.md Phase 0.
 *
 * Every wearable lists, in `SCItemClothingParams.Chunks`, the zones it covers
 * and the layer it sits at: the body is 0; shirt, trousers, boots and gloves
 * 1; a jacket 2; an undersuit 3; armour 4. A character mesh is split into zone
 * submeshes (`mesh.submeshes[].zone`, named by the core's `zones` table), and
 * a zone on a lower layer is not drawn where a higher layer covers it -- which
 * is how the game keeps skin from poking through cloth, and a shirt's sleeve
 * from poking through a jacket's.
 *
 * `VisibleLayers` is the exception, and it sits only on the last zone a sleeve
 * reaches: `arm02` on a short-sleeved shirt, `arm05` at a long sleeve's wrist,
 * the shoulders under a tank top's straps. The item covers the zone at its own
 * layer but leaves the listed layers drawn there, because it ends part way
 * across it -- hiding the body's forearm under a sleeve that stops at the
 * elbow would open a gap of missing skin.
 */

import type { BufferGeometry } from 'three';

export interface ZoneChunk {
  readonly zone: string;
  readonly layer: number;
  /** Layers left drawn under this chunk, `VisibleLayers`. */
  readonly visible: readonly number[];
}

interface ZonedGroup {
  start: number;
  count: number;
  materialIndex?: number;
  zone?: string | null;
}

/** Whether something on `layer` in `zone` is covered by one of `chunks`. */
export function covered(zone: string | null | undefined, layer: number, chunks: readonly ZoneChunk[]): boolean {
  if (!zone) return false;
  return chunks.some((c) => c.zone === zone && c.layer > layer && !c.visible.includes(layer));
}

/** Draw only the groups of `geometry` that nothing above `layer` covers.
 * Safe to call again whenever the outfit changes: the full group list is
 * kept on the geometry the first time. Returns how many groups are hidden. */
export function showUncovered(geometry: BufferGeometry, layer: number, chunks: readonly ZoneChunk[]): number {
  const all = (geometry.userData.fwAllGroups ??= geometry.groups.slice()) as ZonedGroup[];
  const kept = all.filter((g) => !covered(g.zone, layer, chunks));
  geometry.groups = kept as typeof geometry.groups;
  return all.length - kept.length;
}
