/** Turning the worker's buffers into three.js geometry.
 *
 * The archive is **Z-up**; glTF and three.js are Y-up. The existing pipeline
 * does that conversion inside Blender's exporter, so nothing downstream ever
 * sees it. Here it has to be done explicitly, and doing it on the buffers --
 * rather than by rotating the object -- is what keeps the bind pose, the
 * skeleton and the socket transforms in one space.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Box3,
  Vector3,
} from 'three';

import type { MeshPayload } from '../worker/archive.worker';

/** Archive (Z-up) to three.js (Y-up): `(x, y, z) -> (x, z, -y)`.
 *
 * Confirmed against the pipeline rather than assumed. The Sunchaser helmet's
 * GLB spans y 1.578 to 1.872 and the raw mesh spans z 1.578 to 1.872 -- the
 * same numbers, on the axis this maps between, on a 1.745 m skeleton where a
 * helmet belongs.
 */
export function toYUp(source: Float32Array): Float32Array {
  const out = new Float32Array(source.length);
  for (let i = 0; i < source.length; i += 3) {
    out[i] = source[i]!;
    out[i + 1] = source[i + 2]!;
    out[i + 2] = -source[i + 1]!;
  }
  return out;
}

export interface BuiltGeometry {
  geometry: BufferGeometry;
  bounds: Box3;
  /** Groups whose material id is beyond the material file's list. */
  orphanGroups: number;
}

/** What becomes of a group whose material id is past the material's list. */
export type MissingSubmaterial = 'hide' | 'clamp';

/**
 * Hide a group past the list only when the record or the definition `named`
 * the material and the material is a list. A single material -- a `.mtl` with
 * no `SubMaterials` block -- is drawn by the engine on every group of the
 * mesh: the display mannequins name `default_grey.mtl` on meshes of eight
 * groups and are grey all over, where hiding drew seven of them as holes.
 */
export function missingFor(named: boolean, material: { single?: boolean }): MissingSubmaterial {
  return named && !material.single ? 'hide' : 'clamp';
}

/**
 * `materialCount` is how many submaterials the `.mtl` actually declares. A
 * mesh really can reference a submaterial that does not exist, and a group
 * beyond the list is counted and, when the material is one the game names
 * (`missing` `hide`), not drawn: the game draws nothing there.
 *
 * Settled on the GCD-Army arms and legs. Their meshes are the ORC-mkX
 * XenoThreat v2's -- each names `m_cds_medium_armor_03_01_01` as its own
 * material, fifteen submaterials with the xeno overlay plates on 12 and 13 --
 * and GCD-Army's record overrides it with a material of nine. The game's icon
 * and CIG's render show the plain plates beneath, painted like the armour round
 * them. Clamped onto the last submaterial -- an unlit lamp, `helmet_light_m` --
 * the overlay drew as bright grey metal over them. Reading the missing slots
 * from the mesh's own material instead would draw the overlay, which neither
 * shows. The Lynx colourways agree with their icons the same way (their
 * materials drop the canonical's `cushion_*` slot, and no tan pad shows under
 * the chest plate), and the Python pipeline already left such groups out (the
 * Sunchaser helmet's seventh group, against six submaterials).
 *
 * A material the kitbasher chose itself -- discovered by class or mesh name,
 * borrowed from the other body's node, or the figure's -- `clamp`s, as before:
 * there a group past the list says the choice is wrong, not that the game
 * hides the part. The Aponte Explorer Goggles' discovered material is another
 * goggle's, and the strap the icon shows sits past its two submaterials.
 *
 * With no material at all (`materialCount` 0) every group draws with the one
 * placeholder, at index 0.
 */
export function buildGeometry(
  mesh: MeshPayload,
  materialCount: number,
  missing: MissingSubmaterial = 'hide',
): BuiltGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(toYUp(mesh.positions), 3));

  if (mesh.normals.length === mesh.positions.length) {
    geometry.setAttribute('normal', new BufferAttribute(toYUp(mesh.normals), 3));
  } else {
    // CryEngine hard-surface meshes depend on custom split normals and the
    // archive does not always carry them. Computing them here averages over
    // sharp panel edges, which is what made armour look low-poly in the
    // pipeline until `shade_auto_smooth` was added -- so this is a fallback,
    // not the intended path.
    geometry.computeVertexNormals();
  }

  if (mesh.uvs.length) {
    geometry.setAttribute('uv', new BufferAttribute(mesh.uvs, 2));
  }
  geometry.setAttribute('skinIndex', new BufferAttribute(mesh.joints, 4));
  geometry.setAttribute('skinWeight', new BufferAttribute(mesh.weights, 4));
  if (mesh.decalUvs) {
    geometry.setAttribute('fwDecalUv', new BufferAttribute(mesh.decalUvs, 2));
  }
  if (mesh.colors) {
    geometry.setAttribute('fwColor', new BufferAttribute(mesh.colors, 4, true));
  }
  if (mesh.joints1 && mesh.weights1) {
    geometry.setAttribute('skinIndex1', new BufferAttribute(mesh.joints1, 4));
    geometry.setAttribute('skinWeight1', new BufferAttribute(mesh.weights1, 4));
  }
  geometry.setIndex(new BufferAttribute(mesh.indices, 1));

  let orphanGroups = 0;
  for (const group of mesh.submeshes) {
    if (group.count === 0) continue;
    const beyond = materialCount > 0 && group.materialId >= materialCount;
    if (beyond) orphanGroups += 1;
    if (beyond && missing === 'hide') continue;
    const index = materialCount === 0 ? 0 : beyond ? materialCount - 1 : group.materialId;
    geometry.addGroup(group.start, group.count, index);
    // The zone rides on the group, for `zones.showUncovered`.
    (geometry.groups[geometry.groups.length - 1] as { zone?: string | null }).zone = group.zone ?? null;
  }

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const bounds = geometry.boundingBox ?? new Box3(new Vector3(), new Vector3());
  return { geometry, bounds, orphanGroups };
}
