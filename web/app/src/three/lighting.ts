/** How the scene is lit: the game's probes, its authored rigs, a tone curve.
 *
 * RENDERING.md Phase 1. The viewer used to invent its light -- a key, a rim,
 * a flat ambient, no environment, no tone mapping -- and metal read flat
 * because there was nothing for it to reflect. Now the environment is one of
 * the game's own lighting probes, decoded from the visitor's archive, and a
 * preset is data: which probe, how strong, where the key sits.
 *
 * **Two numbers come from each probe, not from taste.** Its mean radiance
 * normalises it -- the inventory probe averages about 0.01, the sunny Daymar
 * probe 0.4, and either would otherwise be black or blinding -- and its
 * brightest direction aims the shadow-casting key, so the shadow falls the way
 * the environment says the light comes from.
 *
 * **Orientation was measured, not assumed.** The probes are standard Y-up
 * cubes, so three.js reads them with no rotation: in the Idris hangar the face
 * labelled -Y is the one dim, even face (the floor), and all four side faces
 * are brighter along their top edge.
 *
 * The **Character creator** preset is the customizer's own rig,
 * `LightRig_Female_Lightgroup` in `charactercustomizer_pu.socpak`: ten spots
 * whose axes meet within 4-28 cm of one point 1.62 m up, 0.5-0.9 m from each
 * light -- a head-and-shoulders rig. It is anchored at the head, and its 1 m
 * attenuation radius is dropped so a full-length figure falls off with
 * distance, as it would in a portrait, rather than ending at the collar.
 */

