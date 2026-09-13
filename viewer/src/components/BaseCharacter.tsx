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
  children,
}: {
  glb: string;
  children?: React.ReactNode;
}) {
  const { scene } = useGLTF(assetUrl(glb));
  const [value, setValue] = useState<SkeletonContextValue>({ skeleton: null, root: null });

  // The base character is a singleton, so the cached scene is used directly
  // rather than cloned; items are added under it.
  const root = useMemo(() => scene, [scene]);

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
