/** An armour piece read out of the visitor's own `Data.p4k` and put on screen.
 *
 * This is the first point in the web port where every stage meets: byte ranges
 * out of a 147 GB archive, a wasm parse of the split `.skin`/`.skinm` pair, the
 * eight-to-four influence reduction, Z-up to Y-up, and a `BufferGeometry` bound
 * to a material per submaterial group.
 *
 * Deliberately *not* here yet, and each is its own piece of work: the LayerBlend
 * shader (`web/gpu/`), the canonical armature and the name remap, and pose
 * retargeting. The mesh renders in its bind pose with a plain material, which
 * is enough to answer the only question this page asks -- does the geometry
 * come out of the archive intact and in the right place.
 */

import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  GridHelper,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';

import { buildGeometry } from './src/three/geometry';
import type { FromWorker, MeshPayload, ToWorker } from './src/worker/archive.worker';

/** The piece to show. Sunchaser because it is the set every other measurement
 * in this repo is anchored to. */
const PIECE = {
  name: 'Defiance Helmet Sunchaser',
  path: 'Objects/Characters/Human/male_v7/armor/slaver/m_slaver_heavy_armor_helmet_01.skin',
  /** The `.mtl` declares six submaterials; the mesh declares seven groups. */
  materials: 6,
};

const status = document.getElementById('status') as HTMLDivElement;
const lines: string[] = [];
const say = (line: string) => {
  lines.push(line);
  status.textContent = lines.join('\n');
};

const scene = new Scene();
scene.background = new Color('#0a1219');

const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const camera = new PerspectiveCamera(38, innerWidth / innerHeight, 0.01, 50);
scene.add(new AmbientLight(0xffffff, 1.4));
const key = new DirectionalLight(0xffffff, 2.2);
key.position.set(1.2, 2.0, 1.6);
scene.add(key);
const fill = new DirectionalLight(0x8fb6c8, 0.7);
fill.position.set(-1.5, 0.6, -1.2);
scene.add(fill);

// A metre grid at the floor, so "is this at head height" is answerable by eye.
const grid = new GridHelper(4, 16, 0x2c4e5d, 0x16292f);
scene.add(grid);

let spin = 0;
function frame(): void {
  spin += 0.004;
  const target = new Vector3(0, 1.72, 0);
  camera.position.set(Math.sin(spin) * 0.75, 1.78, Math.cos(spin) * 0.75);
  camera.lookAt(target);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

function show(mesh: MeshPayload, ms: number): void {
  const { geometry, bounds, orphanGroups } = buildGeometry(mesh, PIECE.materials);

  // One material per submaterial group. Flat greys for now: the LayerBlend
  // shader is what gives these their real surface, and standing it up here
  // would hide whether the *geometry* is right, which is what this page is for.
  const palette = ['#8a929a', '#5c646b', '#6d767e', '#9aa4ad', '#4e565d', '#b0b8c0'];
  const materials = Array.from({ length: PIECE.materials }, (_, i) =>
    new MeshStandardMaterial({
      color: new Color(palette[i % palette.length] ?? '#8a929a'),
      roughness: 0.55,
      metalness: 0.25,
    }));

  const object = new Mesh(geometry, materials);
  scene.add(object);

  const size = new Vector3();
  bounds.getSize(size);
  say(`\n${PIECE.name}`);
  say(`${(mesh.positions.length / 3).toLocaleString()} vertices, `
    + `${(mesh.indices.length / 3).toLocaleString()} triangles, ${ms.toFixed(0)}ms`);
  say(`${mesh.submeshes.filter((s) => s.count > 0).length} groups`
    + (orphanGroups ? `, ${orphanGroups} naming a submaterial the .mtl does not have` : ''));
  say(`sits at y ${bounds.min.y.toFixed(3)}–${bounds.max.y.toFixed(3)} `
    + `(${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} m)`);
  say(`${mesh.unweighted} unweighted vertices, ${mesh.bones.length} bones`);
  (window as unknown as { __render: unknown }).__render = {
    vertices: mesh.positions.length / 3,
    triangles: mesh.indices.length / 3,
    groups: geometry.groups.length,
    min: bounds.min.toArray(),
    max: bounds.max.toArray(),
    unweighted: mesh.unweighted,
  };
}

async function main(): Promise<void> {
  const head = await fetch('/__p4k', { method: 'HEAD' });
  const total = Number(head.headers.get('content-length') ?? 0);
  if (!total) {
    say('No archive is being served. Start the dev server with FW_ARCHIVE set.');
    return;
  }
  say(`archive ${(total / 1024 ** 3).toFixed(2)} GB`);

  const worker = new Worker(new URL('./src/worker/archive.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const message = event.data;
    if (message.type === 'progress') {
      status.textContent = `${lines.join('\n')}\n${message.step}…`;
    } else if (message.type === 'indexed') {
      say(`${message.entryCount.toLocaleString()} entries in ${(message.ms / 1000).toFixed(1)}s`);
      // The catalogue is not needed to draw one mesh, and skipping it is the
      // point: a piece costs an index plus two entry reads, not a full build.
      worker.postMessage({ type: 'mesh', path: PIECE.path } satisfies ToWorker);
    } else if (message.type === 'mesh') {
      show(message.mesh, message.ms);
    } else if (message.type === 'failed') {
      say(`failed: ${message.message}`);
    }
  };
  // No catalogue: drawing one piece needs an index and two entry reads, not a
  // 316 MB DataCore parse. Skipping it is what makes this page open in seconds.
  worker.postMessage({
    type: 'open-url', url: '/__p4k', byteLength: total, skeleton: 'male', catalogue: false,
  } satisfies ToWorker);
  frame();
}

void main().catch((error) => say(`threw: ${error instanceof Error ? error.message : String(error)}`));
