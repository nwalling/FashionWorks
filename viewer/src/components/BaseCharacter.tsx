import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

import { assetUrl } from '../manifest';
import { findSkeleton } from '../three/binding';

interface SkeletonContextValue {
  skeleton: THREE.Skeleton | null;
  root: THREE.Object3D | null;
  /** Bounds of the built-in body, so a piece can report whether it covers it. */
  bodyBox: THREE.Box3 | null;
  /** An undersuit registers here; the built-in body hides only if one covers it. */
  setBodyCover: (id: string, covers: boolean) => void;
}

const SkeletonContext = createContext<SkeletonContextValue>({
  skeleton: null,
  root: null,
  bodyBox: null,
  setBodyCover: () => {},
});

export function useBaseSkeleton(): SkeletonContextValue {
  return useContext(SkeletonContext);
}

export function BaseCharacter({
  glb,
  children,
}: {
  glb: string;
  children?: React.ReactNode;
}) {
  const { scene } = useGLTF(assetUrl(glb));
  const [value, setValue] = useState<SkeletonContextValue>({
    skeleton: null,
    root: null,
    bodyBox: null,
    setBodyCover: () => {},
  });

  // The base character is a singleton, so the cached scene is used directly
  // rather than cloned; items are added under it.
  const root = useMemo(() => scene, [scene]);

  // The base GLB ships a default undersuit so there is a body to look at and a
  // skinned mesh for the skeleton. Equipping a full-body undersuit would stack
  // two layers, so the built-in one hides — but only for a piece that actually
  // covers it. Several items in the undersuit slot are partial (a torso wrap, a
  // necksock), and hiding the whole body for those left a legless torso.
  //
  // Armor is reparented under this same root when it binds, so the body meshes
  // are captured once at mount rather than re-traversed.
  const bodyMeshes = useMemo(() => {
    const found: THREE.Object3D[] = [];
    root.traverse((object) => {
      if ((object as THREE.SkinnedMesh).isSkinnedMesh) found.push(object);
    });
    return found;
  }, [root]);

  const bodyBox = useMemo(() => {
    const box = new THREE.Box3();
    for (const mesh of bodyMeshes) box.expandByObject(mesh);
    return box.isEmpty() ? null : box;
  }, [bodyMeshes]);

  const [covers, setCovers] = useState<Record<string, boolean>>({});
  const setBodyCover = useCallback((id: string, value: boolean) => {
    setCovers((current) => {
      if (value === Boolean(current[id])) return current;
      const next = { ...current };
      if (value) next[id] = true;
      else delete next[id];
      return next;
    });
  }, []);

  const hideBody = Object.keys(covers).length > 0;

  useEffect(() => {
    for (const mesh of bodyMeshes) mesh.visible = !hideBody;
    return () => {
      for (const mesh of bodyMeshes) mesh.visible = true;
    };
  }, [bodyMeshes, hideBody]);

  useEffect(() => {
    const skeleton = findSkeleton(root);
    if (!skeleton) {
      console.error('[base] no skeleton in the base GLB — items cannot bind');
    }
    setValue({ skeleton, root, bodyBox, setBodyCover });
  }, [root, bodyBox, setBodyCover]);


  return (
    <SkeletonContext.Provider value={value}>
      <primitive object={root} />
      {value.skeleton ? children : null}
    </SkeletonContext.Provider>
  );
}
