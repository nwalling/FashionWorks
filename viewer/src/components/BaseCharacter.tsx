import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

import { assetUrl } from '../manifest';
import { findSkeleton } from '../three/binding';

interface SkeletonContextValue {
  skeleton: THREE.Skeleton | null;
  root: THREE.Object3D | null;
}

const SkeletonContext = createContext<SkeletonContextValue>({ skeleton: null, root: null });

export function useBaseSkeleton(): SkeletonContextValue {
  return useContext(SkeletonContext);
}

export function BaseCharacter({
  glb,
  hideBody = false,
  children,
}: {
  glb: string;
  /** Hide the built-in body when the user equips an undersuit of their own. */
  hideBody?: boolean;
  children?: React.ReactNode;
}) {
  const { scene } = useGLTF(assetUrl(glb));
  const [value, setValue] = useState<SkeletonContextValue>({ skeleton: null, root: null });

  // The base character is a singleton, so the cached scene is used directly
  // rather than cloned; items are added under it.
  const root = useMemo(() => scene, [scene]);

  // The base GLB ships a default undersuit so there is a body to look at and a
  // skeleton to bind to. Equipping another undersuit would stack two layers, so
  // the built-in one is hidden while that slot is filled.
  //
  // Armor pieces are reparented under this same root when they bind, so the
  // body meshes are captured once at mount rather than re-traversed, or
  // equipping a piece would hide the piece itself.
  const bodyMeshes = useMemo(() => {
    const found: THREE.Object3D[] = [];
    root.traverse((object) => {
      if ((object as THREE.SkinnedMesh).isSkinnedMesh) found.push(object);
    });
    return found;
  }, [root]);

  useEffect(() => {
    for (const mesh of bodyMeshes) mesh.visible = !hideBody;
  }, [bodyMeshes, hideBody]);

  useEffect(() => {
    const skeleton = findSkeleton(root);
    if (!skeleton) {
      console.error('[base] no skeleton in the base GLB — items cannot bind');
    }
    setValue({ skeleton, root });
  }, [root]);

  return (
    <SkeletonContext.Provider value={value}>
      <primitive object={root} />
      {value.skeleton ? children : null}
    </SkeletonContext.Provider>
  );
}
