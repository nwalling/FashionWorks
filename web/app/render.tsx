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
  Color,
  DirectionalLight,
  GridHelper,
  PerspectiveCamera,
  Scene,
  SkeletonHelper,
  SkinnedMesh,
  Vector3,
  WebGLRenderer,
} from 'three';

import { buildGeometry } from './src/three/geometry';
import { buildRig, type BuiltRig } from './src/three/rig';
import { compositeSurfaces, materialFor, type Composited, type PaletteEntry } from './src/three/surface';
import type {
  FromWorker, MaterialPayload, MeshPayload, RigBone, TexturePayload, ToWorker,
} from './src/worker/archive.worker';

/** The piece to show. Sunchaser because it is the set every other measurement
 * in this repo is anchored to. */
/** The pieces to show, and the point of showing more than one: they must end
 * up on **the same skeleton**, so posing a bone deforms all of them together.
 * The local pipeline's own measurement is one `THREE.Skeleton` across ten
 * skinned meshes for a full set.
 */
const PIECES = [
  {
    name: 'Defiance Helmet Sunchaser',
    path: 'Objects/Characters/Human/male_v7/armor/slaver/m_slaver_heavy_armor_helmet_01.skin',
    mtl: 'Objects/Characters/Human/male_v7/armor/slaver/m_slaver_heavy_armor_helmet_01_01_01.mtl',
    /** The `.mtl` declares six submaterials; the mesh declares seven groups. */
    materials: 6,
  },
  {
    name: 'Defiance Core Sunchaser',
    path: 'Objects/Characters/Human/male_v7/armor/slaver/m_slaver_heavy_armor_01_core.skin',
    mtl: 'Objects/Characters/Human/male_v7/armor/slaver/m_slaver_heavy_armor_core_01_01_01.mtl',
    materials: 8,
  },
];

/** The Sunchaser palette, `slaver_heavy_01_01_03`.
 *
 * Taken from the catalogue in the real flow; pinned here so this page stays a
 * test of *rendering* rather than of palette resolution, which phase 1 already
 * covers at 100%. entryA is the gold every measurement in this repo is
 * anchored to.
 */
const PALETTE: PaletteEntry[] = [
  { color: hex('#f9b541'), spec: hex('#f9b541'), glossiness: 0.62 },
  { color: hex('#5e5e5c'), spec: hex('#5e5e5c'), glossiness: 0.55 },
  { color: hex('#575757'), spec: hex('#575757'), glossiness: 0.55 },
];

function hex(value: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255) as [number, number, number];
}

const BASE_SKELETON = 'Objects/Characters/Human/male_v7/export/bhm_skeleton_v7.chr';

/** Donors for the attachment points the base skeleton does not have.
 *
 * These two exactly: an undersuit contributes 34 and the slaver core the one
 * more -- `gadget_attach_1_override` -- that reaches the pipeline's canonical
 * armature of 255 bones and 35 attachment points, with no bone missing and
 * none extra. Checked by `cargo run --example rig_union`.
 *
 * Adding donors *extends* it. The Sunchaser helmet, for instance, brings three
 * `helm_*_flashlight_override` points the pipeline's armature does not have,
 * because that one grafts from a single undersuit. A superset is safe here --
 * the viewer binds by name, never by index -- but it is not the same rig, so
 * the list is fixed rather than accumulated.
 */
const DONORS = [
  'Objects/Characters/Human/male_v7/armor/cds/m_cds_undersuit_armor_02.skin',
  'Objects/Characters/Human/male_v7/armor/slaver/m_slaver_heavy_armor_01_core.skin',
];

const bound: SkinnedMesh[] = [];
let pending = 0;

let rig: BuiltRig | undefined;

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
  const target = new Vector3(0, 1.35, 0);
  camera.position.set(Math.sin(spin) * 1.9, 1.5, Math.cos(spin) * 1.9);
  camera.lookAt(target);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

function showRig(bones: readonly RigBone[], summary: { bones: number; base: number; grafted: number; attachments: number }): void {
  rig = buildRig(bones);
  scene.add(rig.root);
  const helper = new SkeletonHelper(rig.root);
  (helper.material as { opacity: number; transparent: boolean }).opacity = 0.35;
  (helper.material as { transparent: boolean }).transparent = true;
  scene.add(helper);
  say(`rig ${summary.bones} bones = ${summary.base} base + ${summary.grafted} grafted`);
  say(`${summary.attachments} attachment points`);
}

