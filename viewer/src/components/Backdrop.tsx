import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { useTexture } from '@react-three/drei';
import * as THREE from 'three';

import { assetUrl } from '../manifest';

/** Backdrops available behind the character. */
export const BACKDROPS = {
  none: null,
  hangar: 'backgrounds/hangar.jpg',
} as const;

export type BackdropName = keyof typeof BACKDROPS;

/**
 * A photographic plate behind the character.
 *
 * The lighting still comes from the HDR environment: this only replaces what
 * you see behind the model. A screenshot is a perspective image, not an
 * equirectangular map, so using it to light the scene would be wrong.
 */
export function Backdrop({ file }: { file: string }) {
  const texture = useTexture(assetUrl(file));
  const { scene, size } = useThree();

  useEffect(() => {
    texture.colorSpace = THREE.SRGBColorSpace;

    // Fill the canvas without distorting the plate: crop the overflowing axis
    // rather than stretching, the way CSS `background-size: cover` does.
    const image = texture.image as { width: number; height: number } | undefined;
    if (image?.width && image?.height && size.height > 0) {
      const canvasAspect = size.width / size.height;
      const imageAspect = image.width / image.height;
      if (canvasAspect > imageAspect) {
        const scale = imageAspect / canvasAspect;
        texture.repeat.set(1, scale);
        texture.offset.set(0, (1 - scale) / 2);
      } else {
        const scale = canvasAspect / imageAspect;
        texture.repeat.set(scale, 1);
        texture.offset.set((1 - scale) / 2, 0);
      }
      texture.needsUpdate = true;
    }

    const previous = scene.background;
    scene.background = texture;
    return () => {
      scene.background = previous;
    };
  }, [texture, scene, size.width, size.height]);

  return null;
}
