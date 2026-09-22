/** The kitbasher: the whole catalogue, equippable.
 *
 * Everything the port does, wired together. The catalogue is built from the
 * visitor's own `Data.p4k` -- every wearable piece across six slots -- and
 * clicking one loads its mesh, resolves its material and its own tint palette,
 * composites the surfaces with the LayerBlend shader, and binds it to the
 * shared armature.
 *
 * The verification pages next door each prove one thing and report numbers.
 * This one is for using.
 */

import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  GridHelper,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Scene,
  SkinnedMesh,
  Vector3,
  WebGLRenderer,
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

/** Hangarworks' real themes, with their tiers.
 *
 * **In the product this is not a picker.** The site's `ThemeProvider` resolves
 * the account's saved theme and its owned premium themes on sign-in, writes the
 * palette onto `<html>`, and FashionWorks follows. The buttons here stand in for
 * that, because this page has no account behind it -- which is also why the
 * premium ones are shown as locked rather than hidden: that is what a signed-out
 * or non-owning visitor sees.
 */
const THEMES = [
  { id: 'hangarworks', name: 'Hangarworks', tier: 'free' },
  { id: 'dark', name: 'Night', tier: 'free' },
  { id: 'dolomite', name: 'Dolomite', tier: 'free' },
  { id: 'nightrunner', name: 'Nightbreak', tier: 'free' },
  { id: 'keystone', name: 'Keystone', tier: 'free' },
  { id: 'navy', name: '2950 IAE', tier: 'premium' },
  { id: 'lovestruck', name: 'Lovestruck', tier: 'premium' },
] as const;
const SLOTS = ['helmet', 'torso', 'arms', 'legs', 'undersuit', 'backpack'] as const;
type Slot = (typeof SLOTS)[number];

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
 * armature of 255 with 35 attachment points, none missing and none extra. */
const DONORS = [
  'Objects/Characters/Human/male_v7/armor/cds/m_cds_undersuit_armor_02.skin',
  'Objects/Characters/Human/male_v7/armor/slaver/m_slaver_heavy_armor_01_core.skin',
];

/** Flags that keep a record out of the listing.
 *
 * Shop displays, the loot containers armour drops into and outright
 * placeholders all carry an armour attach type without being wearable.
 * `unnamed` is deliberately *not* here: that is a real piece whose localisation
 * key did not resolve, and it stays visible under its class name.
 */
const HIDDEN = ['npc', 'placeholder', 'not_wearable', 'test'];

/** How many rows to draw before asking for a search term.
 *
 * The listing is plain DOM, and a slot can hold hundreds of canonical pieces.
 * A virtual list would be the real answer; this is the honest placeholder.
 */
const MAX_ROWS = 400;

/** What a family of colourways is called.
 *
 * **Not the canonical member's name.** The canonical item is whichever the
 * catalogue happened to make the root, and it is often an *edition*: the
 * Defiance legs group is rooted on "Defiance Legs (Modified)", so titling the
 * row with it hides "Defiance Legs Sunchaser" as a swatch under a name it does
 * not share. Titling with the words the members actually have in common gives
 * "Defiance Legs", with every colourway including Sunchaser underneath.
 */
export function sharedName(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  const split = names.map((n) => n.split(/\s+/).filter(Boolean));
  const shared: string[] = [];
  for (let i = 0; i < split[0]!.length; i += 1) {
    const word = split[0]![i]!;
    if (split.every((words) => words[i] === word)) shared.push(word);
    else break;
  }
  // A family whose names diverge from the first word has nothing to share; the
  // canonical name is still better than an empty row.
  return shared.length ? shared.join(' ') : names[0]!;
}

/** What distinguishes one colourway from its family. */
export function colourwayName(name: string, shared: string): string {
  const rest = name.startsWith(shared) ? name.slice(shared.length).trim() : name;
  return rest || 'Standard';
}

interface CatalogueItem {
  id: string;
  class_name: string;
  name: string | null;
  slot: string;
  set: string | null;
  variant_of: string | null;
  bind_mode: string;
  socket: string | null;
  flags: string[];
  weight_class: string | null;
  manufacturer?: { code?: string | null; name?: string | null };
  tint?: { layers?: Array<{ color: string; spec: string; glossiness: number }> } | null;
  geometry: Array<{ source: string; side: string | null }>;
  materials: string[];
}

