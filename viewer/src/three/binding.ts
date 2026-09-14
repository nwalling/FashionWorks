import * as THREE from 'three';

/**
 * Binding an item's SkinnedMesh onto the base character's skeleton (PLAN.md §5.3).
 *
 * `SkinnedMesh.bind` only produces correct deformation when the mesh's
 * `skinIndex` attribute indexes the same bone order as the target skeleton.
 *
 * Option A (the fast path) holds because every item.glb is exported against
 * the identical canonical armature, so joint order already matches and binding
 * is a pointer swap.
 *
 * Option B is the safety net: when orders differ, the `skinIndex` buffer is
 * remapped by bone name onto a cloned geometry. When a bone is missing from the
 * base skeleton entirely, the mesh is refused rather than silently deformed.
 */

export interface BindReport {
  bound: number;
  remapped: number;
  skipped: number;
  missingBones: string[];
}

export function emptyReport(): BindReport {
  return { bound: 0, remapped: 0, skipped: 0, missingBones: [] };
}

function boneIndex(skeleton: THREE.Skeleton): Map<string, number> {
  const map = new Map<string, number>();
  skeleton.bones.forEach((bone, index) => map.set(bone.name, index));
  return map;
}

/** True when the mesh's own joint order already matches the target skeleton. */
function orderMatches(source: THREE.Skeleton, target: Map<string, number>): boolean {
  return source.bones.every((bone, index) => target.get(bone.name) === index);
}

function remapSkinIndex(
  mesh: THREE.SkinnedMesh,
  source: THREE.Skeleton,
  target: Map<string, number>,
): void {
  const attribute = mesh.geometry.getAttribute('skinIndex');
  if (!attribute) return;

  // Geometry is shared with the useGLTF cache, so never rewrite it in place.
  const geometry = mesh.geometry.clone();
  const skinIndex = geometry.getAttribute('skinIndex') as THREE.BufferAttribute;
  const remapped = new Uint16Array(skinIndex.count * skinIndex.itemSize);

  for (let i = 0; i < skinIndex.count; i += 1) {
    for (let component = 0; component < skinIndex.itemSize; component += 1) {
      const local = skinIndex.getComponent(i, component);
      const name = source.bones[local]?.name;
      const mapped = name === undefined ? 0 : target.get(name);
      remapped[i * skinIndex.itemSize + component] = mapped ?? 0;
    }
  }

  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(remapped, skinIndex.itemSize));
  mesh.geometry = geometry;
}

/**
 * Rebind every SkinnedMesh in `source` onto `skeleton` and reparent it under
 * `target`. Returns the meshes that were attached, for later teardown.
 */
export function bindSkinned(
  source: THREE.Object3D,
  skeleton: THREE.Skeleton,
  target: THREE.Object3D,
  report: BindReport = emptyReport(),
): { meshes: THREE.SkinnedMesh[]; report: BindReport } {
  const index = boneIndex(skeleton);
  const candidates: THREE.SkinnedMesh[] = [];
  source.traverse((object) => {
    if ((object as THREE.SkinnedMesh).isSkinnedMesh) candidates.push(object as THREE.SkinnedMesh);
  });

  const attached: THREE.SkinnedMesh[] = [];
  for (const mesh of candidates) {
    const own = mesh.skeleton;
    if (!own) {
      report.skipped += 1;
      continue;
    }

    const missing = own.bones.map((b) => b.name).filter((name) => !index.has(name));
    if (missing.length > 0) {
      report.skipped += 1;
      for (const name of missing) {
        if (!report.missingBones.includes(name)) report.missingBones.push(name);
      }
      console.warn('[binding] skipping mesh; bones absent from the base skeleton:', missing);
      continue;
    }

    if (!orderMatches(own, index)) {
      remapSkinIndex(mesh, own, index);
      report.remapped += 1;
    }

    const bindMatrix = mesh.bindMatrix.clone();
    mesh.bind(skeleton, bindMatrix);
    // Item transforms are already baked; the base rig owns world placement.
    mesh.position.set(0, 0, 0);
    mesh.quaternion.identity();
    mesh.scale.set(1, 1, 1);
    mesh.frustumCulled = false;
    rememberOrigin(mesh);
    target.add(mesh);

    attached.push(mesh);
    report.bound += 1;
  }

  return { meshes: attached, report };
}

