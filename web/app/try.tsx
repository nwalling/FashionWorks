/** Something to actually try.
 *
 * Everything the port can do, in one page: a loadout read out of a real
 * `Data.p4k`, skinned onto the canonical armature, surfaced with the LayerBlend
 * shader, a prop on its socket, poses out of the game's own animation data, and
 * the theme switch that restyles both the page and the scene.
 *
 * The verification pages next door each prove one thing and report numbers.
 * This one is for looking at.
 */

import {
  AmbientLight,
  Color,
  DirectionalLight,
  GridHelper,
  Mesh,
  PerspectiveCamera,
  Scene,
  Box3,
  SkinnedMesh,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { buildGeometry } from './src/three/geometry';
import { applyClip, buildRig, mountMatrix, type BuiltRig } from './src/three/rig';
import { applyTheme, isLight } from './src/three/sceneTheme';
import { compositeSurfaces, materialFor, type PaletteEntry } from './src/three/surface';
import { readTokens, watchTheme, type Tokens } from './src/theme';
import type {
  FromWorker, MaterialPayload, MeshPayload, PropPayload, TexturePayload, ToWorker,
} from './src/worker/archive.worker';

const THEMES = ['hangarworks', 'dolomite', 'keystone', 'navy'] as const;

const POSES = [
  { label: 'rest', dba: null, clip: null },
  {
    label: 'idle',
    dba: 'Animations/Characters/Human/male_v7/weapons/no_weapon/locomotion/stand.dba',
    clip: 'nw_stand_idle_turn360_planted',
  },
  {
    label: 'crouch',
    dba: 'Animations/Characters/Human/male_v7/weapons/no_weapon/locomotion/crouch.dba',
    clip: 'nw_neutral_crouch_idle',
  },
] as const;

const BASE_SKELETON = 'Objects/Characters/Human/male_v7/export/bhm_skeleton_v7.chr';

/** Two donors exactly: 220 base bones + 34 + 1 reaches the pipeline's canonical
 * armature of 255 with 35 attachment points, no bone missing and none extra. */
const DONORS = [
  'Objects/Characters/Human/male_v7/armor/cds/m_cds_undersuit_armor_02.skin',
  'Objects/Characters/Human/male_v7/armor/slaver/m_slaver_heavy_armor_01_core.skin',
];

const PIECES = [
  {
    name: 'Defiance Helmet Sunchaser',
    path: 'Objects/Characters/Human/male_v7/armor/slaver/m_slaver_heavy_armor_helmet_01.skin',
    mtl: 'Objects/Characters/Human/male_v7/armor/slaver/m_slaver_heavy_armor_helmet_01_01_01.mtl',
    materials: 6,
  },
  {
    name: 'Defiance Core Sunchaser',
    path: 'Objects/Characters/Human/male_v7/armor/slaver/m_slaver_heavy_armor_01_core.skin',
    mtl: 'Objects/Characters/Human/male_v7/armor/slaver/m_slaver_heavy_armor_core_01_01_01.mtl',
    materials: 8,
  },
];

const PROP = {
  name: 'BUL-H4 Ammo Carrier',
  path: 'Objects/Characters/Human/backpack/cds/m_cds_combat_superheavy_backpack_01.cga',
  mtl: 'Objects/Characters/Human/backpack/cds/m_cds_combat_superheavy_backpack_01_05.mtl',
  socket: 'backpack_attach_1_override',
  materials: 4,
};

function hex(value: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** `slaver_heavy_01_01_03` — the Sunchaser palette. entryA is the gold every
 * measurement in this repo is anchored to. */
const PALETTE: PaletteEntry[] = [
  { color: hex('#f9b541'), spec: hex('#f9b541'), glossiness: 0.62 },
  { color: hex('#5e5e5c'), spec: hex('#5e5e5c'), glossiness: 0.55 },
  { color: hex('#575757'), spec: hex('#575757'), glossiness: 0.55 },
];

const statusEl = document.getElementById('status') as HTMLPreElement;
const viewEl = document.getElementById('view') as HTMLDivElement;
const lines: string[] = [];
const say = (line: string) => {
  lines.push(line);
  statusEl.textContent = lines.slice(-7).join('\n');
};
const replaceLast = (line: string) => {
  lines[lines.length - 1] = line;
  statusEl.textContent = lines.slice(-7).join('\n');
};

// ── scene ───────────────────────────────────────────────────────────────────
const scene = new Scene();
scene.background = new Color(0x000000);
// `preserveDrawingBuffer` so the canvas can be read back after compositing,
// which is how a check confirms the scene followed a theme change rather than
// taking the page's word for it.
const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
viewEl.appendChild(renderer.domElement);

const camera = new PerspectiveCamera(35, 1, 0.01, 60);
camera.position.set(1.4, 1.5, 1.9);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.2, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.5;
controls.maxDistance = 8;

const grid = new GridHelper(4, 16);
scene.add(grid);
const key = new DirectionalLight(0xffffff, 2.2);
key.position.set(1.2, 2.0, 1.6);
scene.add(key);
const rim = new DirectionalLight(0xffffff, 0.6);
rim.position.set(-1.6, 1.0, -1.4);
scene.add(rim);
const ambient = new AmbientLight(0xffffff, 1.3);
scene.add(ambient);

function resize(): void {
  const { clientWidth, clientHeight } = viewEl;
  if (!clientWidth || !clientHeight) return;
  renderer.setSize(clientWidth, clientHeight, false);
  camera.aspect = clientWidth / clientHeight;
  camera.updateProjectionMatrix();
}
resize();
new ResizeObserver(resize).observe(viewEl);

function frame(): void {
  requestAnimationFrame(frame);
  controls.update();
  renderer.render(scene, camera);
}
frame();

// ── theme ───────────────────────────────────────────────────────────────────
function paint(tokens: Tokens): void {
  applyTheme({ scene, renderer, grid }, tokens);
  ambient.intensity = isLight(tokens) ? 0.85 : 1.3;
}
paint(readTokens());
watchTheme(paint);

const themeBar = document.getElementById('themes')!;
for (const name of THEMES) {
  const button = document.createElement('button');
  button.textContent = name;
  button.onclick = () => document.documentElement.setAttribute('data-theme', name);
  themeBar.appendChild(button);
}
const syncThemeButtons = () => {
  const current = document.documentElement.getAttribute('data-theme');
  themeBar.querySelectorAll('button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.textContent === current));
  });
};
syncThemeButtons();
new MutationObserver(syncThemeButtons).observe(document.documentElement, {
  attributes: true, attributeFilter: ['data-theme'],
});

// ── the worker, as a request/response ───────────────────────────────────────
function rpc(worker: Worker) {
  const waiting = new Map<string, Array<(value: FromWorker) => void>>();
  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const message = event.data;
    if (message.type === 'progress') {
      replaceLast(`${message.step}…`);
      return;
    }
    if (message.type === 'failed') {
      say(`failed: ${message.message}`);
      return;
    }
    waiting.get(message.type)?.shift()?.(message);
  };
  return <T extends FromWorker['type']>(request: ToWorker, expect: T) =>
    new Promise<Extract<FromWorker, { type: T }>>((resolve) => {
      const queue = waiting.get(expect) ?? [];
      queue.push(resolve as (value: FromWorker) => void);
      waiting.set(expect, queue);
      worker.postMessage(request);
    });
}

