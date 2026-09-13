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
export function ArmorPiece({ item, tint }: { item: Item; tint?: string }) {
  const url = assetUrl(item.assets.glb ?? '');
  const { scene } = useGLTF(url);
  const { skeleton, root } = useBaseSkeleton();

  const instance = useMemo(() => cloneSkinned(scene) as THREE.Object3D, [scene]);
  const [attached, setAttached] = useState<THREE.Object3D[]>([]);

  useEffect(() => {
    if (!skeleton || !root) return undefined;
    const clonedGeometries = new Set<THREE.BufferGeometry>();
    let meshes: THREE.Object3D[] = [];

    if (item.bind_mode === 'socket' && item.socket) {
      meshes = bindSocket(instance, skeleton, item.socket).meshes;
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
    }

    setAttached(meshes);
    return () => {
      setAttached([]);
      detach(meshes, clonedGeometries);
    };
  }, [instance, skeleton, root, item.bind_mode, item.socket, item.class_name]);

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