/** Attach a rigid piece to a named socket bone. */

/**
 * Where a mesh lived before it was bound, so a rebind can find it again.
 *
 * Binding reparents meshes out of the cloned GLTF scene and under the base
 * character. `detach` used to only remove them, which left the clone empty, so
 * the next bind traversed it, found no meshes and attached nothing. That is
 * silent: the piece simply vanishes. It bit socket pieces in particular,
 * because their bind effect re-runs whenever the torso changes the mount
 * offset -- equipping a torso made the backpack disappear for good.
 */
type Origin = { parent: THREE.Object3D | null; matrix: THREE.Matrix4 };

function rememberOrigin(mesh: THREE.Object3D): void {
  if (mesh.userData.__bindOrigin) return;
  const origin: Origin = { parent: mesh.parent, matrix: mesh.matrix.clone() };
  mesh.userData.__bindOrigin = origin;
}

function restoreOrigin(mesh: THREE.Object3D): void {
  const origin = mesh.userData.__bindOrigin as Origin | undefined;
  mesh.parent?.remove(mesh);
  if (!origin) return;
  origin.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
  origin.parent?.add(mesh);
  delete mesh.userData.__bindOrigin;
}

export function bindSocket(
  source: THREE.Object3D,
  skeleton: THREE.Skeleton,
  socket: string,
  offset?: THREE.Vector3,
): { meshes: THREE.Object3D[]; attachedTo: THREE.Bone | null } {
  const bone = skeleton.getBoneByName(socket) ?? null;
  const meshes: THREE.Object3D[] = [];
  const candidates: THREE.Object3D[] = [];
  source.traverse((object) => {
    if ((object as THREE.Mesh).isMesh && !(object as THREE.SkinnedMesh).isSkinnedMesh) {
      candidates.push(object);
    }
  });

  if (!bone) {
    console.warn(`[binding] socket "${socket}" not found on the base skeleton`);
    return { meshes, attachedTo: null };
  }

  // Rigid pieces are authored in body space, the same space as the base
  // character. Parenting to a bone would apply that bone's rest transform on
  // top, so cancel it first. Doing it here rather than baking it in Blender
  // avoids having to agree about Z-up versus Y-up with the glTF exporter.
  bone.updateWorldMatrix(true, false);
  const cancel = new THREE.Matrix4().copy(bone.matrixWorld).invert();
  if (offset && offset.lengthSq() > 0) {
    // Parenting reapplies the bone's world matrix B, so the mesh ends up at
    // B * cancel. For a plain world-space shift T the cancel term has to be
    // B⁻¹ * T, giving B * B⁻¹ * T = T. Pre-multiplying instead yields
    // B * T * B⁻¹, which rotates the offset by the bone and moved a backpack
    // sideways and forwards rather than back.
    cancel.multiply(new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z));
  }

  for (const mesh of candidates) {
    rememberOrigin(mesh);
    mesh.position.set(0, 0, 0);
    mesh.quaternion.identity();
    mesh.scale.set(1, 1, 1);
    mesh.applyMatrix4(cancel);
    bone.add(mesh);
    mesh.frustumCulled = false;
    meshes.push(mesh);
  }
  return { meshes, attachedTo: bone };
}

/**
 * Remove attached meshes from the scene. Geometry and materials are shared with
 * the GLTF cache, so only geometry this module cloned for a remap is disposed.
 */
export function detach(meshes: THREE.Object3D[], cloned: Set<THREE.BufferGeometry>): void {
  for (const mesh of meshes) {
    restoreOrigin(mesh);
    const geometry = (mesh as THREE.Mesh).geometry;
    if (geometry && cloned.has(geometry)) {
      geometry.dispose();
      cloned.delete(geometry);
    }
  }
}

/** First skeleton found in a loaded scene. */
export function findSkeleton(root: THREE.Object3D): THREE.Skeleton | null {
  let found: THREE.Skeleton | null = null;
  root.traverse((object) => {
    if (!found && (object as THREE.SkinnedMesh).isSkinnedMesh) {
      found = (object as THREE.SkinnedMesh).skeleton;
    }
  });
  return found;
}
