/** The kitbasher: what `try.tsx` did, as something the component can own.
 *
 * Everything that makes armour appear -- the archive worker, the canonical
 * armature, the LayerBlend composite, socket mounting, pose retargeting --
 * already existed and was verified. It lived in a development page, and the
 * published component rendered an empty themed viewport at `ready`. This is the
 * same orchestration with the DOM taken out, so a React shell can drive it and
 * so it can be exercised from the built package rather than from source.
 *
 * It owns nothing visual beyond the objects it adds to the scene it is given.
 * Colours, lights and the grid belong to `Viewer`; the state the UI renders
 * from is published through `subscribe`.
 */

import {
  Box3,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SkinnedMesh,
  Vector3,
} from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import type { ArchiveClient } from '../archive/client';
import {
  colourwayName,
  displayName,
  familyRoot,
  sharedName,
  SLOTS,
  type Catalogue,
  type CatalogueItem,
  type Slot,
} from '../archive/catalogue';
import type { MaterialPayload, MeshPayload, PropPayload } from '../worker/archive.worker';
import { buildGeometry } from './geometry';
import { applyClip, buildRig, mountMatrix, type BuiltRig } from './rig';
import { compositeSurfaces, materialFor, type PaletteEntry } from './surface';

export const BASE_SKELETON = 'Objects/Characters/Human/male_v7/export/bhm_skeleton_v7.chr';

/** Two donors exactly: 220 base bones + 34 + 1 reaches the pipeline's canonical
 * armature of 255 with 35 attachment points, none missing and none extra. */
export const DONORS = [
  'Objects/Characters/Human/male_v7/armor/cds/m_cds_undersuit_armor_02.skin',
  'Objects/Characters/Human/male_v7/armor/slaver/m_slaver_heavy_armor_01_core.skin',
];

/** How much room to leave around a framed loadout. Enough that a pauldron or a
 * backpack does not touch the edge, not so much that the figure swims. */
const FRAME_MARGIN = 1.12;

/** Never get closer than this, whatever the bounds say. A single glove would
 * otherwise put the camera inside its own near plane. */
const MIN_FRAME_DISTANCE = 0.6;

export interface Pose {
  readonly label: string;
  readonly dba: string | null;
  readonly clip: string | null;
}

export const POSES: readonly Pose[] = [
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
];

/** What the kitbasher needs from the view. `Viewer` builds and themes it. */
export interface KitbasherScene {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
}

/** What the UI renders from. Replaced wholesale on every change, so React can
 * compare by identity. */
export interface KitbasherState {
  readonly wearing: ReadonlyMap<Slot, CatalogueItem>;
  readonly pose: string;
  readonly wear: boolean;
  /** One line about what just happened, for a status strip. */
  readonly status: string;
  readonly busy: boolean;
  readonly rigBones: number;
}

/** A tint palette from the catalogue.
 *
 * **The specular matters and is not the colour.** A metal has no diffuse
 * albedo -- its appearance *is* its F0 -- so a metal layer takes the entry's
 * specular. The Sunchaser's entryA is gold `#f9b541` against a specular of
 * `#b1b0ad`, and using the colour for both is how ten Lynx colourways once
 * rendered as the same grey arm.
 */