function show(
  mesh: MeshPayload,
  ms: number,
  piece: (typeof PIECES)[number],
  material: MaterialPayload,
  composited: Composited,
): void {
  const { geometry, bounds, orphanGroups } = buildGeometry(mesh, piece.materials);

  // One material per submaterial, in the .mtl's own order -- which is what the
  // mesh's numeric group ids index. Matching by position is only safe because
  // the ids *are* positions in that list; anywhere a name is available it is
  // the real key, and reusing one whole-body .mtl across meshes is normal here.
  const materials = material.submaterials.map((sub) =>
    materialFor(sub.name, composited));

  // A SkinnedMesh must be parented into the same space as the bones, and bound
  // *after* both are in the scene: `bind` reads the bones' world matrices.
  const object = new SkinnedMesh(geometry, materials);
  object.frustumCulled = false;
  if (rig) {
    scene.add(object);
    object.bind(rig.skeleton, object.matrixWorld);
  } else {
    scene.add(object);
  }
  bound.push(object);

  const size = new Vector3();
  bounds.getSize(size);
  say(`\n${piece.name}`);
  say(`${(mesh.positions.length / 3).toLocaleString()} vertices, `
    + `${(mesh.indices.length / 3).toLocaleString()} triangles, ${ms.toFixed(0)}ms`);
  say(`${mesh.submeshes.filter((s) => s.count > 0).length} groups`
    + (orphanGroups ? `, ${orphanGroups} naming a submaterial the .mtl does not have` : ''));
  say(`sits at y ${bounds.min.y.toFixed(3)}–${bounds.max.y.toFixed(3)} `
    + `(${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} m)`);
  say(`${mesh.unweighted} unweighted vertices, ${mesh.bones.length} bones`);
  say(`${composited.surfaces.size} surfaces composited in ${composited.ms.toFixed(0)}ms`
    + (composited.skipped.length ? `, ${composited.skipped.length} not LayerBlend` : '')
    + `, ${composited.layerSlices} layer textures`);
  if (mesh.rebind) {
    say(`rebind: ${mesh.rebind.mapped} joints mapped, ${mesh.rebind.stray} stray, `
      + `${mesh.rebind.redistributed} vertices redistributed, ${mesh.rebind.guessed} guessed`);
  }
  // A pose probe, so "is it actually skinned" is answerable rather than
  // assumed: a mesh bound to a skeleton it ignores looks identical until
  // something moves.
  (window as unknown as { __pose: unknown }).__pose = (boneName: string, radians: number) => {
    const bone = rig?.byName.get(boneName);
    if (!bone || !rig) return null;
    const before = object.geometry.attributes.position!.count;
    const sample = new Vector3().fromBufferAttribute(
      object.geometry.attributes.position as never, 0);
    bone.rotation.z += radians;
    rig.root.updateMatrixWorld(true);
    rig.skeleton.update();
    // Where vertex 0 ends up once the skeleton has moved, computed the way the
    // shader does it.
    const after = new Vector3();
    object.applyBoneTransform(0, after);
    return { vertices: before, rest: sample.toArray(), posed: after.toArray() };
  };

  // The scene objects, so a probe can look at the real state rather than at
  // whatever the page chose to summarise.
  (window as unknown as { __scene: unknown }).__scene = { scene, object, bound, rig, camera, renderer };

  (window as unknown as { __render: unknown }).__render = {
    vertices: mesh.positions.length / 3,
    triangles: mesh.indices.length / 3,
    groups: geometry.groups.length,
    min: bounds.min.toArray(),
    max: bounds.max.toArray(),
    unweighted: mesh.unweighted,
    rebind: mesh.rebind,
    rigBones: rig?.bones.length ?? 0,
    surfaces: composited.surfaces.size,
    skipped: composited.skipped,
  };
}

/** One outstanding request per message kind.
 *
 * The worker handles messages in order and answers each with a message of a
 * matching kind, so a queue per kind is enough to turn it into something
 * awaitable -- and keeps the page readable as a sequence rather than as a
 * callback tree.
 */
function rpc(worker: Worker) {
  const waiting = new Map<string, Array<(value: FromWorker) => void>>();
  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const message = event.data;
    if (message.type === 'progress') {
      status.textContent = `${lines.join('\n')}\n${message.step}…`;
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

async function main(): Promise<void> {
  const head = await fetch('/__p4k', { method: 'HEAD' });
  const total = Number(head.headers.get('content-length') ?? 0);
  if (!total) {
    say('No archive is being served. Start the dev server with FW_ARCHIVE set.');
    return;
  }
  say(`archive ${(total / 1024 ** 3).toFixed(2)} GB`);
  frame();

  const worker = new Worker(new URL('./src/worker/archive.worker.ts', import.meta.url), {
    type: 'module',
  });
  const ask = rpc(worker);

  // No catalogue: drawing a piece needs an index and a handful of entry reads,
  // not a 316 MB DataCore parse.
  const indexed = await ask({
    type: 'open-url', url: '/__p4k', byteLength: total, skeleton: 'male', catalogue: false,
  }, 'indexed');
  say(`${indexed.entryCount.toLocaleString()} entries in ${(indexed.ms / 1000).toFixed(1)}s`);

  // The rig first: a mesh loaded before it exists comes back with its own joint
  // indices, which address a bone list the scene does not have.
  const rigMessage = await ask({ type: 'rig', base: BASE_SKELETON, donors: DONORS }, 'rig');
  showRig(rigMessage.bones, rigMessage.summary);

  let textureReads = 0;
  let textureMs = 0;
  const fetchTexture = async (path: string, maxSize: number): Promise<TexturePayload | null> => {
    const before = textureReads;
    const answer = await ask({ type: 'texture', path, maxSize }, 'texture');
    textureReads = answer.reads;
    textureMs += answer.ms;
    void before;
    return answer.texture;
  };

  for (const piece of PIECES) {
    const mesh = await ask({ type: 'mesh', path: piece.path }, 'mesh');
    const material = await ask({ type: 'material', path: piece.mtl }, 'material');
    (window as unknown as { __material: unknown }).__material = material.material;
    const composited = await compositeSurfaces(material.material, PALETTE, fetchTexture);
    // Keep the raw composites so they can be compared with the pipeline's
    // baked PNGs directly -- the shader against the reference, with no
    // lighting in between.
    const store = (window as unknown as { __composites: Record<string, unknown> });
    store.__composites = store.__composites ?? {};
    store.__composites[piece.name] = composited;
    show(mesh.mesh, mesh.ms, piece, material.material, composited);
  }

  say(`\n${textureReads.toLocaleString()} range reads total, `
    + `${(textureMs / 1000).toFixed(1)}s of it decoding textures`);
  const skeletons = new Set(bound.map((m) => m.skeleton));
  say(`\n${bound.length} pieces, ${skeletons.size} skeleton${skeletons.size === 1 ? '' : 's'}`);
}

void main().catch((error) => say(`threw: ${error instanceof Error ? error.message : String(error)}`));