const statusEl = document.getElementById('status') as HTMLPreElement;
const viewEl = document.getElementById('view') as HTMLDivElement;
const itemsEl = document.getElementById('items') as HTMLDivElement;
const waysEl = document.getElementById('ways') as HTMLDivElement;
const slotsEl = document.getElementById('slots') as HTMLDivElement;
const searchEl = document.getElementById('search') as HTMLInputElement;

const lines: string[] = [];
const say = (line: string) => {
  lines.push(line);
  statusEl.textContent = lines.slice(-6).join('\n');
};
const replaceLast = (line: string) => {
  if (lines.length === 0) lines.push(line);
  else lines[lines.length - 1] = line;
  statusEl.textContent = lines.slice(-6).join('\n');
};

// ── scene ───────────────────────────────────────────────────────────────────
const scene = new Scene();
scene.background = new Color(0x000000);
// `alpha` so a backdrop photograph can show through where the scene is empty;
// `preserveDrawingBuffer` so the canvas can be read back after compositing,
// which is how a check confirms the scene followed a theme change.
const renderer = new WebGLRenderer({
  antialias: true, preserveDrawingBuffer: true, alpha: true,
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
viewEl.appendChild(renderer.domElement);

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
const keyLight = new DirectionalLight(0xffffff, 2.2);
keyLight.position.set(1.2, 2.0, 1.6);
scene.add(keyLight);
const rimLight = new DirectionalLight(0xffffff, 0.6);
rimLight.position.set(-1.6, 1.0, -1.4);
scene.add(rimLight);
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
(function frame() {
  requestAnimationFrame(frame);
  controls.update();
  renderer.render(scene, camera);
})();

// ── theme ───────────────────────────────────────────────────────────────────
function paint(tokens: Tokens): void {
  // With a backdrop up there is no scene background to tint; the grid is
  // hidden too, so only the lighting balance still applies.
  applyTheme({ scene, renderer, grid: grid.visible ? grid : undefined }, tokens);
  ambient.intensity = isLight(tokens) ? 0.85 : 1.3;
}
paint(readTokens());
watchTheme(paint);

const themeBar = document.getElementById('themes')!;
for (const entry of THEMES) {
  const button = document.createElement('button');
  button.dataset.theme = entry.id;
  button.textContent = entry.tier === 'premium' ? `${entry.name} \u2022` : entry.name;
  button.title = entry.tier === 'premium'
    ? `${entry.name} — premium; the account has to own it`
    : entry.name;
  button.onclick = () => document.documentElement.setAttribute('data-theme', entry.id);
  themeBar.appendChild(button);
}
const syncThemes = () => {
  const current = document.documentElement.getAttribute('data-theme');
  themeBar.querySelectorAll('button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.theme === current));
  });
};
syncThemes();
new MutationObserver(syncThemes).observe(document.documentElement, {
  attributes: true, attributeFilter: ['data-theme'],
});

// ── the worker ──────────────────────────────────────────────────────────────
function rpc(worker: Worker) {
  const waiting = new Map<string, Array<(value: FromWorker) => void>>();
  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const message = event.data;
    if (message.type === 'progress') return replaceLast(`${message.step}…`);
    if (message.type === 'failed') return say(`failed: ${message.message}`);
    waiting.get(message.type)?.shift()?.(message);
  };
  /** Wait for a message the worker sends unprompted -- the catalogue arrives
   * as part of opening the archive, not in answer to a request. */
  const waitFor = <T extends FromWorker['type']>(expect: T) =>
    new Promise<Extract<FromWorker, { type: T }>>((resolve) => {
      const queue = waiting.get(expect) ?? [];
      queue.push(resolve as (value: FromWorker) => void);
      waiting.set(expect, queue);
    });
  const ask = <T extends FromWorker['type']>(request: ToWorker, expect: T) => {
    const answer = waitFor(expect);
    worker.postMessage(request);
    return answer;
  };
  return { ask, waitFor };
}

