/** The 3D view, themed.
 *
 * Small on purpose. Everything that makes armour appear -- the archive worker,
 * the canonical armature, the LayerBlend composite -- already exists and is
 * verified; what this adds is the part CSS cannot do, which is making a WebGL
 * scene follow `data-theme`.
 *
 * A scene's background, grid and outlines are numbers held by a renderer.
 * Nothing re-reads them when the site switches theme, so they are applied from
 * tokens here and re-applied whenever the tokens change.
 */

import { useEffect, useRef } from 'react';
import {
  AmbientLight,
  Color,
  DirectionalLight,
  GridHelper,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';

import { applyTheme, isLight, outlineColour } from '../three/sceneTheme';
import type { Tokens } from '../theme';

export interface ViewerProps {
  readonly tokens: Tokens;
  /** Called once the scene exists, so a caller can add armour to it. */
  readonly onScene?: (scene: Scene, renderer: WebGLRenderer) => void;
  readonly className?: string;
}

export function Viewer({ tokens, onScene, className }: ViewerProps): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef<{
    scene: Scene;
    renderer: WebGLRenderer;
    camera: PerspectiveCamera;
    grid: GridHelper;
    key: DirectionalLight;
    fill: AmbientLight;
  } | null>(null);

  // Set-up runs once. Tokens are applied in a second effect so a theme change
  // never rebuilds the scene -- rebuilding it would drop the armour in it.
  useEffect(() => {
    const element = host.current;
    if (!element) return undefined;

    const scene = new Scene();
    scene.background = new Color(0x000000);
    // `preserveDrawingBuffer` so the canvas can be read back after compositing.
    // Without it `readPixels` outside the draw call returns an empty buffer,
    // which makes "did the scene follow the theme?" unanswerable from a test.
    const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    element.appendChild(renderer.domElement);

    const camera = new PerspectiveCamera(38, 1, 0.01, 50);
    camera.position.set(0.9, 1.45, 1.35);
    camera.lookAt(0, 1.35, 0);

    const grid = new GridHelper(4, 16);
    scene.add(grid);
    const key = new DirectionalLight(0xffffff, 2.2);
    key.position.set(1.2, 2.0, 1.6);
    scene.add(key);
    const fill = new AmbientLight(0xffffff, 1.4);
    scene.add(fill);

    const resize = () => {
      const { clientWidth, clientHeight } = element;
      if (!clientWidth || !clientHeight) return;
      renderer.setSize(clientWidth, clientHeight, false);
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);

    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      renderer.render(scene, camera);
    };
    tick();

    live.current = { scene, renderer, camera, grid, key, fill };
    onScene?.(scene, renderer);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.dispose();
      renderer.domElement.remove();
      live.current = null;
    };
  }, [onScene]);

  // The theme, applied on mount and on every change.
  useEffect(() => {
    const current = live.current;
    if (!current) return;
    applyTheme(current, tokens);
    // A light theme needs less ambient fill, or everything washes out; a dark
    // one needs more, or the armour reads as a silhouette. Decided from the
    // page colour rather than from the theme's name, which can change.
    current.fill.intensity = isLight(tokens) ? 0.9 : 1.4;
    current.key.color.setHex(outlineColour(tokens) === 0 ? 0xffffff : 0xffffff);
  }, [tokens]);

  return <div ref={host} className={className} data-fashionworks-view="" />;
}
