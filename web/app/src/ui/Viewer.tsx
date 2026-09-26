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
  HalfFloatType,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';

import { createGround, groundLook, type Ground } from '../three/ground';
import { applyTheme, isLight, untoneMapped } from '../three/sceneTheme';
import { readTokens, type Tokens } from '../theme';

/** What a caller gets once the scene exists. */
export interface ViewerHandle {
  readonly scene: Scene;
  readonly renderer: WebGLRenderer;
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  /** The lights a lighting preset drives. */
  readonly lights: { readonly key: DirectionalLight; readonly rim: DirectionalLight; readonly fill: AmbientLight };
  /** Render one frame through whatever pipeline the quality setting runs. */
  render(): void;
  /** The quality setting in use, and a way to change it. */
  readonly quality: () => Quality;
  setQuality(quality: Quality): void;
  /** A photograph behind the character, or none.
   *
   * Cropped to cover rather than stretched. **Lighting still comes from the
   * scene**: a screenshot is a perspective image, not an equirectangular map,
   * so using it to light the armour would be wrong. The grid goes away while a
   * backdrop is up, because it reads as floating debris over a photo. */
  setBackdrop(url: string | null): void;
}

/** RENDERING.md Phase 2: how much the renderer does per pixel.
 *
 * - **low** draws straight to the canvas with the context's own 4x
 *   multisampling, as the viewer always did;
 * - **medium** adds a post chain: the scene into a multisampled half-float
 *   target, ground-truth ambient occlusion (contact shading under straps and
 *   plate edges), then tone mapping and colour space in `OutputPass`;
 * - **high** is medium at the display's full pixel ratio, and the two scaled
 *   settings draw 1.5x and 2x the display's pixels besides.
 *
 * With the post chain the canvas is transparent and the theme colour is the
 * element's CSS background: `OutputPass` tone-maps and exposes the whole
 * image, and a page colour pushed through the armour's exposure no longer
 * matched the page around it. */
export type Quality = 'low' | 'medium' | 'high' | 'high-150' | 'high-200';

export const QUALITIES: ReadonlyArray<{ readonly id: Quality; readonly label: string }> = [
  { id: 'low', label: 'low' },
  { id: 'medium', label: 'medium' },
  { id: 'high', label: 'high' },
  { id: 'high-150', label: 'high 150%' },
  { id: 'high-200', label: 'high 200%' },
];

/** A first guess from the GPU's name: software renderers get low, integrated
 * Intel and mobile parts medium, everything else high. A visitor's own choice
 * replaces it and is remembered. */
export function detectQuality(renderer: WebGLRenderer): Quality {
  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const name = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  if (/swiftshader|llvmpipe|software/i.test(name)) return 'low';
  if (/intel|mali|adreno|powervr|apple gpu/i.test(name)) return 'medium';
  return 'high';
}