export function paletteOf(item: CatalogueItem): PaletteEntry[] {
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

/** Encode a loadout for the URL fragment: the ids, nothing else.
 *
 * Slot is a property of the item, wear and pose are a visitor's momentary
 * preference rather than the thing being shared, and the ids are already
 * stable across game builds because they are the DataCore's own. Six GUIDs
 * come to about 220 characters, which is fine for a fragment.
 */
export function encodeLoadout(wearing: ReadonlyMap<Slot, CatalogueItem>): string {
  return SLOTS.filter((s) => wearing.has(s)).map((s) => wearing.get(s)!.id).join(',');
}

export function decodeLoadout(encoded: string, catalogue: Catalogue): CatalogueItem[] {
  if (!encoded) return [];
  const byId = new Map(catalogue.items.map((i) => [i.id, i]));
  return encoded
    .split(',')
    .map((id) => byId.get(id.trim()))
    .filter((item): item is CatalogueItem => Boolean(item));
}

/** Equip a whole set around an anchor piece: which item, per empty slot.
 *
 * **Set first, then edition, then palette.** Scoring palette above the product
 * line is how equipping from "Defiance Core (Modified)" once put *ADP Arms
 * (Modified)* on the arms -- a different product line that happened to share a
 * colour. One set key can cover nearly two hundred items across many lines,
 * and the pieces of one edition do not necessarily share a palette among
 * themselves, so neither alone is enough.
 */
export function matchSet(
  anchor: CatalogueItem,
  catalogue: Catalogue,
  wearing: ReadonlyMap<Slot, CatalogueItem>,
): CatalogueItem[] {
  const familyName = (item: CatalogueItem) =>
    sharedName((catalogue.families.get(familyRoot(item)) ?? [item]).map(displayName));
  const anchorShared = familyName(anchor);
  // The words after the slot -- "(Modified)", "Tactical" -- are the edition.
  const edition = colourwayName(displayName(anchor), anchorShared);
  const paletteKey = anchor.tint?.layers?.[0]?.color ?? '';

  const score = (item: CatalogueItem): number => {
    let points = 0;
    if (anchor.set && item.set === anchor.set) points += 8;
    const itemShared = familyName(item);
    // The manufacturer and the leading word of the name stand in for the
    // product line, which the catalogue does not name directly.
    if (item.manufacturer?.code && item.manufacturer.code === anchor.manufacturer?.code) points += 3;
    if (itemShared.split(' ')[0] === anchorShared.split(' ')[0]) points += 4;
    if (colourwayName(displayName(item), itemShared) === edition) points += 3;
    if (paletteKey && item.tint?.layers?.[0]?.color === paletteKey) points += 2;
    if (item.weight_class === anchor.weight_class) points += 1;
    return points;
  };

  const picks: CatalogueItem[] = [];
  for (const slot of SLOTS) {
    if (wearing.has(slot)) continue;
    const best = (catalogue.bySlot.get(slot) ?? [])
      .map((item) => ({ item, points: score(item) }))
      .filter((entry) => entry.points >= 8)
      .sort((a, b) => b.points - a.points)[0];
    if (best) picks.push(best.item);
  }
  return picks;
}

export class Kitbasher {
  private rig: BuiltRig | null = null;

  private restRotations = new Map<string, Quaternion>();

  private readonly equipped = new Map<Slot, Object3D[]>();

  private readonly wearing = new Map<Slot, CatalogueItem>();

  /** Loaded pieces, so re-equipping is instant. Keyed by item *and* wear,
   * because the two surfaces are genuinely different bakes. */
  private readonly cache = new Map<string, Object3D[]>();

  private state: KitbasherState = {
    wearing: new Map(),
    pose: 'rest',
    wear: true,
    status: '',
    busy: false,
    rigBones: 0,
  };

  private readonly listeners = new Set<(state: KitbasherState) => void>();

  private disposed = false;

  constructor(
    private readonly client: ArchiveClient,
    readonly catalogue: Catalogue,
    private readonly view: KitbasherScene,
  ) {}

  subscribe(listener: (state: KitbasherState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  get current(): KitbasherState {
    return this.state;
  }

  private publish(patch: Partial<KitbasherState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch, wearing: new Map(this.wearing) };
    for (const listener of this.listeners) listener(this.state);
  }

  /** Build the canonical armature and stand it in the scene. Once. */
  async init(): Promise<void> {
    if (this.rig) return;
    this.publish({ busy: true, status: 'building the skeleton…' });
    const built = await this.client.rig(BASE_SKELETON, DONORS);
    if (this.disposed) return;
    this.rig = buildRig(built.bones);
    this.restRotations = new Map(this.rig.bones.map((b) => [b.name, b.quaternion.clone()]));
    this.view.scene.add(this.rig.root);
    this.publish({
      busy: false,
      rigBones: built.summary.bones,
      status: `skeleton: ${built.summary.bones} bones, ${built.summary.attachments} attachment points`,
    });
  }

  private async load(item: CatalogueItem): Promise<Object3D[]> {
    const key = `${item.id}:${this.state.wear}`;
    const hit = this.cache.get(key);
    if (hit) return hit;

    const mtl = item.materials[0];
    const material: MaterialPayload = mtl
      ? (await this.client.material(mtl)).material
      : { submaterials: [], library: {} };
    const fetchTexture = async (path: string, maxSize: number) =>
      (await this.client.texture(path, maxSize)).texture;
    const composited = await compositeSurfaces(material, paletteOf(item), fetchTexture, this.state.wear);
    const count = Math.max(1, material.submaterials.length);
    const materials = material.submaterials.length
      ? material.submaterials.map((sub) => materialFor(sub.name, composited))
      : [materialFor('', composited)];

    const objects: Object3D[] = [];
    // A piece can be several meshes: arms ship a left and a right.
    for (const geometry of item.geometry) {
      if (item.bind_mode === 'socket') {
        const socket = item.socket ?? 'backpack_attach_1_override';
        const prop: PropPayload = (await this.client.prop(geometry.source, socket)).prop;
        const object = new Mesh(buildGeometry(prop, count).geometry, materials);
        object.frustumCulled = false;
        if (prop.mount) {
          object.matrixAutoUpdate = false;
          object.matrix.copy(mountMatrix(prop.mount));
        }
        objects.push(object);
      } else {
        const mesh: MeshPayload = (await this.client.mesh(geometry.source)).mesh;
        const object = new SkinnedMesh(buildGeometry(mesh, count).geometry, materials);
        object.frustumCulled = false;
        objects.push(object);
      }
    }
    this.cache.set(key, objects);
    return objects;
  }

  async equip(item: CatalogueItem): Promise<void> {
    if (!this.rig) await this.init();
    if (this.disposed || !this.rig) return;
    const slot = item.slot as Slot;
    const name = displayName(item);
    this.publish({ busy: true, status: `${name}…` });

    let objects: Object3D[];
    try {
      objects = await this.load(item);
    } catch (error) {
      this.publish({
        busy: false,
        status: `${name}: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    if (this.disposed) return;

    // The old piece comes out first, so a slot never holds two.
    for (const previous of this.equipped.get(slot) ?? []) previous.removeFromParent();

    for (const object of objects) {
      if (object instanceof SkinnedMesh) {
        this.view.scene.add(object);
        object.bind(this.rig.skeleton, object.matrixWorld);
      } else {
        const bone = this.rig.byName.get(item.socket ?? 'backpack_attach_1_override');
        (bone ?? this.view.scene).add(object);
      }
    }
    this.equipped.set(slot, objects);
    this.wearing.set(slot, item);

    const triangles = objects.reduce(
      (sum, o) => sum + ((o as Mesh).geometry?.getIndex()?.count ?? 0) / 3,
      0,
    );
    this.frameLoadout();
    this.publish({ busy: false, status: `${name} · ${triangles.toLocaleString()} triangles` });
  }

  unequip(slot: Slot): void {
    for (const object of this.equipped.get(slot) ?? []) object.removeFromParent();
    this.equipped.delete(slot);
    this.wearing.delete(slot);
    this.publish({ status: `${slot} removed` });
  }

  clear(): void {
    for (const objects of this.equipped.values()) for (const o of objects) o.removeFromParent();
    this.equipped.clear();
    this.wearing.clear();
    this.publish({ status: 'cleared' });
  }

  /** Fill the empty slots to match the piece on the torso, or whatever is on. */
  async equipSet(): Promise<number> {
    const anchor = this.wearing.get('torso') ?? [...this.wearing.values()][0];
    if (!anchor) {
      this.publish({ status: 'equip something first, then match a set to it' });
      return 0;
    }
    const picks = matchSet(anchor, this.catalogue, this.wearing);
    for (const item of picks) await this.equip(item);
    this.publish({
      status: picks.length
        ? `set: filled ${picks.length} slot${picks.length === 1 ? '' : 's'}`
        : 'no matching pieces for the empty slots',
    });
    return picks.length;
  }

  async setPose(pose: Pose): Promise<void> {
    if (!this.rig) await this.init();
    if (this.disposed || !this.rig) return;
    if (!pose.dba || !pose.clip) {
      for (const bone of this.rig.bones) bone.quaternion.copy(this.restRotations.get(bone.name)!);
      this.rig.root.updateMatrixWorld(true);
      this.rig.skeleton.update();
      this.publish({ pose: pose.label, status: 'rest pose' });
      return;
    }
    const posed = await this.client.pose(pose.dba, pose.clip);
    if (this.disposed) return;
    applyClip(this.rig, posed.pose.locals);
    this.publish({
      pose: pose.label,
      status: `${pose.label}: ${posed.pose.animated} of ${posed.pose.clipBones} clip bones`,
    });
  }

  /** Worn, or as it left the factory. Re-composites everything on the body. */
  async setWear(wear: boolean): Promise<void> {
    if (wear === this.state.wear) return;
    this.publish({ wear, busy: true, status: `recompositing ${wear ? 'worn' : 'as it left the factory'}…` });
    for (const item of [...this.wearing.values()]) await this.equip(item);
    this.publish({ busy: false, status: wear ? 'worn' : 'as it left the factory' });
  }

  loadout(): string {
    return encodeLoadout(this.wearing);
  }

  async restore(encoded: string): Promise<number> {
    const items = decodeLoadout(encoded, this.catalogue);
    for (const item of items) await this.equip(item);
    return items.length;
  }

  /** Point the camera at whatever is on the body, filling the panel.
   *
   * **Fit both axes, not the largest extent against one.** `camera.fov` is the
   * *vertical* field of view; the horizontal one follows from the aspect. The
   * first version took `max(x, y, z)` and fitted that against the vertical fov
   * alone, which for a standing figure means fitting its **width** to its
   * *height's* field -- and a `.skin`'s bounding box is its **bind pose**, arms
   * out, so the width is 1.45 m against a 1.88 m height. Measured on a full
   * Sunchaser set in a 636x477 panel, that left the character 276 px tall: 58%
   * of the canvas, with the rest empty, and still clipped by the page fold.
   *
   * The ground-plane extent is taken as a radius rather than per axis, because
   * x and z swap roles as the camera orbits and a fit that changes with the
   * angle is worse than one that is slightly loose.
   */
  frameLoadout(): void {
    const bounds = new Box3();
    let any = false;
    for (const objects of this.equipped.values()) {
      for (const object of objects) {
        bounds.expandByObject(object);
        any = true;
      }
    }
    if (!any) return;
    const { camera, controls } = this.view;
    const centre = bounds.getCenter(new Vector3());
    const size = bounds.getSize(new Vector3());

    const halfVertical = Math.tan((camera.fov * Math.PI) / 360);
    const halfHorizontal = halfVertical * Math.max(camera.aspect, 0.01);
    const radius = Math.hypot(size.x, size.z) / 2;
    const distance = Math.max(
      size.y / 2 / halfVertical,
      radius / halfHorizontal,
      MIN_FRAME_DISTANCE,
    ) * FRAME_MARGIN;

    // **Keep whichever way the visitor is looking.** Re-framing on every equip
    // is right -- a backpack changes the silhouette -- but swinging the camera
    // back to a fixed three-quarter view each time would fight someone who has
    // orbited round to look at the back, and equipping a colourway fires this
    // too. Only the distance and the target move. The opening direction comes
    // from `Viewer`'s initial camera, which faces the visor: negative z is the
    // character's front, since the archive is Z-up with +y forward.
    const direction = new Vector3().subVectors(camera.position, controls.target);
    if (direction.lengthSq() < 1e-6) direction.set(0.5, 0.18, -1);
    direction.normalize();

    controls.target.copy(centre);
    camera.position.copy(centre).addScaledVector(direction, distance);
    camera.updateProjectionMatrix();
    controls.update();
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
    this.rig?.root.removeFromParent();
    this.rig = null;
    this.listeners.clear();
  }
}