import {
  AmbientLight,
  Color,
  CubeTexture,
  DataTexture,
  DirectionalLight,
  FloatType,
  Group,
  LinearFilter,
  LinearSRGBColorSpace,
  NeutralToneMapping,
  NoToneMapping,
  Object3D,
  PMREMGenerator,
  RGBAFormat,
  Scene,
  SpotLight,
  Vector3,
  type ToneMapping,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';

import type { ArchiveClient } from '../archive/client';
import type { RigLight } from '../worker/archive.worker';

export const PROBES = {
  inventory: 'Data/Textures/cubemaps/inventory_setup/cm_inventory_probe_cm.dds',
  medical: 'Engine/EngineAssets/Textures/LookDevelopmentMode/envprobes/environmentprobe_idris_medical_room_cm.dds',
  hangar: 'Engine/EngineAssets/Textures/LookDevelopmentMode/envprobes/environmentprobe_idris_hangar_cm.dds',
  daymar: 'Engine/EngineAssets/Textures/LookDevelopmentMode/envprobes/environmentprobe_stanton2b_sunny_cm.dds',
  yela: 'Engine/EngineAssets/Textures/LookDevelopmentMode/envprobes/environmentprobe_stanton2c_sunny_cm.dds',
  space: 'Engine/EngineAssets/Textures/LookDevelopmentMode/envprobes/environmentprobe_SOL_cm.dds',
} as const;

export const CUSTOMIZER = {
  socpak: 'Data/ObjectContainers/Frontend/CharacterCustomizer/charactercustomizer_pu.socpak',
  group: 'LightRig_Female_Lightgroup',
};

export interface LightPreset {
  readonly id: string;
  readonly label: string;
  /** A probe from [`PROBES`], or none. */
  readonly probe: keyof typeof PROBES | null;
  /** Mean radiance the probe is normalised to. */
  readonly environment: number;
  /** Keep the probe's light and drop its hue. The inventory probe is lit in
   * the inventory screen's purple -- mean RGB about (0.020, 0.006, 0.022) --
   * which tints every piece it lights; as grey it keeps where the light comes
   * from and lets the item's own colour read. */
  readonly neutral?: boolean;
  readonly exposure: number;
  readonly toneMapping: ToneMapping;
  /** The shadow-casting key. `direction` toward the light, or `probe` for
   * the probe's brightest direction. */
  readonly key: { readonly intensity: number; readonly direction: 'probe' | readonly [number, number, number]; readonly color?: number };
  readonly rim: number;
  readonly ambient: number;
  /** The customizer's authored rig, scaled from its authored intensities. */
  readonly rig?: { readonly scale: number };
}

/** Everything a preset needs, all of it reproducible from the archive.
 *
 * **Calibrated on the render harness**, not by eye: `inventory` is the
 * reference and was tuned until the Sunchaser's gold-to-non-gold contrast sat
 * mid-band (2.88 against CIG's 2.48-3.47) with the Defiance Tactical torso at
 * mean 36 / median 27 against the in-game 34 / 29. Environment and exposure
 * then came down by the same 0.7 on every other preset so their moods stay
 * relative to it. */
export const LIGHT_PRESETS: readonly LightPreset[] = [
  {
    id: 'inventory',
    label: 'inventory',
    probe: 'inventory',
    neutral: true,
    environment: 0.35,
    exposure: 0.7,
    toneMapping: NeutralToneMapping,
    key: { intensity: 1.6, direction: 'probe' },
    rim: 0.5,
    ambient: 0.35,
  },
  {
    id: 'studio',
    label: 'studio',
    probe: 'medical',
    environment: 0.385,
    exposure: 0.7,
    toneMapping: NeutralToneMapping,
    key: { intensity: 2.0, direction: [0.8, 1.4, -1.2] },
    rim: 0.9,
    ambient: 0.25,
  },
  {
    id: 'hangar',
    label: 'hangar',
    probe: 'hangar',
    environment: 0.35,
    exposure: 0.7,
    toneMapping: NeutralToneMapping,
    key: { intensity: 1.4, direction: 'probe' },
    rim: 0.3,
    ambient: 0.2,
  },
  {
    id: 'daylight',
    label: 'daylight',
    probe: 'daymar',
    environment: 0.42,
    exposure: 0.63,
    toneMapping: NeutralToneMapping,
    key: { intensity: 3.2, direction: 'probe', color: 0xfff4e6 },
    rim: 0,
    ambient: 0.1,
  },
  {
    id: 'space',
    label: 'space',
    probe: 'space',
    environment: 0.105,
    exposure: 0.7,
    toneMapping: NeutralToneMapping,
    key: { intensity: 3.0, direction: 'probe' },
    rim: 0.15,
    ambient: 0.05,
  },
  {
    id: 'creator',
    label: 'character creator',
    probe: 'inventory',
    neutral: true,
    environment: 0.14,
    exposure: 0.7,
    toneMapping: NeutralToneMapping,
    key: { intensity: 0, direction: [0, 1, 0] },
    rim: 0,
    ambient: 0.15,
    rig: { scale: 40 },
  },
  {
    // Today's rig before this phase, kept so a visitor can compare and the
    // harness can reproduce the baseline.
    id: 'classic',
    label: 'classic',
    probe: null,
    environment: 0,
    exposure: 1.0,
    toneMapping: NoToneMapping,
    key: { intensity: 2.2, direction: [1.2, 2.0, 1.6] },
    rim: 0.6,
    ambient: 1.3,
  },
];

export const DEFAULT_PRESET = 'inventory';

interface Probe {
  readonly target: WebGLRenderTarget;
  /** Mean luminance over the sphere, before normalising. */
  readonly mean: number;
  /** Unit vector toward the brightest part, in three.js space. */
  readonly key: Vector3;
}

/** A texel's direction on a cube face, standard layout, y down the image. */
function faceDirection(face: number, s: number, t: number, out: Vector3): Vector3 {
  switch (face) {
    case 0: return out.set(1, -t, -s);
    case 1: return out.set(-1, -t, s);
    case 2: return out.set(s, 1, t);
    case 3: return out.set(s, -1, -t);
    case 4: return out.set(s, -t, 1);
    default: return out.set(-s, -t, -1);
  }
}

/** The mean and the brightest direction of a cube. The brightest direction is
 * the luminance-weighted mean of the top 1% of texels, which is the sun on a
 * planet probe and the key window or panel indoors. three.js mirrors a cube
 * texture in x when it samples one (`flipEnvMap`), so x is negated to land in
 * scene space. */
export function probeStatistics(size: number, rgba: Float32Array): { mean: number; key: Vector3 } {
  const n = size * size;
  const lum = new Float32Array(n * 6);
  let sum = 0;
  for (let i = 0; i < n * 6; i += 1) {
    const y = 0.2126 * rgba[i * 4]! + 0.7152 * rgba[i * 4 + 1]! + 0.0722 * rgba[i * 4 + 2]!;
    lum[i] = y;
    sum += y;
  }
  const sorted = Float32Array.from(lum).sort();
  const threshold = sorted[Math.floor(sorted.length * 0.99)]!;
  const key = new Vector3();
  const d = new Vector3();
  for (let face = 0; face < 6; face += 1) {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const v = lum[face * n + y * size + x]!;
        if (v < threshold) continue;
        faceDirection(face, (2 * (x + 0.5)) / size - 1, (2 * (y + 0.5)) / size - 1, d).normalize();
        key.addScaledVector(d, v);
      }
    }
  }
  key.x = -key.x;
  if (key.lengthSq() < 1e-12) key.set(0, 1, 0);
  return { mean: sum / (n * 6), key: key.normalize() };
}

