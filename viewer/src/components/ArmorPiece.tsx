import { useEffect, useMemo, useState } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

import type { Item } from '../manifest';
import { assetUrl } from '../manifest';
import { bindSkinned, bindSocket, detach, emptyReport } from '../three/binding';
import { useBaseSkeleton } from './BaseCharacter';

/**
 * One equipped piece. The loaded GLTF stays in the useGLTF cache; each mount
 * clones the hierarchy (sharing geometry and materials) and rebinds the clone
 * onto the base skeleton, so swapping slots does not grow GPU memory.
 *
 * Binding reparents the meshes out of the cloned scene and under the base
 * character, so anything that needs to touch them afterwards — tinting — must
 * work from the list the bind step returns, not by traversing the clone.
 */
export function ArmorPiece({
  item,
  tint,
  socketOffset,
}: {
  item: Item;
  tint?: string;
  /**
   * Shift for a rigid piece's mount point, supplied by whatever torso is worn.
   * Every piece carries its own copy of the attachment bones, positioned for
   * its own bulk, so a backpack hung off the canonical bone sinks into heavy
   * armor.
   */
  socketOffset?: [number, number, number];
}) {
  const url = assetUrl(item.assets.glb ?? '');
  const { scene } = useGLTF(url);
  const { skeleton, root, bodyBox, setBodyCover } = useBaseSkeleton();

  const instance = useMemo(() => cloneSkinned(scene) as THREE.Object3D, [scene]);

  // The offset arrives as a fresh array on every render. Depending on its
  // identity made the bind effect tear down and rebuild continuously, which
  // left socket pieces missing from the scene entirely.
  const offsetKey = socketOffset ? socketOffset.join(',') : '';
  const [attached, setAttached] = useState<THREE.Object3D[]>([]);

  useEffect(() => {
    if (!skeleton || !root) return undefined;
    const clonedGeometries = new Set<THREE.BufferGeometry>();
    let meshes: THREE.Object3D[] = [];

    if (item.bind_mode === 'socket' && item.socket) {
      const offset = offsetKey
        ? new THREE.Vector3(...(offsetKey.split(',').map(Number) as [number, number, number]))
        : undefined;
      meshes = bindSocket(instance, skeleton, item.socket, offset).meshes;
    } else {
      const before = new Set<THREE.BufferGeometry>();
      instance.traverse((object) => {
        const geometry = (object as THREE.Mesh).geometry;
        if (geometry) before.add(geometry);
      });

      const result = bindSkinned(instance, skeleton, root, emptyReport());
      meshes = result.meshes;
      for (const mesh of result.meshes) {
        if (!before.has(mesh.geometry)) clonedGeometries.add(mesh.geometry);
      }
      if (result.report.skipped > 0) {
        console.warn(`[armor] ${item.class_name}: ${result.report.skipped} mesh(es) skipped`, result.report);
      }

      if (meshes.length === 0) {
        // The manifest called this skinned but the GLB has no SkinnedMesh.
        // Rendering nothing at all is the worst outcome, so fall back to the
        // socket, then to the scene root, and say so.
        console.warn(
          `[armor] ${item.class_name}: no skinned mesh in ${item.assets.glb}; falling back to rigid`,
        );
        meshes = item.socket
          ? bindSocket(instance, skeleton, item.socket).meshes
          : [];
        if (meshes.length === 0) {
          root.add(instance);
          meshes = [instance];
        }
      }
    }

    setAttached(meshes);

    // A full-body undersuit replaces the built-in body; a partial one must not,
    // or the character loses its legs. Height alone does not separate them: a
    // waist-up piece measured 1.20 against a 1.64 body, which is 73%. What does
    // separate them is whether the piece reaches the feet. Measured on real
    // items, full suits start at y=0.00 and a torso wrap starts at y=0.65.
    if (item.slot === 'undersuit' && meshes.length > 0 && bodyBox) {
      const box = new THREE.Box3();
      for (const mesh of meshes) box.expandByObject(mesh);
      const reachesFeet = !box.isEmpty() && box.min.y <= bodyBox.min.y + 0.15;
      const reachesChest = !box.isEmpty() && box.max.y >= bodyBox.min.y + (bodyBox.max.y - bodyBox.min.y) * 0.6;
      setBodyCover(item.id, reachesFeet && reachesChest);
    }

    return () => {
      setAttached([]);
      setBodyCover(item.id, false);
      detach(meshes, clonedGeometries);
    };
  }, [instance, skeleton, root, item, bodyBox, setBodyCover, offsetKey]);

  // Tinting clones the material so the shared cache entry keeps its own colour.
  useEffect(() => {
    if (!tint || attached.length === 0) return undefined;
    const color = new THREE.Color(tint);
    const restore: Array<[THREE.Mesh, THREE.Material | THREE.Material[]]> = [];

    for (const object of attached) {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) continue;
      restore.push([mesh, mesh.material]);

      const source = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const tinted = source.map((material) => {
        const copy = material.clone() as THREE.MeshStandardMaterial;
        if (copy.color) copy.color.copy(color);
        return copy;
      });
      mesh.material = Array.isArray(mesh.material) ? tinted : tinted[0];
    }

    return () => {
      for (const [mesh, original] of restore) {
        const current = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of current) material.dispose();
        mesh.material = original;
      }
    };
  }, [attached, tint]);

  return null;
}