function pixelRatioFor(quality: Quality): number {
  const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
  switch (quality) {
    case 'low': return 1;
    case 'medium': return Math.min(dpr, 1.5);
    case 'high': return Math.min(dpr, 2);
    case 'high-150': return Math.min(dpr * 1.5, 3);
    default: return Math.min(dpr * 2, 3);
  }
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

const QUALITY_KEY = 'fashionworks:quality';

function rememberedQuality(): Quality | null {
  try {
    const saved = localStorage.getItem(QUALITY_KEY);
    return QUALITIES.some((q) => q.id === saved) ? (saved as Quality) : null;
  } catch {
    return null;
  }
}

function rememberQuality(quality: Quality): void {
  try {
    localStorage.setItem(QUALITY_KEY, quality);
  } catch {
    // Blocked storage: the setting lasts for this visit.
  }
}

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
    /** Re-apply the page colour, grid and floor for the current theme. */
    sync: () => void;
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
    let quality: Quality = rememberedQuality() ?? detectQuality(renderer);
    renderer.setPixelRatio(pixelRatioFor(quality));
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

    // The post chain, when the quality setting wants one.
    let chain: { composer: EffectComposer; gtao: GTAOPass } | null = null;
    const buildChain = () => {
      const width = Math.max(1, element.clientWidth);
      const height = Math.max(1, element.clientHeight);
      const target = new WebGLRenderTarget(width, height, { type: HalfFloatType, samples: 4 });
      const composer = new EffectComposer(renderer, target);
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(width, height);
      composer.addPass(new RenderPass(scene, camera));
      const gtao = new GTAOPass(scene, camera, width, height);
      // Metres: the figure is 1.8 m, and occlusion wants to reach a strap's
      // depth under a plate, not the neighbouring limb.
      gtao.updateGtaoMaterial({ radius: 0.12, distanceExponent: 1, thickness: 1, scale: 1, samples: 16 });
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
      gtao.blendIntensity = 0.9;
      // GTAO draws depth and normals with one override material, which knows
      // nothing of a cut-out: every hair card went in as a solid quad, and
      // the skin round the strands took occlusion from quads nobody sees --
      // a brown fringe under the beard and a darkened skin between strands.
      // Hair stays out of that pass (`userData.noAo`); a cap is its occlusion.
      const overrideVisibility = gtao.overrideVisibility.bind(gtao);
      gtao.overrideVisibility = () => {
        overrideVisibility();
        scene.traverse((object) => {
          if (object.userData.noAo) object.visible = false;
        });
      };
      composer.addPass(gtao);
      composer.addPass(new OutputPass());
      return { composer, gtao };
    };
    const dropChain = () => {
      if (!chain) return;
      chain.gtao.dispose();
      chain.composer.dispose();
      chain = null;
    };

    const resize = () => {
      const { clientWidth, clientHeight } = element;
      if (!clientWidth || !clientHeight) return;
      renderer.setSize(clientWidth, clientHeight, false);
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
      if (chain) {
        chain.composer.setPixelRatio(renderer.getPixelRatio());
        chain.composer.setSize(clientWidth, clientHeight);
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);

    // What the theme asked for, kept so the chain can compensate for its own
    // exposure and tone curve every frame -- a preset can change either.
    const page = new Color();
    const gridBase = new Color();
    const scratch = new Color();
    // GridHelper's minor lines carry 0x888888 as a vertex colour.
    const GRID_MINOR = new Color(0x888888).r;
    const gridMaterial = () => (Array.isArray(grid.material) ? grid.material[0] : grid.material) as { color: Color };
    const remember = () => {
      if (scene.background && (scene.background as Color).isColor) page.copy(scene.background as Color);
      gridBase.copy(gridMaterial().color);
    };
    const compensate = () => {
      if (!chain || state.backdrop || !scene.background) return;
      untoneMapped(page, renderer.toneMappingExposure, renderer.toneMapping, scene.background as Color);
      scratch.copy(gridBase).multiplyScalar(GRID_MINOR);
      untoneMapped(scratch, renderer.toneMappingExposure, renderer.toneMapping, scratch);
      gridMaterial().color.copy(scratch).multiplyScalar(1 / GRID_MINOR);
    };
    const render = () => {
      if (chain) {
        compensate();
        chain.composer.render();
      } else {
        renderer.render(scene, camera);
      }
    };
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      controls.update();
      render();
    };

    const state = { scene, renderer, grid, fill, ground, backdrop: false, sync: () => {} };
    live.current = state;

    /** The canvas paints the theme colour itself only when nothing tone-maps
     * the image after it; otherwise it is transparent over the element's
     * CSS background, which is the theme colour. */
    /** The canvas paints the page colour itself, opaque, except behind a
     * backdrop photograph. Transparent over a CSS colour was tried for the
     * post chain and failed twice: the panel colour showed through, and the
     * output pass sRGB-encodes premultiplied colour, which brightened every
     * half-covered pixel of the floor until the grid drowned. Opaque, with
     * the page colour run backwards through the tone curve, is exact. */
    const syncBackground = () => {
      element.style.backgroundColor = 'var(--sc-dark)';
      const tokens = readTokens();
      if (state.backdrop) {
        scene.background = null;
        renderer.setClearAlpha(0);
      } else {
        scene.background = new Color(0x000000);
        renderer.setClearAlpha(1);
        applyTheme({ scene, renderer, grid }, tokens);
      }
      remember();
      ground.setLook(groundLook(tokens, isLight(tokens), state.backdrop, Boolean(chain)));
    };

    state.sync = syncBackground;

    const setQuality = (next: Quality) => {
      quality = next;
      renderer.setPixelRatio(pixelRatioFor(next));
      renderer.shadowMap.needsUpdate = true;
      if (next === 'low') dropChain();
      else if (!chain) chain = buildChain();
      resize();
      syncBackground();
    };
    setQuality(quality);
    tick();

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
        syncBackground();
        grid.visible = false;
      } else {
        element.style.backgroundImage = '';
        element.style.backgroundSize = '';
        element.style.backgroundPosition = '';
        element.style.backgroundRepeat = '';
        element.classList.remove('fw-has-backdrop');
        grid.visible = true;
        syncBackground();
      }
    };

    latestOnScene.current?.({
      scene, renderer, camera, controls, lights: { key, rim, fill }, setBackdrop,
      render,
      quality: () => quality,
      setQuality: (next) => {
        rememberQuality(next);
        setQuality(next);
      },
    });

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      dropChain();
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
    // Page colour, grid and floor, and what the post chain compensates from.
    current.sync();
    // A light theme needs less ambient fill, or everything washes out; a dark
    // one needs more, or the armour reads as a silhouette. Decided from the
    // page colour rather than from the theme's name, which can change.
    // Scaled from whatever the lighting preset set as its base.
    current.fill.userData.themeScale = isLight(tokens) ? 0.65 : 1;
    current.fill.intensity = ((current.fill.userData.base as number | undefined) ?? 1.3) * current.fill.userData.themeScale;
  }, [tokens]);

  return <div ref={host} className={className} data-fashionworks-view="" />;
}