export interface LightingView {
  readonly scene: Scene;
  readonly renderer: WebGLRenderer;
  readonly key: DirectionalLight;
  readonly rim: DirectionalLight;
  readonly fill: AmbientLight;
}

/** Where the key sits when it follows a direction: far enough that the
 * shadow camera the viewer framed stays centred on the figure. */
const KEY_DISTANCE = 6;

export class StudioLighting {
  private readonly probes = new Map<string, Promise<Probe>>();

  private readonly rig = new Group();

  private rigLights: RigLight[] | null = null;

  private current: string | null = null;

  constructor(
    private readonly view: LightingView,
    private readonly client: ArchiveClient,
  ) {
    this.rig.name = 'fw-light-rig';
    view.scene.add(this.rig);
  }

  get preset(): string | null {
    return this.current;
  }

  private asked = 0;

  /** Light the scene with a preset. Two in flight -- a remembered choice and
   * the default racing at start-up -- resolve to whichever was asked last. */
  async apply(id: string): Promise<boolean> {
    const ticket = ++this.asked;
    const preset = LIGHT_PRESETS.find((p) => p.id === id) ?? LIGHT_PRESETS[0]!;
    const { scene, renderer, key, rim, fill } = this.view;
    const probe = preset.probe ? await this.probe(PROBES[preset.probe], preset.neutral ?? false) : null;
    const lights = preset.rig ? await this.rigFor() : [];
    if (ticket !== this.asked) return false;

    renderer.toneMapping = preset.toneMapping;
    renderer.toneMappingExposure = preset.exposure;
    if (probe) {
      scene.environment = probe.target.texture;
      scene.environmentIntensity = preset.environment / Math.max(probe.mean, 1e-6);
    } else {
      scene.environment = null;
      scene.environmentIntensity = 1;
    }

    const direction = preset.key.direction === 'probe'
      ? (probe?.key.clone() ?? new Vector3(0, 1, 0))
      : new Vector3(...preset.key.direction).normalize();
    // Never from below the floor: a probe whose brightest patch is the ground
    // (a sunlit desert) would otherwise light the figure from underneath.
    if (direction.y < 0.25) {
      direction.y = 0.25;
      direction.normalize();
    }
    key.intensity = preset.key.intensity;
    key.color.set(preset.key.color ?? 0xffffff);
    key.position.copy(key.target.position).addScaledVector(direction, KEY_DISTANCE);
    key.castShadow = preset.key.intensity > 0;
    rim.intensity = preset.rim;
    // The viewer scales fill by theme; the preset sets what it scales.
    fill.userData.base = preset.ambient;
    fill.intensity = preset.ambient * ((fill.userData.themeScale as number | undefined) ?? 1);

    this.rig.clear();
    for (const light of lights) this.rig.add(light);

    // The materials' programs depend on tone mapping and on whether an
    // environment is bound; three recompiles on its own when either changes.
    this.current = preset.id;
    return true;
  }