/** A tint palette from the catalogue.
 *
 * **The specular matters and is not the colour.** A metal has no diffuse
 * albedo -- its appearance *is* its F0 -- so a metal layer takes the entry's
 * specular. The Sunchaser's entryA is gold `#f9b541` against a specular of
 * `#b1b0ad`, and using the colour for both is how ten Lynx colourways once
 * rendered as the same grey arm.
 */
function paletteOf(item: CatalogueItem): PaletteEntry[] {
  const hex = (value: string): [number, number, number] =>
    [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255) as [number, number, number];
  return (item.tint?.layers ?? []).slice(0, 3).map((layer) => ({
    color: hex(layer.color),
    spec: hex(layer.spec),
    // The palette stores glossiness 0-255 and armour entries are routinely the
    // full 255, which taken literally is a mirror.
    glossiness: Math.min(1, Math.max(0.05, layer.glossiness)),
  }));
}

let rig: BuiltRig | undefined;
let wear = true;
const equipped = new Map<Slot, Object3D[]>();
const wearing = new Map<Slot, CatalogueItem>();
/** Loaded pieces, so re-equipping is instant. Keyed by item *and* wear,
 * because the two surfaces are genuinely different bakes. */
const cache = new Map<string, Object3D[]>();

async function main(): Promise<void> {
  const head = await fetch('/__p4k', { method: 'HEAD' });
  const total = Number(head.headers.get('content-length') ?? 0);
  if (!total) {
    say('No archive is being served.');
    say('Restart the dev server with FW_ARCHIVE set to your Data.p4k.');
    itemsEl.textContent = 'no archive';
    return;
  }
  say(`archive ${(total / 1024 ** 3).toFixed(2)} GB`);
  say('reading…');

  const worker = new Worker(new URL('./src/worker/archive.worker.ts', import.meta.url), {
    type: 'module',
  });
  const { ask, waitFor } = rpc(worker);

  // The catalogue arrives on its own once the archive is open, so its waiter is
  // registered before the open rather than in answer to it.
  const catalogueSoon = waitFor('catalogue');
  const indexed = await ask({
    type: 'open-url', url: '/__p4k', byteLength: total, skeleton: 'male', catalogue: true,
  }, 'indexed');
  replaceLast(`${indexed.entryCount.toLocaleString()} entries in ${(indexed.ms / 1000).toFixed(1)}s`);

  const catalogue = await catalogueSoon;
  const all = (JSON.parse(catalogue.json) as { items: CatalogueItem[] }).items
    .filter((item) => item.geometry.length > 0 && !item.flags.some((f) => HIDDEN.includes(f)));
  say(`${all.length.toLocaleString()} wearable pieces`);

  const rigMessage = await ask({ type: 'rig', base: BASE_SKELETON, donors: DONORS }, 'rig');
  rig = buildRig(rigMessage.bones);
  scene.add(rig.root);

  const fetchTexture = async (path: string, maxSize: number): Promise<TexturePayload | null> =>
    (await ask({ type: 'texture', path, maxSize }, 'texture')).texture;

  async function load(item: CatalogueItem): Promise<Object3D[]> {
    const key = `${item.id}:${wear}`;
    const hit = cache.get(key);
    if (hit) return hit;

    const mtl = item.materials[0];
    const material = mtl
      ? ((await ask({ type: 'material', path: mtl }, 'material')).material as MaterialPayload)
      : ({ submaterials: [], library: {} } as MaterialPayload);
    const composited = await compositeSurfaces(material, paletteOf(item), fetchTexture, wear);
    const count = Math.max(1, material.submaterials.length);
    const materials = material.submaterials.length
      ? material.submaterials.map((sub) => materialFor(sub.name, composited))
      : [materialFor('', composited)];

    const objects: Object3D[] = [];
    // A piece can be several meshes: arms ship a left and a right.
    for (const geometry of item.geometry) {
      if (item.bind_mode === 'socket') {
        const socket = item.socket ?? 'backpack_attach_1_override';
        const prop = (await ask(
          { type: 'prop', path: geometry.source, socket }, 'prop',
        )).prop as PropPayload;
        const object = new Mesh(buildGeometry(prop, count).geometry, materials);
        object.frustumCulled = false;
        if (prop.mount) {
          object.matrixAutoUpdate = false;
          object.matrix.copy(mountMatrix(prop.mount));
        }
        objects.push(object);
      } else {
        const mesh = (await ask({ type: 'mesh', path: geometry.source }, 'mesh')).mesh as MeshPayload;
        const object = new SkinnedMesh(buildGeometry(mesh, count).geometry, materials);
        object.frustumCulled = false;
        objects.push(object);
      }
    }
    cache.set(key, objects);
    return objects;
  }

  async function equip(item: CatalogueItem): Promise<void> {
    const slot = item.slot as Slot;
    say(`${item.name ?? item.class_name}…`);
    let objects: Object3D[];
    try {
      objects = await load(item);
    } catch (error) {
      replaceLast(`${item.name ?? item.class_name}: ${
        error instanceof Error ? error.message : String(error)}`);
      return;
    }

    // The old piece comes out first, so a slot never holds two.
    for (const previous of equipped.get(slot) ?? []) previous.removeFromParent();

    for (const object of objects) {
      if (object instanceof SkinnedMesh) {
        scene.add(object);
        object.bind(rig!.skeleton, object.matrixWorld);
      } else {
        const bone = rig!.byName.get(item.socket ?? 'backpack_attach_1_override');
        (bone ?? scene).add(object);
      }
    }
    equipped.set(slot, objects);
    wearing.set(slot, item);

    const triangles = objects.reduce(
      (sum, o) => sum + ((o as Mesh).geometry?.getIndex()?.count ?? 0) / 3, 0,
    );
    replaceLast(`${item.name ?? item.class_name}  ${triangles.toLocaleString()} triangles`);
    frameLoadout();
    renderList();
  }

  function frameLoadout(): void {
    const bounds = new Box3();
    let any = false;
    for (const objects of equipped.values()) {
      for (const object of objects) {
        bounds.expandByObject(object);
        any = true;
      }
    }
    if (!any) return;
    const centre = bounds.getCenter(new Vector3());
    const size = bounds.getSize(new Vector3());
    const reach = Math.max(size.x, size.y, size.z, 0.4);
    const distance = (reach / 2) / Math.tan((camera.fov * Math.PI) / 360) * 1.6;
    controls.target.copy(centre);
    // Negative z is the character's front: the archive is Z-up with +y forward,
    // and the conversion puts the visor at -z.
    camera.position.set(centre.x + distance * 0.5, centre.y + distance * 0.18, centre.z - distance);
  }

  // ── the listing ───────────────────────────────────────────────────────────
  let slot: Slot = 'torso';
  const bySlot = new Map<Slot, CatalogueItem[]>(
    SLOTS.map((name) => [name, all.filter((item) => item.slot === name)]),
  );
  const familyRoot = (item: CatalogueItem) => item.variant_of ?? item.id;
  const families = new Map<string, CatalogueItem[]>();
  for (const item of all) {
    const root = familyRoot(item);
    families.set(root, [...(families.get(root) ?? []), item]);
  }

  for (const name of SLOTS) {
    const button = document.createElement('button');
    button.dataset.slot = name;
    button.textContent = `${name} ${bySlot.get(name)!.length}`;
    button.onclick = () => { slot = name; renderList(); };
    slotsEl.appendChild(button);
  }
  searchEl.placeholder = `Search ${all.length.toLocaleString()} pieces…`;
  searchEl.oninput = () => renderList();

  function renderList(): void {
    slotsEl.querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.slot === slot));
    });

    const needle = searchEl.value.trim().toLowerCase();
    // Canonical pieces only: a family's colourways appear as swatches below,
    // rather than as twenty near-identical rows.
    const pool = (bySlot.get(slot) ?? []).filter((item) => {
      if (item.variant_of) return false;
      if (!needle) return true;
      return `${item.name ?? ''} ${item.class_name}`.toLowerCase().includes(needle);
    });

    itemsEl.textContent = '';
    if (pool.length === 0) {
      itemsEl.textContent = needle ? 'nothing matches' : 'nothing in this slot';
      return;
    }
    const onBody = wearing.get(slot);
    for (const item of pool.slice(0, MAX_ROWS)) {
      const family = families.get(familyRoot(item)) ?? [item];
      const button = document.createElement('button');
      button.className = 'item';
      const title = document.createElement('span');
      const names = family.map((f) => f.name ?? f.class_name);
      title.textContent = sharedName(names);
      const meta = document.createElement('span');
      meta.className = 'meta';
      const maker = item.manufacturer?.code ?? '';
      const parts = [maker, item.weight_class ?? '', family.length > 1 ? `${family.length} colourways` : '']
        .filter(Boolean);
      meta.textContent = parts.join(' · ');
      button.append(title, meta);
      button.setAttribute(
        'aria-pressed',
        String(Boolean(onBody && familyRoot(onBody) === familyRoot(item))),
      );
      button.onclick = () => { void equip(item); renderWays(item); };
      itemsEl.appendChild(button);
    }
    if (pool.length > MAX_ROWS) {
      const note = document.createElement('div');
      note.className = 'meta';
      note.style.padding = '6px 8px';
      note.textContent = `…and ${pool.length - MAX_ROWS} more; search to narrow`;
      itemsEl.appendChild(note);
    }
    if (onBody) renderWays(onBody);
  }

  function renderWays(item: CatalogueItem): void {
    const family = families.get(familyRoot(item)) ?? [];
    waysEl.textContent = '';
    if (family.length <= 1) return;
    const onBody = wearing.get(item.slot as Slot);
    for (const variant of family) {
      const swatch = document.createElement('button');
      swatch.className = 'way';
      const colour = variant.tint?.layers?.[0]?.color;
      if (colour) swatch.style.background = colour;
      const shared = sharedName(family.map((f) => f.name ?? f.class_name));
      swatch.title = colourwayName(variant.name ?? variant.class_name, shared);
      swatch.setAttribute('aria-pressed', String(onBody?.id === variant.id));
      swatch.onclick = () => void equip(variant);
      waysEl.appendChild(swatch);
    }
  }

  renderList();

  // ── poses ─────────────────────────────────────────────────────────────────
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
      for (const bone of rig.bones) bone.quaternion.copy(restRotations.get(bone.name)!);
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

  // ── wear and clear ────────────────────────────────────────────────────────
  const optionBar = document.getElementById('opts')!;
  const wearButton = document.createElement('button');
  wearButton.textContent = 'worn';
  wearButton.setAttribute('aria-pressed', 'true');
  wearButton.onclick = async () => {
    wear = !wear;
    wearButton.textContent = wear ? 'worn' : 'factory';
    wearButton.setAttribute('aria-pressed', String(wear));
    wearButton.disabled = true;
    say(`recompositing ${wear ? 'worn' : 'as it left the factory'}…`);
    for (const item of [...wearing.values()]) await equip(item);
    replaceLast(wear ? 'worn' : 'as it left the factory');
    wearButton.disabled = false;
  };
  optionBar.appendChild(wearButton);

  const actions = document.getElementById('acts')!;

  /** Equip a whole set around whatever is already on the torso.
   *
   * **Set first, then edition, then palette.** Scoring palette above the
   * product line is how equipping from "Defiance Core (Modified)" once put
   * *ADP Arms (Modified)* on the arms -- a different product line that happened
   * to share a colour. One set key can cover nearly two hundred items across
   * many lines, and the pieces of one edition do not necessarily share a
   * palette among themselves, so neither alone is enough.
   */
  const setButton = document.createElement('button');
  setButton.textContent = 'equip set';
  setButton.title = 'Fill the empty slots to match the piece on the torso';
  setButton.onclick = async () => {
    const anchor = wearing.get('torso') ?? [...wearing.values()][0];
    if (!anchor) return say('equip something first, then match a set to it');
    setButton.disabled = true;

    const anchorName = anchor.name ?? anchor.class_name;
    const anchorFamily = families.get(familyRoot(anchor)) ?? [anchor];
    const anchorShared = sharedName(anchorFamily.map((f) => f.name ?? f.class_name));
    // The words after the slot -- "(Modified)", "Tactical" -- are the edition.
    const edition = colourwayName(anchorName, anchorShared);
    const paletteKey = anchor.tint?.layers?.[0]?.color ?? '';

    const score = (item: CatalogueItem): number => {
      let points = 0;
      if (anchor.set && item.set === anchor.set) points += 8;
      const itemFamily = families.get(familyRoot(item)) ?? [item];
      const itemShared = sharedName(itemFamily.map((f) => f.name ?? f.class_name));
      // The manufacturer and the leading word of the name stand in for the
      // product line, which the catalogue does not name directly.
      if (item.manufacturer?.code && item.manufacturer.code === anchor.manufacturer?.code) points += 3;
      if (itemShared.split(' ')[0] === anchorShared.split(' ')[0]) points += 4;
      if (colourwayName(item.name ?? item.class_name, itemShared) === edition) points += 3;
      if (paletteKey && item.tint?.layers?.[0]?.color === paletteKey) points += 2;
      if (item.weight_class === anchor.weight_class) points += 1;
      return points;
    };

    let filled = 0;
    for (const name of SLOTS) {
      if (wearing.has(name)) continue;
      const candidates = (bySlot.get(name) ?? [])
        .map((item) => ({ item, points: score(item) }))
        .filter((entry) => entry.points >= 8)
        .sort((a, b) => b.points - a.points);
      const best = candidates[0];
      if (!best) continue;
      await equip(best.item);
      filled += 1;
    }
    setButton.disabled = false;
    say(filled ? `set: filled ${filled} slot${filled === 1 ? '' : 's'}`
      : 'no matching pieces for the empty slots');
  };
  actions.appendChild(setButton);
  const clear = document.createElement('button');
  clear.textContent = 'clear';
  clear.onclick = () => {
    for (const objects of equipped.values()) for (const o of objects) o.removeFromParent();
    equipped.clear();
    wearing.clear();
    waysEl.textContent = '';
    renderList();
    say('cleared');
  };
  actions.appendChild(clear);

  // ── backdrop ──────────────────────────────────────────────────────────────
  //
  // A photograph behind the character, cropped to cover rather than stretched.
  // **Lighting still comes from the scene**: a screenshot is a perspective
  // image, not an equirectangular map, so using one to light the armour would
  // be wrong. The grid goes away while a backdrop is up, because it reads as
  // floating debris over a photo.
  const backdropBar = document.getElementById('backdrop')!;
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/*';
  picker.hidden = true;
  let backdropUrl: string | null = null;

  const setBackdrop = (url: string | null) => {
    if (backdropUrl) URL.revokeObjectURL(backdropUrl);
    backdropUrl = url;
    if (url) {
      viewEl.style.backgroundImage = `url(${url})`;
      viewEl.classList.add('has-backdrop');
      // The canvas has to stop painting the theme colour over the photo.
      scene.background = null;
      renderer.setClearAlpha(0);
      grid.visible = false;
    } else {
      viewEl.style.backgroundImage = '';
      viewEl.classList.remove('has-backdrop');
      scene.background = new Color(0x000000);
      renderer.setClearAlpha(1);
      grid.visible = true;
      paint(readTokens());
    }
    clearBackdrop.disabled = !url;
  };

  picker.onchange = () => {
    const file = picker.files?.[0];
    if (file) {
      setBackdrop(URL.createObjectURL(file));
      say(`backdrop: ${file.name}`);
    }
  };

  const chooseBackdrop = document.createElement('button');
  chooseBackdrop.textContent = 'choose…';
  chooseBackdrop.onclick = () => picker.click();
  const clearBackdrop = document.createElement('button');
  clearBackdrop.textContent = 'none';
  clearBackdrop.disabled = true;
  clearBackdrop.onclick = () => { setBackdrop(null); say('backdrop cleared'); };
  backdropBar.append(chooseBackdrop, clearBackdrop, picker);

  // A backdrop is the visitor's own file and never leaves the page; the object
  // URL is released when it is replaced or cleared.
  addEventListener('beforeunload', () => { if (backdropUrl) URL.revokeObjectURL(backdropUrl); });

  // Open on something rather than an empty grid.
  const opener = (bySlot.get('torso') ?? []).find((i) => (i.name ?? '').includes('Sunchaser'))
    ?? (bySlot.get('torso') ?? []).find((i) => !i.variant_of);
  if (opener) await equip(opener);
  await setPose(POSES[1]!);
  say('ready — pick a piece on the left');

  (window as unknown as { __try: unknown }).__try = { all, bySlot, families, equipped, wearing, equip };
}

void main().catch((error) => {
  say(`threw: ${error instanceof Error ? error.message : String(error)}`);
});