let rig: BuiltRig | undefined;
const loaded: Object3D[] = [];

async function main(): Promise<void> {
  const head = await fetch('/__p4k', { method: 'HEAD' });
  const total = Number(head.headers.get('content-length') ?? 0);
  if (!total) {
    say('No archive is being served.');
    say('Restart the dev server with FW_ARCHIVE set to your Data.p4k.');
    return;
  }
  say(`archive ${(total / 1024 ** 3).toFixed(2)} GB`);
  say('reading…');

  const worker = new Worker(new URL('./src/worker/archive.worker.ts', import.meta.url), {
    type: 'module',
  });
  const ask = rpc(worker);

  const indexed = await ask({
    type: 'open-url', url: '/__p4k', byteLength: total, skeleton: 'male', catalogue: false,
  }, 'indexed');
  replaceLast(`${indexed.entryCount.toLocaleString()} entries indexed in ${(indexed.ms / 1000).toFixed(1)}s`);

  const rigMessage = await ask({ type: 'rig', base: BASE_SKELETON, donors: DONORS }, 'rig');
  rig = buildRig(rigMessage.bones);
  scene.add(rig.root);
  say(`rig ${rigMessage.summary.bones} bones, ${rigMessage.summary.attachments} sockets`);

  const fetchTexture = async (path: string, maxSize: number): Promise<TexturePayload | null> =>
    (await ask({ type: 'texture', path, maxSize }, 'texture')).texture;

  const build = async (
    piece: { name: string; mtl: string; materials: number },
    payload: MeshPayload,
    wear: boolean,
  ) => {
    const material = await ask({ type: 'material', path: piece.mtl }, 'material');
    const composited = await compositeSurfaces(
      material.material as MaterialPayload, PALETTE, fetchTexture, wear,
    );
    const { geometry } = buildGeometry(payload, piece.materials);
    const materials = (material.material as MaterialPayload).submaterials
      .map((sub) => materialFor(sub.name, composited));
    return { geometry, materials };
  };

  for (const piece of PIECES) {
    say(`${piece.name}…`);
    const mesh = await ask({ type: 'mesh', path: piece.path }, 'mesh');
    const { geometry, materials } = await build(piece, mesh.mesh, true);
    const object = new SkinnedMesh(geometry, materials);
    object.frustumCulled = false;
    scene.add(object);
    object.bind(rig.skeleton, object.matrixWorld);
    loaded.push(object);
    replaceLast(`${piece.name}  ${(mesh.mesh.indices.length / 3).toLocaleString()} triangles`);
  }

  say(`${PROP.name}…`);
  const prop = await ask({ type: 'prop', path: PROP.path, socket: PROP.socket }, 'prop');
  const propPayload = prop.prop as PropPayload;
  const built = await build(PROP, propPayload, true);
  const packObject = new Mesh(built.geometry, built.materials);
  packObject.frustumCulled = false;
  const bone = rig.byName.get(PROP.socket);
  if (bone && propPayload.mount) {
    packObject.matrixAutoUpdate = false;
    packObject.matrix.copy(mountMatrix(propPayload.mount));
    bone.add(packObject);
  } else {
    scene.add(packObject);
  }
  loaded.push(packObject);
  replaceLast(`${PROP.name}  mounted on its socket`);

  // Frame the whole thing, measured rather than guessed: the loadout spans
  // roughly y 1.0 to 1.9, so aim at its middle and stand back far enough for a
  // 35-degree lens to hold it.
  const bounds = new Box3();
  for (const object of loaded) bounds.expandByObject(object);
  const centre = bounds.getCenter(new Vector3());
  const size = bounds.getSize(new Vector3());
  const reach = Math.max(size.x, size.y, size.z);
  const distance = (reach / 2) / Math.tan((camera.fov * Math.PI) / 360) * 1.5;
  controls.target.copy(centre);
  // Negative z, because that is the character's *front*: the archive is Z-up
  // with +y forward, and `(x, y, z) -> (x, z, -y)` puts the visor at -z. Facing
  // the other way frames the backpack and hides the armour.
  camera.position.set(centre.x + distance * 0.55, centre.y + distance * 0.2, centre.z - distance);

  // ── poses ────────────────────────────────────────────────────────────────
  const poseBar = document.getElementById('poses')!;
  const restRotations = new Map(rig.bones.map((b) => [b.name, b.quaternion.clone()]));
  let activePose = 'rest';

  const setPose = async (entry: (typeof POSES)[number]) => {
    if (!rig) return;
    activePose = entry.label;
    poseBar.querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.textContent === activePose));
    });
    if (!entry.dba || !entry.clip) {
      for (const boneObject of rig.bones) {
        boneObject.quaternion.copy(restRotations.get(boneObject.name)!);
      }
      rig.root.updateMatrixWorld(true);
      rig.skeleton.update();
      say('rest pose');
      return;
    }
    const posed = await ask({ type: 'pose', path: entry.dba, clip: entry.clip }, 'pose');
    applyClip(rig, posed.pose.locals);
    say(`${entry.label}: ${posed.pose.animated} of ${posed.pose.clipBones} clip bones`);
  };

  for (const entry of POSES) {
    const button = document.createElement('button');
    button.textContent = entry.label;
    button.onclick = () => void setPose(entry);
    poseBar.appendChild(button);
  }

  // ── wear ─────────────────────────────────────────────────────────────────
  const optionBar = document.getElementById('opts')!;
  const wearButton = document.createElement('button');
  let wear = true;
  wearButton.textContent = 'worn';
  wearButton.setAttribute('aria-pressed', 'true');
  wearButton.onclick = async () => {
    wear = !wear;
    wearButton.textContent = wear ? 'worn' : 'factory';
    wearButton.setAttribute('aria-pressed', String(wear));
    wearButton.disabled = true;
    say(`recompositing ${wear ? 'worn' : 'as it left the factory'}…`);
    // Only the surfaces change; the meshes and the rig stay exactly as they are.
    for (let i = 0; i < PIECES.length; i += 1) {
      const piece = PIECES[i]!;
      const target = loaded[i] as SkinnedMesh;
      const material = await ask({ type: 'material', path: piece.mtl }, 'material');
      const composited = await compositeSurfaces(
        material.material as MaterialPayload, PALETTE, fetchTexture, wear,
      );
      target.material = (material.material as MaterialPayload).submaterials
        .map((sub) => materialFor(sub.name, composited));
    }
    replaceLast(wear ? 'worn' : 'as it left the factory');
    wearButton.disabled = false;
  };
  optionBar.appendChild(wearButton);

  await setPose(POSES[1]!);
  say('ready — drag to orbit');
}

void main().catch((error) => {
  say(`threw: ${error instanceof Error ? error.message : String(error)}`);
});