  private probe(path: string, neutral: boolean): Promise<Probe> {
    const cacheKey = `${path}:${neutral}`;
    let pending = this.probes.get(cacheKey);
    if (!pending) {
      pending = this.client.probe(path, 256).then(({ size, rgba }) => {
        if (neutral) {
          for (let i = 0; i < rgba.length; i += 4) {
            const y = 0.2126 * rgba[i]! + 0.7152 * rgba[i + 1]! + 0.0722 * rgba[i + 2]!;
            rgba[i] = y;
            rgba[i + 1] = y;
            rgba[i + 2] = y;
          }
        }
        const faces = Array.from({ length: 6 }, (_, f) => {
          const texels = new Float32Array(rgba.buffer as ArrayBuffer, rgba.byteOffset + f * size * size * 16, size * size * 4);
          const face = new DataTexture(texels, size, size, RGBAFormat, FloatType);
          face.needsUpdate = true;
          return face;
        });
        const cube = new CubeTexture(faces as unknown as HTMLImageElement[]);
        cube.format = RGBAFormat;
        cube.type = FloatType;
        cube.colorSpace = LinearSRGBColorSpace;
        cube.minFilter = LinearFilter;
        cube.magFilter = LinearFilter;
        cube.generateMipmaps = false;
        cube.needsUpdate = true;
        const pmrem = new PMREMGenerator(this.view.renderer);
        const target = pmrem.fromCubemap(cube);
        pmrem.dispose();
        cube.dispose();
        const stats = probeStatistics(size, rgba);
        return { target, mean: stats.mean, key: stats.key };
      });
      this.probes.set(cacheKey, pending);
      pending.catch(() => this.probes.delete(cacheKey));
    }
    return pending;
  }

  /** The customizer's spots, as three.js lights anchored at the head. */
  private async rigFor(): Promise<Object3D[]> {
    this.rigLights ??= await this.client.lightRig(CUSTOMIZER.socpak, CUSTOMIZER.group);
    const spots = this.rigLights.filter((l) => l.kind === 'Projector');
    if (!spots.length) return [];
    const subject = convergence(spots);
    const preset = LIGHT_PRESETS.find((p) => p.rig)!;
    // Anchored where the rig is aimed: 1.62 m up in the customizer.
    const head = new Vector3(0, subject.z, 0);
    const out: Object3D[] = [];
    for (const light of spots) {
      // Archive Z-up to scene Y-up, (x, y, z) -> (x, z, -y), relative to the
      // point the rig is aimed at.
      const p = new Vector3(light.position[0] - subject.x, light.position[2] - subject.z, -(light.position[1] - subject.y));
      const d = new Vector3(light.direction[0], light.direction[2], -light.direction[1]).normalize();
      const spot = new SpotLight(new Color(...light.color), light.intensity * preset.rig!.scale);
      spot.position.copy(head).add(p);
      spot.target.position.copy(spot.position).addScaledVector(d, 1);
      spot.angle = ((light.fov || 90) * Math.PI) / 360;
      spot.penumbra = 0.6;
      spot.decay = 2;
      spot.distance = 0;
      out.push(spot, spot.target);
    }
    return out;
  }

  dispose(): void {
    this.rig.removeFromParent();
    for (const pending of this.probes.values()) void pending.then((p) => p.target.dispose(), () => {});
    this.probes.clear();
  }
}

/** The point nearest every spot's axis, weighted by intensity: where an
 * authored rig is aimed. Archive frame. */
export function convergence(spots: readonly RigLight[]): { x: number; y: number; z: number } {
  const a = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const b = [0, 0, 0];
  for (const s of spots) {
    const [dx, dy, dz] = s.direction;
    const len = Math.hypot(dx, dy, dz) || 1;
    const d = [dx / len, dy / len, dz / len];
    const w = s.intensity;
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        const p = (i === j ? 1 : 0) - d[i]! * d[j]!;
        a[i * 3 + j]! += w * p;
        b[i]! += w * p * s.position[j]!;
      }
    }
  }
  // Cramer's rule on the 3x3.
  const det = (m: number[]) => m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!)
    - m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!)
    + m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!);
  const d0 = det(a) || 1;
  const col = (k: number) => a.map((v, idx) => (idx % 3 === k ? b[Math.floor(idx / 3)]! : v));
  return { x: det(col(0)) / d0, y: det(col(1)) / d0, z: det(col(2)) / d0 };
}
