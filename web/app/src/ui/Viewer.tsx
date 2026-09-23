/** The 3D view, themed.
 *
 * Small on purpose. Everything that makes armour appear -- the archive worker,
 * the canonical armature, the LayerBlend composite -- lives in `Kitbasher`;
 * what this owns is the part CSS cannot do, which is making a WebGL scene
 * follow `data-theme`, plus the camera, the lights and the grid.
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
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { createGround, groundLook, type Ground } from '../three/ground';
import { applyTheme, isLight } from '../three/sceneTheme';
import { readTokens, type Tokens } from '../theme';

/** What a caller gets once the scene exists. */
export interface ViewerHandle {
  readonly scene: Scene;
  readonly renderer: WebGLRenderer;
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  /** A photograph behind the character, or none.
   *
   * Cropped to cover rather than stretched. **Lighting still comes from the
   * scene**: a screenshot is a perspective image, not an equirectangular map,
   * so using it to light the armour would be wrong. The grid goes away while a
   * backdrop is up, because it reads as floating debris over a photo. */
  setBackdrop(url: string | null): void;
}

/** Where the key light comes from -- up, behind and to the right of a figure
 * facing the default camera -- and how its shadow is framed. The shadow camera
 * covers a body and anything carried out to arm's length at 2.4 m square;
 * 2048 texels over that is about a millimetre each. */
const KEY_DIRECTION = new Vector3(1.2, 2.0, 1.6).normalize();
const KEY_AIM = 0.9;
const KEY_DISTANCE = 6;
const SHADOW_REACH = 1.2;
const SHADOW_DEPTH = 5;
const SHADOW_MAP = 2048;

export interface ViewerProps {
  readonly tokens: Tokens;
  /** Called once, when the scene exists. Kept in a ref, so a new function on
   * every render never rebuilds the scene -- rebuilding it would drop the
   * armour in it. */
  readonly onScene?: (handle: ViewerHandle) => void;
  readonly className?: string;
}

export function Viewer({ tokens, onScene, className }: ViewerProps): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const latestOnScene = useRef(onScene);
  latestOnScene.current = onScene;
  const live = useRef<{
    scene: Scene;
    renderer: WebGLRenderer;
    grid: GridHelper;
    fill: AmbientLight;
    ground: Ground;
    backdrop: boolean;
  } | null>(null);

  // Set-up runs once. Tokens are applied in a second effect so a theme change
  // never rebuilds the scene.
  useEffect(() => {
    const element = host.current;
    if (!element) return undefined;

    const scene = new Scene();
    scene.background = new Color(0x000000);
    // `alpha` so a backdrop photograph can show through where the scene is
    // empty; `preserveDrawingBuffer` so the canvas can be read back after
    // compositing, which is how a check confirms the scene followed a theme
    // change -- without it `readPixels` outside the draw call returns nothing.
    const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
    element.appendChild(renderer.domElement);

    const camera = new PerspectiveCamera(35, 1, 0.01, 60);
    camera.position.set(1.1, 1.5, -2.2);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1.2, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 0.4;
    controls.maxDistance = 9;

    const grid = new GridHelper(4, 16);
    scene.add(grid);
    const key = new DirectionalLight(0xffffff, 2.2);
    // The key light is the one that casts: its shadow lands on the floor and
    // on the armour itself. Aimed at the middle of the body and backed off
    // along the same direction it always had, so the lighting is unchanged
    // and the shadow camera can be framed tightly round one figure.
    key.target.position.set(0, KEY_AIM, 0);
    key.position.copy(key.target.position).addScaledVector(KEY_DIRECTION, KEY_DISTANCE);
    key.castShadow = true;
    key.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    Object.assign(key.shadow.camera, {
      left: -SHADOW_REACH, right: SHADOW_REACH, top: SHADOW_REACH, bottom: -SHADOW_REACH,
      near: KEY_DISTANCE - SHADOW_DEPTH / 2, far: KEY_DISTANCE + SHADOW_DEPTH / 2,
    });
    key.shadow.camera.updateProjectionMatrix();
    // Skinned armour is thin plates over plates: a small normal offset keeps
    // a plate from shadowing itself in stripes without letting light leak
    // under the one above it.
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.012;
    scene.add(key, key.target);
    const ground = createGround({ reach: SHADOW_REACH, depth: SHADOW_DEPTH });
    scene.add(ground.mesh);
    const rim = new DirectionalLight(0xffffff, 0.6);
    rim.position.set(-1.6, 1.0, -1.4);
    scene.add(rim);
    const fill = new AmbientLight(0xffffff, 1.3);
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
      controls.update();
      renderer.render(scene, camera);
    };
    tick();

    const state = { scene, renderer, grid, fill, ground, backdrop: false };
    live.current = state;

    const setBackdrop = (url: string | null) => {
      state.backdrop = Boolean(url);
      if (url) {
        // Every longhand set here, inline, not just the image: `.fw-view`
        // declares the `background` *shorthand*, which resets size and
        // position to their initial values -- so the photo rendered at its
        // natural size pinned to the top left, whatever `.fw-kit-view` said.
        element.style.backgroundImage = `url("${url}")`;
        element.style.backgroundSize = 'cover';
        element.style.backgroundPosition = 'center';
        element.style.backgroundRepeat = 'no-repeat';
        element.classList.add('fw-has-backdrop');
        // The canvas has to stop painting the theme colour over the photo.
        scene.background = null;
        renderer.setClearAlpha(0);
        grid.visible = false;
        ground.setLook(groundLook(readTokens(), false, true));
      } else {
        element.style.backgroundImage = '';
        element.style.backgroundSize = '';
        element.style.backgroundPosition = '';
        element.style.backgroundRepeat = '';
        element.classList.remove('fw-has-backdrop');
        scene.background = new Color(0x000000);
        renderer.setClearAlpha(1);
        grid.visible = true;
        const tokens = readTokens();
        applyTheme({ scene, renderer, grid }, tokens);
        ground.setLook(groundLook(tokens, isLight(tokens), false));
      }
    };

    latestOnScene.current?.({ scene, renderer, camera, controls, setBackdrop });

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      ground.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      live.current = null;
    };
  }, []);

  // The theme, applied on mount and on every change.
  useEffect(() => {
    const current = live.current;
    if (!current) return;
    // With a backdrop up there is no scene background to tint; the grid is
    // hidden too, so only the lighting balance still applies.
    applyTheme(
      { scene: current.scene, renderer: current.renderer, grid: current.backdrop ? undefined : current.grid },
      tokens,
    );
    // A light theme needs less ambient fill, or everything washes out; a dark
    // one needs more, or the armour reads as a silhouette. Decided from the
    // page colour rather than from the theme's name, which can change.
    current.fill.intensity = isLight(tokens) ? 0.85 : 1.3;
    current.ground.setLook(groundLook(tokens, isLight(tokens), current.backdrop));
  }, [tokens]);

  return <div ref={host} className={className} data-fashionworks-view="" />;
}
