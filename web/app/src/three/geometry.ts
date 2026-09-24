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

/**
 * `materialCount` is how many submaterials the `.mtl` actually declares. A
 * group beyond it is passed through as its own group with a clamped index, and
 * counted, because a mesh really can reference a submaterial that does not
 * exist -- the Sunchaser helmet has seven groups against six submaterials.
 */
export function buildGeometry(mesh: MeshPayload, materialCount: number): BuiltGeometry {
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
    geometry.addGroup(
      group.start,
      group.count,
      beyond ? Math.max(0, materialCount - 1) : group.materialId,
    );
  }

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const bounds = geometry.boundingBox ?? new Box3(new Vector3(), new Vector3());
  return { geometry, bounds, orphanGroups };
}
