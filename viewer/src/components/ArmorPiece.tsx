import { useEffect, useMemo, useState } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

import type { Item } from '../manifest';
import { assetUrl } from '../manifest';
import { bindSkinned, bindSocket, detach, emptyReport } from '../three/binding';
import { retain } from '../three/gltfCache';
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
  wear = true,
}: {
  item: Item;
  tint?: string;
  /**
   * Show the piece worn, with its scuffs and bare-metal patches, or as it left
   * the factory. The wear blend is baked, so this picks between two composited
   * surfaces rather than changing anything at render time. A build made before
   * the unworn bake existed has none, and falls back to the worn one.
   */
  wear?: boolean;
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

  // A colour variant reuses the canonical mesh but not its surface, so it
  // carries its own composited textures and they are swapped in here. Both
  // this and an explicit user tint clone the material first, so the shared
  // useGLTF cache entry keeps its own.
  useEffect(() => {
    const overrides = item.material_overrides ?? [];
    if (attached.length === 0 || (overrides.length === 0 && !tint)) return undefined;

    // Blender appends ".001" when two slots share a name.
    const key = (value: string) => value.replace(/\.\d{3}$/, '').toLowerCase();
    const bySlot = new Map(overrides.map((entry) => [key(entry.name), entry]));

    const loader = new THREE.TextureLoader();
    const created: THREE.Texture[] = [];
    const restore: Array<[THREE.Mesh, THREE.Material | THREE.Material[]]> = [];
    let cancelled = false;

    // Match the glTF loader's conventions, and inherit whatever the texture we
    // are replacing already had: aoMap in particular reads its UV set from the
    // texture, not the material.
    const load = (url: string, template: THREE.Texture | null, srgb: boolean) =>
      new Promise<THREE.Texture | null>((resolve) => {
        loader.load(
          assetUrl(url),
          (texture) => {
            texture.flipY = template ? template.flipY : false;
            texture.channel = template ? template.channel : 0;
            texture.wrapS = template ? template.wrapS : THREE.RepeatWrapping;
            texture.wrapT = template ? template.wrapT : THREE.RepeatWrapping;
            texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
            texture.needsUpdate = true;
            created.push(texture);
            resolve(texture);
          },
          undefined,
          () => resolve(null),
        );
      });

    const color = tint ? new THREE.Color(tint) : null;

    void (async () => {
      for (const object of attached) {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh || !mesh.material) continue;

        const source = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const replaced: THREE.Material[] = [];
        let changed = false;

        for (const material of source) {
          const copy = material.clone() as THREE.MeshStandardMaterial;
          const entry = bySlot.get(key(copy.name ?? ''));

          const albedo = wear ? entry?.base_color : entry?.base_color_unworn ?? entry?.base_color;
          const packed = wear ? entry?.orm : entry?.orm_unworn ?? entry?.orm;

          if (albedo) {
            const texture = await load(albedo, copy.map, true);
            if (texture) {
              copy.map = texture;
              // The composited albedo is the colour; a leftover multiply from
              // the canonical material would double-tint it.
              if (copy.color && !color) copy.color.setRGB(1, 1, 1);
              changed = true;
            }
          }
          if (packed) {
            const template = copy.roughnessMap ?? copy.metalnessMap ?? copy.aoMap;
            const texture = await load(packed, template, false);
            if (texture) {
              // One packed image: occlusion in red, roughness green, metallic blue.
              copy.aoMap = texture;
              copy.roughnessMap = texture;
              copy.metalnessMap = texture;
              copy.roughness = 1;
              copy.metalness = 1;
              changed = true;
            }
          }
          if (color && copy.color) {
            copy.color.copy(color);
            changed = true;
          }
          copy.needsUpdate = true;
          replaced.push(changed ? copy : material);
          if (!changed) copy.dispose();
        }

        if (cancelled) break;
        if (replaced.some((material, index) => material !== source[index])) {
          restore.push([mesh, mesh.material]);
          mesh.material = Array.isArray(mesh.material) ? replaced : replaced[0];
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const [mesh, original] of restore) {
        const current = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of current) {
          if (!(Array.isArray(original) ? original : [original]).includes(material)) {
            material.dispose();
          }
        }
        mesh.material = original;
      }
      for (const texture of created) texture.dispose();
    };
  }, [attached, tint, item.material_overrides, wear]);

  // Hold this GLB in the cache for as long as the piece is mounted, and let the
  // byte budget evict it once it is not. Declared last on purpose: React runs
  // cleanups in declaration order, so this release happens *after* the bind
  // effect's `detach` and after the tint effect restores the shared materials,
  // and eviction can never dispose objects still parented into the scene.
  useEffect(() => retain(url, scene), [url, scene]);

  return null;
}
