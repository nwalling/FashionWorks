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
  Bone,
  Box3,
  Group,
  Matrix4,
  type Material,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SkinnedMesh,
  type Texture,
  Vector3,
} from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import type { ArchiveClient } from '../archive/client';
import {
  colourwayName,
  displayName,
  lineOf,
  lineTitle,
  readCatalogue,
  sharedName,
  SLOTS,
  type Catalogue,
  type CatalogueItem,
  type Slot,
} from '../archive/catalogue';
import type { GearSlot } from '../archive/catalogue';
import type {
  AttachmentOverride,
  GearPayload,
  MaterialPayload,
  MeshPayload,
  PropPayload,
} from '../worker/archive.worker';
import { buildGeometry } from './geometry';
import {
  describePorts,
  portFor,
  portLabel,
  resolvePorts,
  revalidate,
  type OwnedPort,
} from '../gear/ports';
import { meshTexture, plainMaterial, surfaceMaterial, texturesWanted } from './materials';
import { applyClip, bonePosition, boneRotation, buildRig, mountMatrix, type BuiltRig } from './rig';
import { compositeSurfaces, dataTexture, type CompositeGeometry, type PaletteEntry } from './surface';

export type Body = 'male' | 'female';

/** The base skeleton and the donor pieces, per body type.
 *
 * **Both skeletons carry the same 220 bone names.** Measured against the real
 * archive: the female `.chr` has 220 bones, every name also in the male base,
 * and *no* female-only bone. The 35 the male armature has beyond that are all
 * grafted `*_override` attachment points, which come from the donor pieces and
 * not from the `.chr`. That is what makes a body switch a swap of meshes and
 * rig rather than a second binding scheme -- binding is by name everywhere.
 *
 * Donors are a fixed list, not an accumulation: grafting from more pieces
 * extends the armature rather than reproducing the pipeline's. Male reaches
 * 255 bones with 35 attachment points; female reaches 256 with 36.
 */
export const SKELETONS: Record<Body, { chr: string; donors: string[] }> = {
  male: {
    chr: 'Objects/Characters/Human/male_v7/export/bhm_skeleton_v7.chr',
    donors: [
      'Objects/Characters/Human/male_v7/armor/cds/m_cds_undersuit_armor_02.skin',
      'Objects/Characters/Human/male_v7/armor/slaver/m_slaver_heavy_armor_01_core.skin',
    ],
  },
  female: {
    chr: 'Objects/Characters/Human/female_v2/export/bhf_skeleton_v2.chr',
    donors: [
      'Objects/Characters/Human/female_v2/armor/cds/f_cds_undersuit_armor_02.skin',
      'Objects/Characters/Human/female_v2/armor/slaver/f_slaver_heavy_armor_01_core.skin',
    ],
  },
};

/** The male rig, for callers that predate the body switch. */
export const BASE_SKELETON = SKELETONS.male.chr;
export const DONORS = SKELETONS.male.donors;

/** How much room to leave around a framed loadout. Enough that a pauldron or a
 * backpack does not touch the edge, not so much that the figure swims. */
const FRAME_MARGIN = 1.12;

/** Never get closer than this, whatever the bounds say. A single glove would
 * otherwise put the camera inside its own near plane. */
const MIN_FRAME_DISTANCE = 0.6;

/** How much the loaded-piece cache may hold before it drops what is not worn.
 *
 * Estimated GPU bytes -- textures with their mips, plus geometry. It used to
 * hold everything ever equipped, forever: a torso was 85 MB of surfaces, and
 * browsing a slot for a few minutes exhausted the GPU and lost the context. */
const CACHE_BUDGET = 640 * 1024 * 1024;

/** Which piece's attachment points win, lowest first.
 *
 * Every piece can re-declare an attachment point, and the undersuit declares
 * most of them. The outermost piece that carries a point is the one it is
 * mounted on: the backpack hangs where the torso's shell puts it, the sidearm
 * where the legs put it. */
const OVERRIDE_ORDER: readonly Slot[] = ['undersuit', 'helmet', 'arms', 'legs', 'torso'];

/** Bake resolution for a swatch. A 22px chip needs a mean, not a texture. */
const SWATCH_BAKE = 64;

/** Detail-layer resolution for a swatch. Decoding these is the dominant cost
 * of a composite, and the mean barely moves between 512 and 64. */
const SWATCH_LAYER = 64;

/** One colour from a piece's submaterial means, as `#rrggbb`.
 *
 * Weighted by each submaterial's share of the mesh's triangles, so a camera
 * lens no longer counts as much as a chest plate. Unweighted, the Defiance
 * helmet's `camera_m` -- a lens a few hundred triangles across -- pulled the
 * chip as hard as the shell around it.
 *
 * Falls back to an unweighted mean when the weights are not known, which is
 * the case for a piece whose mesh will not load. A slightly-off chip beats no
 * chip.
 */
function meanColour(
  means: ReadonlyMap<string, [number, number, number]>,
  weights?: ReadonlyMap<string, number> | null,
): string | null {
  const entries = [...means.entries()];
  if (entries.length === 0) return null;

  const weightOf = (name: string) => (weights ? weights.get(name) ?? 0 : 1);
  let total = weights ? entries.reduce((sum, [name]) => sum + weightOf(name), 0) : entries.length;
  // A mesh whose material ids never line up with the .mtl leaves every weight
  // at zero; an unweighted mean is still better than nothing.
  const useWeights = Boolean(weights) && total > 0;
  if (!useWeights) total = entries.length;

  const rgb = [0, 0, 0];
  for (const [name, mean] of entries) {
    const w = useWeights ? weightOf(name) : 1;
    rgb[0]! += mean[0] * w;
    rgb[1]! += mean[1] * w;
    rgb[2]! += mean[2] * w;
  }
  const hex = rgb
    .map((v) => Math.max(0, Math.min(255, Math.round(v / total))).toString(16).padStart(2, '0'))
    .join('');
  return `#${hex}`;
}

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

/** One clip, by database path under the body's animation root. */
interface ClipSpec {
  readonly db: string;
  readonly clip: string;
}

const NW_IDLE: ClipSpec = { db: 'weapons/no_weapon/locomotion/stand.dba', clip: 'nw_stand_idle_turn360_planted' };
const NW_CROUCH: ClipSpec = { db: 'weapons/no_weapon/locomotion/crouch.dba', clip: 'nw_neutral_crouch_idle' };

/** Poses with something in the hand, by the animation set that holds it.
 *
 * Every clip here was dumped against our armature before it was used: the
 * stocked raised idle resolves 148 bones with none unresolved and animates
 * `RightWeaponBone` itself, which is the bone the game hangs the held weapon
 * on -- so the gun is in the hands without any IK of ours. A list is applied
 * in order over the rest pose: the pistol set has only an **upper-body** idle
 * (89 bones, hips untouched), so it rides on the unarmed standing idle for the
 * legs, as the game layers it. */
export const WEAPON_POSES: Record<string, Record<string, readonly ClipSpec[]>> = {
  stocked: {
    raised: [{ db: 'weapons/stocked/locomotion/stand.dba', clip: 'stocked_alerted_stand_idle_turn360_raised' }],
    crouch: [{ db: 'weapons/stocked/locomotion/crouch.dba', clip: 'stocked_alerted_crouch_idle_01' }],
  },
  pistol: {
    raised: [NW_IDLE, { db: 'weapons/pistol/locomotion/stand.dba', clip: 'pistol_alerted_stand_idle_upperbody_01' }],
    crouch: [{ db: 'weapons/pistol/locomotion/crouch.dba', clip: 'pistol_alerted_crouch_idle_iron_01' }],
  },
  knife: {
    raised: [NW_IDLE, { db: 'weapons/knife.dba', clip: 'knife_alerted_stand_idle_upperbody_01' }],
    crouch: [NW_CROUCH, { db: 'weapons/knife.dba', clip: 'knife_alerted_crouch_idle_upperbody_01' }],
  },
};

/** There is no "ready" (weapon lowered) stance. The stocked set's candidate,
 * `stocked_alerted_stand_idle_turn360_planted`, is a turn in place whose last
 * frame is the raised stance exactly -- weapon bone, both hands, head and hips
 * all 0 cm from `_raised` -- so a "ready" button changed nothing on screen.
 * The poses offered with a weapon are therefore rest and idle, which put it
 * back in its holster, raised, which draws it, and crouch, which keeps what is
 * in the hand. */
const DRAW_ORDER: readonly string[] = ['primary', 'sidearm', 'knife', 'gadget'];

/** The unarmed poses, as clip lists. */
const UNARMED_POSES: Record<string, readonly ClipSpec[]> = {
  rest: [],
  idle: [NW_IDLE],
  crouch: [NW_CROUCH],
};

/** The animation directory for each body. */
const BODY_ANIMATIONS: Record<Body, string> = { male: 'male_v7', female: 'female_v2' };

/** Gear the hand can hold. Grenades, magazines and pens are thrown, loaded or
 * injected in the game, never carried in the hand at rest. */
const HOLDABLE: ReadonlySet<string> = new Set(['primary', 'sidearm', 'knife', 'gadget']);

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
  readonly body: Body;
  /** Rebuilt on a body switch, because the geometry tree selects a different
   * mesh per skeleton. The listing renders from this, not from a prop. */
  readonly catalogue: Catalogue;
  /** Composited swatch colours, by item id, for the pieces whose colour is not
   * in a tint palette. Filled in lazily; absent means "not worked out yet". */
  readonly swatches: ReadonlyMap<string, string>;
  /** Gear on the body, by the port that holds it. */
  readonly carrying: ReadonlyMap<string, CatalogueItem>;
  /** Every holster the armour on the body provides, by port name. */
  readonly ports: ReadonlyMap<string, OwnedPort>;
  /** The port whose item is in the hand, or null. */
  readonly holding: string | null;
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
export function encodeLoadout(
  wearing: ReadonlyMap<Slot, CatalogueItem>,
  carrying: ReadonlyMap<string, CatalogueItem> = new Map(),
  holding: string | null = null,
): string {
  // Version 2 appends `;port=id` per piece of gear and `;hold=port`. The first
  // segment is exactly version 1, so an old link still decodes, and the
  // string stays opaque to the host.
  const parts = [SLOTS.filter((s) => wearing.has(s)).map((s) => wearing.get(s)!.id).join(',')];
  for (const [port, item] of carrying) parts.push(`${port}=${item.id}`);
  if (holding) parts.push(`hold=${holding}`);
  return parts.join(';');
}

export function decodeLoadout(encoded: string, catalogue: Catalogue): CatalogueItem[] {
  if (!encoded) return [];
  const byId = new Map(catalogue.items.map((i) => [i.id, i]));
  return (encoded.split(';')[0] ?? '')
    .split(',')
    .map((id) => byId.get(id.trim()))
    .filter((item): item is CatalogueItem => Boolean(item));
}

/** The gear half of a version-2 loadout: what hangs where, and what is held. */
export function decodeGear(
  encoded: string,
  catalogue: Catalogue,
): { carrying: Array<{ port: string; item: CatalogueItem }>; holding: string | null } {
  const byId = new Map(catalogue.gear.map((i) => [i.id, i]));
  const carrying: Array<{ port: string; item: CatalogueItem }> = [];
  let holding: string | null = null;
  for (const part of encoded.split(';').slice(1)) {
    const [key, value] = part.split('=');
    if (!key || !value) continue;
    if (key === 'hold') {
      holding = value;
      continue;
    }
    const item = byId.get(value.trim());
    if (item) carrying.push({ port: key.trim(), item });
  }
  return { carrying, holding };
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
export const SET_MATCH_THRESHOLD = 8;

/** What equip-set anchors on, in order of preference. */
const ANCHOR_ORDER: readonly Slot[] = ['torso', 'helmet', 'arms', 'legs', 'undersuit', 'backpack'];

/** Slots a set may simply not have, without the set being incomplete. */
export const OPTIONAL_SLOTS: ReadonlySet<Slot> = new Set<Slot>(['backpack', 'undersuit']);

/** Slot words, which end the product part of a display name. Mirrors the
 * pipeline's `_NAME_SLOT_WORD`. */
const SLOT_WORD = /^(helmet|helm|core|torso|arms|arm|legs|leg|backpack|pack|undersuit|suit|flight)$/i;

/** What a name says after its slot word: "Sunchaser", "(Modified)", or "".
 *
 * **Not `colourwayName`, which depends on how big the item's family is.** That
 * takes the words a family has in common, so a family of ONE -- which is what
 * every "(Modified)" piece is -- shares its whole name and comes out as
 * "Standard" every time. Two unrelated singletons then "matched" editions and
 * scored three points for it. Reading the name against the slot word instead
 * gives the same answer whatever the family looks like.
 */
function editionOf(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  const at = words.findIndex((w) => SLOT_WORD.test(w.replace(/["'()]/g, '')));
  return at >= 0 ? words.slice(at + 1).join(' ') : '';
}

/** The `(...)` markers in a name, lowercased. An explicit statement that a
 * piece is a different build, rather than another colour of the same one. */
function parentheticals(name: string): Set<string> {
  return new Set((name.match(/\([^)]*\)/g) ?? []).map((m) => m.toLowerCase()));
}

/** How many leading words two product names share. */
function sharedLeadingWords(a: string, b: string): number {
  const left = a.split(/\s+/).filter(Boolean);
  const right = b.split(/\s+/).filter(Boolean);
  let n = 0;
  while (n < left.length && n < right.length && left[n] === right[n]) n += 1;
  return n;
}

/** What equipping a set would do, and why it would not do the rest. */
export interface SetPlan {
  readonly picks: CatalogueItem[];
  readonly unfilled: ReadonlyArray<{ slot: Slot; reason: string; absent: boolean }>;
  /** Picks taken from another product line -- a shared livery rather than a
   * shared set. Legitimate, and worth saying out loud. */
  readonly crossLine: ReadonlyArray<{ slot: Slot; name: string; line: string }>;
}

export function matchSet(
  anchor: CatalogueItem,
  catalogue: Catalogue,
  wearing: ReadonlyMap<Slot, CatalogueItem>,
): SetPlan {
  const familyName = (item: CatalogueItem) =>
    lineTitle(lineOf(catalogue, item));
  const anchorShared = familyName(anchor);
  const edition = editionOf(displayName(anchor));
  const anchorMarks = parentheticals(displayName(anchor));
  const anchorLine = anchorShared.split(' ')[0] ?? '';
  const paletteKey = anchor.tint?.layers?.[0]?.color ?? '';

  const score = (item: CatalogueItem): number => {
    let points = 0;
    if (anchor.set && item.set === anchor.set) points += 8;
    const itemShared = familyName(item);
    // The manufacturer and the leading word of the name stand in for the
    // product line, which the catalogue does not name directly.
    if (item.manufacturer?.code && item.manufacturer.code === anchor.manufacturer?.code) points += 3;
    // How much of the product name is shared, not merely its first word.
    //
    // First-word-only rejected pieces that plainly belong: the Advocacy
    // Interceptor Helmet and the Advocacy Interceptor Racing Flight Suit share
    // two words and a manufacturer, which came to 7 against a threshold of 8,
    // so the helmet could never find its own flight suit. Crediting the second
    // shared word carries it to 9.
    //
    // It cannot resurrect the bug this threshold exists for. "Defiance Core"
    // and "ADP-mk4 Arms" share no leading word at all, so they score nothing
    // here however much palette they have in common.
    const shared = sharedLeadingWords(itemShared, anchorShared);
    if (shared >= 1) points += 4;
    if (shared >= 2) points += 2;
    if (editionOf(displayName(item)) === edition) points += 3;
    // A parenthesised marker the anchor does not carry is a different product,
    // not a colourway of this one. Equipping a set from "Defiance Core
    // Sunchaser" was pulling "Defiance Legs (Modified)" over the Sunchaser
    // legs, because a one-member family's "edition" came out as Standard for
    // both and scored a match that was not there.
    for (const mark of parentheticals(displayName(item))) {
      if (!anchorMarks.has(mark)) points -= 4;
    }
    if (paletteKey && item.tint?.layers?.[0]?.color === paletteKey) points += 2;
    if (item.weight_class === anchor.weight_class) points += 1;
    return points;
  };

  const picks: CatalogueItem[] = [];
  const unfilled: Array<{ slot: Slot; reason: string; absent: boolean }> = [];
  const crossLine: Array<{ slot: Slot; name: string; line: string }> = [];
  for (const slot of SLOTS) {
    if (wearing.has(slot)) continue;
    const ranked = (catalogue.bySlot.get(slot) ?? [])
      .map((item) => ({ item, points: score(item) }))
      .sort((a, b) => b.points - a.points);
    const best = ranked[0];
    if (best && best.points >= SET_MATCH_THRESHOLD) {
      picks.push(best.item);
      // Say so when a pick comes from another product line.
      //
      // It is legitimate and sometimes the only option: "Crusader Edition" is
      // a LIVERY, not a set -- 23 pieces across 12 product lines and three
      // manufacturers, tagged `Texture_crus01` -- and ADP ships no Crusader
      // helmet at all, so a Crusader look has to borrow one. Liveries spanning
      // sets is the norm rather than the exception: `Texture_01` covers 37
      // sets, and 8 of the 14 texture tags cover more than one.
      //
      // But borrowing silently is how a visitor ends up wondering why they are
      // wearing a Balor helmet, so it is reported rather than hidden.
      const pickLine = familyName(best.item).split(' ')[0] ?? '';
      if (anchorLine && pickLine && pickLine !== anchorLine) {
        crossLine.push({ slot, name: displayName(best.item), line: pickLine });
      }
      continue;
    }
    // "Is there one at all?" is a question about the SET, not about the score.
    //
    // Scoring `<= 1` looked like the test for it and is not: a backpack from
    // the same manufacturer, weight and palette as the anchor scores 6 or 7
    // while belonging to an entirely different product, so it was reported as
    // "closest backpack was CSP-68H, 7 of 8" -- which reads as a near-miss the
    // match got wrong. It is not. That set has no backpack, and saying so is
    // the honest answer.
    //
    // So the test is the one the audit used: does anything in this slot carry
    // the anchor's set tag, or lead with its product name? Over all 103
    // canonical torso anchors, nothing that passed that test ever failed to be
    // picked -- the 208 unfilled slots were all genuine absences.
    const line = anchorShared.split(' ')[0];
    // The best candidate that is actually in this set, which is not always the
    // best candidate overall -- "Odyssey Helmet Tan" reported its closest
    // undersuit as an *Ace* Interceptor flight suit, because that outscored
    // the Odyssey one on palette. Naming the top scorer there describes a
    // piece nobody was asking about; `ranked` is sorted, so the first in-set
    // entry is the one worth naming.
    const bestInSet = ranked.find(({ item }) => (
      (anchor.set && item.set === anchor.set)
      || (line && familyName(item).split(' ')[0] === line)
    ));
    if (!bestInSet) {
      unfilled.push({ slot, reason: `no ${slot} in this set`, absent: true });
    } else {
      unfilled.push({
        slot,
        reason: `closest ${slot} was ${displayName(bestInSet.item)}, `
          + `${bestInSet.points} of ${SET_MATCH_THRESHOLD}`,
        absent: false,
      });
    }
  }
  return { picks, unfilled, crossLine };
}

export class Kitbasher {
  private rig: BuiltRig | null = null;

  private restRotations = new Map<string, Quaternion>();

  /** Where the hips sit at rest; a pose lowers them to keep the feet down. */
  private restHips: Vector3 | null = null;

  private readonly equipped = new Map<Slot, Loaded>();

  private readonly wearing = new Map<Slot, CatalogueItem>();

  /** Loaded pieces, so re-equipping is instant. Keyed by item, wear **and
   * body**, because all three pick a genuinely different mesh or bake.
   *
   * In least-recently-used order -- a hit moves to the back -- and bounded by
   * {@link CACHE_BUDGET}. What is on the body is never evicted. */
  private readonly cache = new Map<string, Loaded>();

  /** Materials found for items whose record names none, by item id. */
  private readonly discovered = new Map<string, string | null>();

  /** Gear on the body, by the port that holds it. */
  private readonly carried = new Map<string, Carried>();

  /** The port whose item is in the hand. */
  private holdingPort: string | null = null;

  /** The last port held, which `raised` draws from again. */
  private lastHeld: string | null = null;

  /** Each attachment point as the rig built it, to restore when the piece
   * that moved it comes off. */
  private attachmentDefaults = new Map<string, { parent: Object3D; position: Vector3; quaternion: Quaternion }>();

  private state: KitbasherState;

  private readonly listeners = new Set<(state: KitbasherState) => void>();

  private disposed = false;

  constructor(
    private readonly client: ArchiveClient,
    catalogue: Catalogue,
    private readonly view: KitbasherScene,
    body: Body = 'male',
  ) {
    this.state = {
      wearing: new Map(),
      pose: 'rest',
      wear: true,
      status: '',
      busy: false,
      rigBones: 0,
      body,
      catalogue,
      swatches: new Map(),
      carrying: new Map(),
      ports: new Map(),
      holding: null,
    };
  }

  /** The catalogue for the body currently on screen. */
  get catalogue(): Catalogue {
    return this.state.catalogue;
  }

  private readonly swatches = new Map<string, string>();

  /** A mesh's UV layout and triangle share per material id, keyed by the mesh.
   *
   * **Keyed by the mesh, not the item, because a colourway family shares one.**
   * That is what makes a swatch affordable: twenty Odyssey colourways resolve
   * one mesh between them, not twenty. */
  private readonly swatchMeshes = new Map<string, {
    geometry: CompositeGeometry[];
    triangles: Map<number, number>;
    materialFile: string | null;
  } | null>();

  private async swatchMesh(item: CatalogueItem) {
    const source = item.geometry[0]?.source;
    if (!source) return null;
    const cached = this.swatchMeshes.get(source);
    if (cached !== undefined) return cached;
    let entry: {
      geometry: CompositeGeometry[];
      triangles: Map<number, number>;
      materialFile: string | null;
    } | null = null;
    try {
      const payload: MeshPayload = item.bind_mode === 'socket'
        ? (await this.client.prop(source, item.socket ?? 'backpack_attach_1_override')).prop
        : (await this.client.mesh(source)).mesh;
      const triangles = new Map<number, number>();
      for (const submesh of payload.submeshes) {
        triangles.set(submesh.materialId, (triangles.get(submesh.materialId) ?? 0) + submesh.count / 3);
      }
      entry = {
        geometry: [{ uvs: payload.uvs, indices: payload.indices, submeshes: payload.submeshes }],
        triangles,
        materialFile: payload.materialFile,
      };
    } catch {
      // A mesh that will not load: the swatch falls back to an unweighted mean
      // over whole-square bakes.
      entry = null;
    }
    this.swatchMeshes.set(source, entry);
    return entry;
  }

  /** Triangle share per submaterial name. The id can point past the end of
   * the list -- the Sunchaser helmet declares seven groups against six
   * submaterials -- and an orphan group has no colour to weight. */
  private static weightsByName(
    triangles: ReadonlyMap<number, number>,
    material: MaterialPayload,
  ): Map<string, number> {
    const weights = new Map<string, number>();
    for (const [id, count] of triangles) {
      const name = material.submaterials[id]?.name;
      if (name) weights.set(name, (weights.get(name) ?? 0) + count);
    }
    return weights;
  }

  private readonly swatchAsked = new Set<string>();

  /** One at a time. The worker is a single thread, and a family of twenty
   * colourways asked for at once would starve whatever the visitor does next. */
  private swatchQueue: Promise<void> = Promise.resolve();

  /**
   * Work out a piece's colour by compositing its surface, for the 1,045 items
   * that carry no tint palette at all.
   *
   * Their colour lives in a `mtl_var` material rather than in a palette, so
   * there is nothing to read without running the LayerBlend composite -- which
   * is why these chips were blank. Averaging the material's raw layer colours
   * instead is the tempting shortcut and is wrong: it over-weights layers the
   * blend mask barely shows, and mushes a whole Odyssey family to one grey.
   * The mean of the *composited* albedo is what the piece actually looks like.
   *
   * Cheap on purpose. A mean needs no resolution, so this bakes at
   * {@link SWATCH_BAKE} instead of 1024 and decodes detail layers at
   * {@link SWATCH_LAYER} instead of 512. Same average, a fraction of the work.
   */
  requestSwatch(item: CatalogueItem): void {
    if (this.swatchAsked.has(item.id)) return;
    this.swatchAsked.add(item.id);

    this.swatchQueue = this.swatchQueue.then(async () => {
      if (this.disposed) return;
      try {
        const mesh = await this.swatchMesh(item);
        const mtl = await this.materialPathFor(item, mesh?.materialFile ?? null);
        if (!mtl || this.disposed) return;
        const material = (await this.client.material(mtl)).material;
        const fetchTexture = async (path: string, maxSize: number) =>
          (await this.client.texture(path, Math.min(maxSize, SWATCH_LAYER))).texture;
        const composited = await compositeSurfaces(material, paletteOf(item), fetchTexture, {
          wear: this.state.wear,
          size: SWATCH_BAKE,
          layerSize: SWATCH_LAYER,
          geometry: mesh?.geometry,
        });
        if (this.disposed) return;
        const weights = mesh ? Kitbasher.weightsByName(mesh.triangles, material) : null;
        const hex = meanColour(composited.means, weights);
        for (const pair of new Set(composited.surfaces.values())) {
          pair.albedo.dispose();
          pair.orm.dispose();
        }
        if (hex) {
          this.swatches.set(item.id, hex);
          this.publish({ swatches: new Map(this.swatches) });
        }
      } catch {
        // A blank chip is a better outcome than a listing that throws. The id
        // stays in `swatchAsked` so a broken piece is not retried forever.
      }
    });
  }

  /** The material an item wears: the one its record names, or -- for the
   * quarter of the catalogue that names none, including 97 of 142 backpacks --
   * the one the archive has for it by class name or by mesh. */
  private async materialPathFor(item: CatalogueItem, meshMaterial: string | null): Promise<string | null> {
    if (item.materials[0]) return item.materials[0];
    if (this.discovered.has(item.id)) return this.discovered.get(item.id) ?? null;
    let found: string | null = null;
    try {
      found = await this.client.discoverMaterial(
        item.class_name, item.geometry[0]?.source ?? '', meshMaterial,
      );
    } catch {
      found = null;
    }
    this.discovered.set(item.id, found);
    return found;
  }

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
    this.state = {
      ...this.state,
      ...patch,
      wearing: new Map(this.wearing),
      carrying: new Map([...this.carried].map(([port, c]) => [port, c.item])),
      holding: this.holdingPort,
    };
    for (const listener of this.listeners) listener(this.state);
  }

  /** Build the canonical armature for the current body and stand it in the
   * scene. Idempotent, and re-entered by a body switch after the old rig has
   * been taken out. */
  async init(): Promise<void> {
    if (this.rig) return;
    const { chr, donors } = SKELETONS[this.state.body];
    this.publish({ busy: true, status: 'building the skeleton…' });
    const built = await this.client.rig(chr, donors);
    if (this.disposed) return;
    this.rig = buildRig(built.bones);
    this.restRotations = new Map(this.rig.bones.map((b) => [b.name, b.quaternion.clone()]));
    this.restHips = this.rig.byName.get('Hips')?.position.clone() ?? null;
    this.attachmentDefaults = new Map(built.bones
      .filter((b) => b.attachment)
      .map((b) => {
        const bone = this.rig!.byName.get(b.name)!;
        return [b.name, {
          parent: bone.parent ?? this.rig!.root,
          position: bone.position.clone(),
          quaternion: bone.quaternion.clone(),
        }];
      }));
    this.view.scene.add(this.rig.root);
    this.publish({
      busy: false,
      rigBones: built.summary.bones,
      status: `skeleton: ${built.summary.bones} bones, ${built.summary.attachments} attachment points`,
    });
  }

  /** Switch body type: new skeleton, new catalogue, same loadout where it
   * exists for the other body.
   *
   * The DataCore item is shared between the two -- only the mesh the geometry
   * tree selects differs -- so what is worn carries across **by item id**. A
   * piece with no mesh for the other body simply does not come back, which is
   * honest: it is not in the game for that body either.
   */
  async setBody(body: Body): Promise<void> {
    if (body === this.state.body || this.state.busy) return;
    this.publish({ busy: true, status: `switching to the ${body} body…` });

    const worn = [...this.wearing.values()].map((item) => item.id);
    // Gear is the same item on either body; it comes back into the same ports.
    const gear = [...this.carried].map(([port, c]) => ({ port, id: c.item.id }));
    const held = this.holdingPort;
    for (const carried of this.carried.values()) carried.instance.removeFromParent();
    this.carried.clear();
    this.holdingPort = null;
    this.clear();
    // The cache is keyed by body, so nothing has to be thrown away; the old
    // body's meshes stay loaded and switching back is instant.
    this.rig?.root.removeFromParent();
    this.rig = null;

    const rebuilt = await this.client.catalogue(body, ({ step, fraction }) => {
      this.publish({ status: `${step} ${Math.round(fraction * 100)}%` });
    });
    if (this.disposed) return;

    this.state = { ...this.state, body, catalogue: readCatalogue(rebuilt.json) };
    await this.init();
    if (this.disposed) return;

    const byId = new Map(this.state.catalogue.items.map((i) => [i.id, i]));
    let restored = 0;
    for (const id of worn) {
      const item = byId.get(id);
      if (!item) continue;
      await this.equip(item);
      restored += 1;
    }
    const gearById = new Map(this.state.catalogue.gear.map((i) => [i.id, i]));
    for (const { port, id } of gear) {
      const item = gearById.get(id);
      if (item) await this.carry(item, port);
    }
    if (held && this.carried.has(held)) this.holdingPort = held;
    for (const carried of this.carried.values()) this.mountCarried(carried);
    await this.setPose(this.poseOptions().includes(this.state.pose) ? this.state.pose : 'rest');

    this.publish({
      busy: false,
      status: `${body} body · ${this.state.catalogue.items.length.toLocaleString()} pieces`
        + (worn.length ? ` · ${restored} of ${worn.length} carried over` : ''),
    });
  }

  private async load(item: CatalogueItem): Promise<Loaded> {
    const key = `${item.id}:${this.state.wear}:${this.state.body}`;
    const hit = this.cache.get(key);
    if (hit) {
      // Most recently used goes to the back of the eviction order.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }

    // Meshes first: the compositor needs to know where each submaterial sits
    // in UV space to bake them all into one atlas.
    const socket = item.bind_mode === 'socket';
    const socketName = item.socket ?? 'backpack_attach_1_override';
    const payloads: Array<MeshPayload | PropPayload> = [];
    // A piece can be several meshes: arms ship a left and a right.
    for (const geometry of item.geometry) {
      payloads.push(socket
        ? (await this.client.prop(geometry.source, socketName)).prop
        : (await this.client.mesh(geometry.source)).mesh);
    }

    const mtl = await this.materialPathFor(item, payloads[0]?.materialFile ?? null);
    const material: MaterialPayload = mtl
      ? (await this.client.material(mtl)).material
      : { submaterials: [], library: {} };
    const fetchTexture = async (path: string, maxSize: number) =>
      (await this.client.texture(path, maxSize)).texture;
    const composited = await compositeSurfaces(material, paletteOf(item), fetchTexture, {
      wear: this.state.wear,
      geometry: payloads.map((p) => ({ uvs: p.uvs, indices: p.indices, submeshes: p.submeshes })),
      detail: true,
    });

    // The textures the materials bind directly: the armour's own normal maps,
    // and the diffuse of anything that is not LayerBlend.
    const byPath = new Map<string, Texture>();
    for (const sub of material.submaterials) {
      for (const want of texturesWanted(sub)) {
        if (byPath.has(want.path)) continue;
        const payload = (await this.client.texture(want.path, 1024)).texture;
        if (!payload) continue;
        byPath.set(
          want.path,
          meshTexture(dataTexture(payload.rgba, payload.width, payload.height, want.srgb), want.srgb),
        );
      }
    }

    const count = Math.max(1, material.submaterials.length);
    const materials: Material[] = material.submaterials.length
      ? material.submaterials.map((sub) => (composited.surfaces.has(sub.name)
        ? surfaceMaterial(sub, composited, { byPath })
        : plainMaterial(sub, { byPath })))
      : [plainMaterial({
        name: '', shader: 'Illum', tintable: false, textures: {}, layers: [],
        glow: 0, opacity: 1, alphaTest: 0, shininess: 0.45,
      }, { byPath })];

    const objects: Object3D[] = [];
    for (const payload of payloads) {
      if (socket) {
        const prop = payload as PropPayload;
        const object = new Mesh(buildGeometry(prop, count).geometry, materials);
        object.frustumCulled = false;
        shaded(object);
        if (prop.mount) {
          object.matrixAutoUpdate = false;
          object.matrix.copy(mountMatrix(prop.mount));
        }
        objects.push(object);
      } else {
        const object = new SkinnedMesh(buildGeometry(payload, count).geometry, materials);
        object.frustumCulled = false;
        shaded(object);
        objects.push(object);
      }
    }

    const loaded = measure(
      key,
      objects,
      materials,
      payloads.flatMap((p) => p.overrides ?? []),
      socket ? (payloads[0] as PropPayload | undefined)?.helperTransforms : undefined,
    );
    this.cache.set(key, loaded);
    this.evict(loaded);
    return loaded;
  }

  /** Drop least-recently-used pieces until the cache fits its budget. Never
   * one that is on the body. */
  private evict(keep?: Loaded): void {
    const worn = new Set(this.equipped.values());
    // The piece a load just made is about to be worn or carried, but is not
    // yet either. Unprotected, it was the one entry left to evict once live
    // pieces passed the budget: disposed, then equipped anyway and no longer
    // tracked -- 377 MB of a 23-item loadout, found by the render harness.
    if (keep) worn.add(keep);
    for (const carried of this.carried.values()) {
      worn.add(carried.template);
      if (carried.magazine) worn.add(carried.magazine.template);
    }
    let total = 0;
    for (const loaded of this.cache.values()) total += loaded.bytes;
    for (const [key, loaded] of this.cache) {
      if (total <= CACHE_BUDGET) break;
      if (worn.has(loaded)) continue;
      loaded.dispose();
      this.cache.delete(key);
      total -= loaded.bytes;
    }
  }

  /** What the cache holds, for a check to read. */
  cacheStats(): { entries: number; bytes: number; worn: number } {
    let bytes = 0;
    for (const loaded of this.cache.values()) bytes += loaded.bytes;
    return { entries: this.cache.size, bytes, worn: this.equipped.size };
  }

  /** Move every attachment point to where the outermost piece declaring it
   * puts it, or back to the rig's own where none does.
   *
   * The rig's points come from one undersuit donor. A torso re-declares them
   * for its own shell -- the ADP-mk4 core carries the backpack point ten
   * centimetres further back -- and a Warden pack hung on the donor's point
   * sat inside that shell. */
  private applyOverrides(): void {
    const rig = this.rig;
    if (!rig) return;
    const chosen = new Map<string, AttachmentOverride>();
    for (const slot of OVERRIDE_ORDER) {
      for (const override of this.equipped.get(slot)?.overrides ?? []) chosen.set(override.name, override);
    }
    for (const [name, rest] of this.attachmentDefaults) {
      const bone = rig.byName.get(name);
      if (!bone) continue;
      const override = chosen.get(name);
      const parent: Bone | undefined = override?.parent ? rig.byName.get(override.parent) : undefined;
      if (override && parent) {
        if (bone.parent !== parent) parent.add(bone);
        bone.position.copy(bonePosition(override.position));
        bone.quaternion.copy(boneRotation(override.rotation));
      } else {
        if (bone.parent !== rest.parent) rest.parent.add(bone);
        bone.position.copy(rest.position);
        bone.quaternion.copy(rest.quaternion);
      }
      this.restRotations.set(name, bone.quaternion.clone());
    }
    rig.root.updateMatrixWorld(true);
    rig.skeleton.update();
  }

  /** Where an attachment point is right now, in the scene. For checks. */
  attachmentWorld(name: string): [number, number, number] | null {
    const bone = this.rig?.byName.get(name);
    if (!bone) return null;
    const at = bone.getWorldPosition(new Vector3());
    return [at.x, at.y, at.z];
  }

  async equip(item: CatalogueItem): Promise<void> {
    if (!this.rig) await this.init();
    if (this.disposed || !this.rig) return;
    const slot = item.slot as Slot;
    const name = displayName(item);
    this.publish({ busy: true, status: `${name}…` });

    let loaded: Loaded;
    try {
      loaded = await this.load(item);
    } catch (error) {
      this.publish({
        busy: false,
        status: `${name}: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    if (this.disposed) return;

    // The old piece comes out first, so a slot never holds two.
    for (const previous of this.equipped.get(slot)?.objects ?? []) previous.removeFromParent();

    for (const object of loaded.objects) {
      if (object instanceof SkinnedMesh) {
        this.view.scene.add(object);
        object.bind(this.rig.skeleton, object.matrixWorld);
      } else {
        const bone = this.rig.byName.get(item.socket ?? 'backpack_attach_1_override');
        (bone ?? this.view.scene).add(object);
      }
    }
    this.equipped.set(slot, loaded);
    this.wearing.set(slot, item);
    this.applyOverrides();
    const gear = this.revalidateGear();
    // The piece this replaced may be evictable now.
    this.evict();

    const triangles = loaded.objects.reduce(
      (sum, o) => sum + ((o as Mesh).geometry?.getIndex()?.count ?? 0) / 3,
      0,
    );
    this.frameLoadout();
    const status = gear.removed.length
      ? `${name}: ${describePorts(gear.ports)}; ${gear.removed.join(', ')} came off`
      : `${name} · ${triangles.toLocaleString()} triangles`;
    this.publish({ busy: false, ports: gear.ports, status });
    // The held item came off with its holster: nothing is in the hand, so a
    // weapon stance would be holding air. The removal is the news, so it keeps
    // the status line.
    if (gear.lostHold) {
      await this.setPose(this.unarmedPose());
      this.publish({ status });
    }
  }

  unequip(slot: Slot): void {
    for (const object of this.equipped.get(slot)?.objects ?? []) object.removeFromParent();
    this.equipped.delete(slot);
    this.wearing.delete(slot);
    this.applyOverrides();
    const gear = this.revalidateGear();
    const status = gear.removed.length
      ? `${slot} removed; ${gear.removed.join(', ')} came off with it`
      : `${slot} removed`;
    this.publish({ ports: gear.ports, status });
    if (gear.lostHold) void this.setPose(this.unarmedPose()).then(() => this.publish({ status }));
  }

  clear(): void {
    for (const loaded of this.equipped.values()) for (const o of loaded.objects) o.removeFromParent();
    this.equipped.clear();
    this.wearing.clear();
    this.applyOverrides();
    const gear = this.revalidateGear();
    this.publish({ ports: gear.ports, status: 'cleared' });
    if (gear.lostHold) void this.setPose(this.unarmedPose()).then(() => this.publish({ status: 'cleared' }));
  }

  /** Fill the empty slots to match the piece on the torso, or whatever is on.
   *
   * The anchor is an armour piece whenever one is worn: a backpack or an
   * undersuit is rarely sold as part of a set, and anchoring on one matched
   * the armour to a pack. */
  async equipSet(): Promise<number> {
    const anchor = ANCHOR_ORDER.map((slot) => this.wearing.get(slot)).find(Boolean);
    if (!anchor) {
      this.publish({ status: 'equip something first, then match a set to it' });
      return 0;
    }
    const plan = matchSet(anchor, this.catalogue, this.wearing);
    for (const item of plan.picks) await this.equip(item);

    // Say what happened to the slots that stayed empty. Reporting only the
    // count read as a silent failure: "filled 3" tells nobody whether the set
    // has no backpack or whether the match gave up.
    //
    // **A backpack or undersuit is never a failure.** Most sets ship neither,
    // so "this set has no undersuit or backpack" was on nearly every result
    // and made a complete set read as a partial one. They are filled when the
    // set has them and otherwise not mentioned.
    const filled = plan.picks.length
      ? `filled ${plan.picks.length} slot${plan.picks.length === 1 ? '' : 's'}`
      : 'nothing to add';
    const required = plan.unfilled.filter((u) => !OPTIONAL_SLOTS.has(u.slot));
    const absent = required.filter((u) => u.absent).map((u) => u.slot);
    const short = required.filter((u) => !u.absent).map((u) => u.reason);
    // Borrowing a piece from another line is a note, not a shortfall: the set
    // is complete, and the visitor is told where the piece came from.
    const borrowed = plan.crossLine.map((c) => `${c.slot} from ${c.line}`);
    const why = [
      absent.length ? `this set has no ${absent.join(' or ')}` : '',
      ...short,
    ].filter(Boolean);
    const notes = borrowed.length ? ` · ${borrowed.join(' · ')}` : '';
    this.publish({
      status: why.length
        ? `set: ${filled} · ${why.join(' · ')}${notes}`
        : `set complete: ${filled}${notes}`,
    });
    return plan.picks.length;
  }

  /** The poses on offer. `raised` joins them whenever something carried has a
   * stance to raise it in, held or not: it draws it. */
  poseOptions(): string[] {
    return this.drawable() ? ['rest', 'idle', 'raised', 'crouch'] : Object.keys(UNARMED_POSES);
  }

  /** What `raised` draws when nothing is in the hand: the last thing held if
   * it is still carried, else the first carried weapon, rifles first. */
  private drawable(): string | null {
    const stanced = (port: string) => {
      const item = this.carried.get(port)?.item;
      return Boolean(item && HOLDABLE.has(item.slot as GearSlot) && item.anim_set && WEAPON_POSES[item.anim_set]);
    };
    if (this.holdingPort && stanced(this.holdingPort)) return this.holdingPort;
    if (this.lastHeld && stanced(this.lastHeld)) return this.lastHeld;
    const ports = [...this.carried.keys()].filter(stanced);
    ports.sort((a, b) => DRAW_ORDER.indexOf(this.carried.get(a)!.item.slot)
      - DRAW_ORDER.indexOf(this.carried.get(b)!.item.slot));
    return ports[0] ?? null;
  }

  /** Put the held item back in its holster, or take one out, without posing. */
  private setHeld(port: string | null): void {
    if (port === this.holdingPort) return;
    const previous = this.holdingPort ? this.carried.get(this.holdingPort) : undefined;
    this.holdingPort = port;
    if (port) this.lastHeld = port;
    if (previous) this.mountCarried(previous);
    const next = port ? this.carried.get(port) : undefined;
    if (next) this.mountCarried(next);
  }

  /** The pose to fall back to when the hand empties: crouched stays crouched. */
  private unarmedPose(): string {
    return this.state.pose === 'crouch' ? 'crouch' : 'idle';
  }

  private clipsFor(label: string): readonly ClipSpec[] | null {
    const held = this.holdingPort ? this.carried.get(this.holdingPort) : null;
    const set = held?.item.anim_set ? WEAPON_POSES[held.item.anim_set] : undefined;
    if (label === 'rest') return [];
    if (set) return set[label] ?? set.raised ?? null;
    return UNARMED_POSES[label] ?? null;
  }

  /** Retarget one clip, from this body's own animations where it has them.
   *
   * The two skeletons carry the same 220 bone names, so a clip authored for
   * one retargets onto the other; the female rig ships the stocked and pistol
   * sets, and only an upper-body knife idle, so a clip missing there is taken
   * from the male set rather than skipped. */
  private async poseClip(spec: ClipSpec) {
    const own = `Animations/Characters/Human/${BODY_ANIMATIONS[this.state.body]}/${spec.db}`;
    try {
      return await this.client.pose(own, spec.clip);
    } catch (error) {
      if (this.state.body === 'male') throw error;
      return this.client.pose(`Animations/Characters/Human/${BODY_ANIMATIONS.male}/${spec.db}`, spec.clip);
    }
  }

  async setPose(pose: Pose | string): Promise<void> {
    if (!this.rig) await this.init();
    if (this.disposed || !this.rig) return;
    // "ready" was a pose once, and identical to raised; old callers get raised.
    const asked = typeof pose === 'string' ? pose : pose.label;
    const label = asked === 'ready' ? 'raised' : asked;
    // Standing at ease or at rest puts the weapon away, as the game does;
    // raising draws one. Crouch keeps whatever is in the hand.
    if (label === 'rest' || label === 'idle') this.setHeld(null);
    if (label === 'raised' && !this.holdingPort) {
      const port = this.drawable();
      if (!port) {
        this.publish({ status: 'nothing carried to raise: holster a weapon first' });
        return;
      }
      this.setHeld(port);
    }
    const clips = this.clipsFor(label);
    if (clips === null) {
      this.publish({ status: `no ${label} pose for what is in the hand` });
      return;
    }
    // From rest every time, so a layered clip never inherits the last pose's
    // legs, and a bone one clip leaves alone is not left where another put it.
    const rig = this.rig;
    const reset = () => {
      for (const bone of rig.bones) bone.quaternion.copy(this.restRotations.get(bone.name)!);
      if (this.restHips) rig.byName.get('Hips')?.position.copy(this.restHips);
    };
    const posed = [];
    try {
      for (const spec of clips) posed.push(await this.poseClip(spec));
    } catch (error) {
      this.publish({ status: `${label}: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    if (this.disposed) return;
    reset();
    rig.root.updateMatrixWorld(true);
    const restGround = footHeight(rig);
    for (const clip of posed) applyClip(rig, clip.pose.locals);
    rig.root.updateMatrixWorld(true);
    seatFeet(rig, restGround);
    rig.skeleton.update();
    const last = posed[posed.length - 1];
    this.publish({
      pose: label,
      status: last
        ? `${label}: ${last.pose.animated} of ${last.pose.clipBones} clip bones`
        : 'rest pose',
    });
  }

  // ---------------------------------------------------------------- gear

  /** Load a gear item's parts, composited, as a template to clone from.
   *
   * One template per item, whatever port it goes in: four identical grenades
   * share their geometry and surfaces and differ only in where they hang. */
  private async loadGear(item: CatalogueItem): Promise<Loaded> {
    const key = `gear:${item.id}:${this.state.wear}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const source = item.geometry[0]?.source;
    if (!source) throw new Error('no geometry');
    const payload: GearPayload = (await this.client.gear(source, '')).gear;
    const base = payload.parts[0]?.material?.toLowerCase() ?? null;
    const group = new Group();
    group.name = displayName(item);
    const all: Material[] = [];
    const empty: MaterialPayload = { submaterials: [], library: {} };
    const fetchTexture = async (path: string, maxSize: number) =>
      (await this.client.texture(path, maxSize)).texture;

    for (const part of payload.parts) {
      // The record's colourway material replaces the definition's own on the
      // parts that use it; a chambered round keeps its ammunition material.
      let mtl = part.material;
      if (item.materials[0] && (!mtl || mtl.toLowerCase() === base)) mtl = item.materials[0];
      if (!mtl) mtl = await this.materialPathFor(item, part.mesh.materialFile);
      let material = empty;
      if (mtl) {
        try {
          material = (await this.client.material(mtl)).material;
        } catch {
          material = empty;
        }
      }
      const composited = await compositeSurfaces(material, paletteOf(item), fetchTexture, {
        wear: this.state.wear,
        // A rifle is a torso's length and earns the full bake; a magazine, a
        // pen or a grenade is a few centimetres, and eight of them on a belt
        // at 1024 each would cost more than the armour they hang on.
        size: item.slot === 'primary' || item.slot === 'sidearm' ? 1024 : 512,
        geometry: [{ uvs: part.mesh.uvs, indices: part.mesh.indices, submeshes: part.mesh.submeshes }],
        detail: true,
      });
      const byPath = new Map<string, Texture>();
      for (const sub of material.submaterials) {
        for (const want of texturesWanted(sub)) {
          if (byPath.has(want.path)) continue;
          const texture = (await this.client.texture(want.path, 1024)).texture;
          if (texture) {
            byPath.set(
              want.path,
              meshTexture(dataTexture(texture.rgba, texture.width, texture.height, want.srgb), want.srgb),
            );
          }
        }
      }
      const count = Math.max(1, material.submaterials.length);
      const materials: Material[] = material.submaterials.length
        ? material.submaterials.map((sub) => (composited.surfaces.has(sub.name)
          ? surfaceMaterial(sub, composited, { byPath })
          : plainMaterial(sub, { byPath })))
        : [plainMaterial({
          name: '', shader: 'Illum', tintable: false, textures: {}, layers: [],
          glow: 0, opacity: 1, alphaTest: 0, shininess: 0.45,
        }, { byPath })];
      const mesh = new Mesh(buildGeometry(part.mesh, count).geometry, materials);
      mesh.name = part.name;
      mesh.frustumCulled = false;
      shaded(mesh);
      group.add(mesh);
      all.push(...materials);
    }
    const loaded = measure(key, [group], all, [], payload.helpers);
    this.cache.set(key, loaded);
    this.evict(loaded);
    return loaded;
  }

  /** A helper's transform on an item, in the scene's frame. */
  private static helperMatrix(helpers: Record<string, Float32Array> | undefined, name: string | null) {
    if (!helpers || !name) return null;
    const key = Object.keys(helpers).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? mountMatrix(helpers[key]!) : null;
  }

  /** An item's matrix when its `locator` is put on a host: the locator's
   * inverse. Identity when the item does not carry it -- the origin, visibly
   * wrong, rather than a mirrored guess. */
  private static mountFor(helpers: Record<string, Float32Array> | undefined, locator: string | null): Matrix4 {
    return Kitbasher.helperMatrix(helpers, locator)?.invert() ?? new Matrix4();
  }

  /** What a port's item hangs from: a node on the backpack, when the pack
   * owns the port, else the rig's bone of that name. */
  private hostFor(owned: OwnedPort): Object3D | null {
    const helper = owned.port.helper;
    if (!helper || !this.rig) return null;
    const piece = this.equipped.get(owned.owner);
    if (piece?.helpers && owned.item.bind_mode === 'socket') {
      const key = Object.keys(piece.helpers).find((k) => k.toLowerCase() === helper.toLowerCase());
      const node = piece.objects[0];
      if (key && node) {
        let host = piece.hosts.get(key);
        if (!host) {
          host = new Object3D();
          host.name = key;
          host.matrixAutoUpdate = false;
          host.matrix.copy(mountMatrix(piece.helpers[key]!));
          node.add(host);
          piece.hosts.set(key, host);
        }
        return host;
      }
    }
    return this.rig.byName.get(helper) ?? null;
  }

  private mountCarried(carried: Carried): void {
    carried.instance.removeFromParent();
    carried.instance.matrixAutoUpdate = false;
    if (this.holdingPort === carried.port.port.name) {
      // In the hand: the item's own origin on the hand bone, as the body's
      // `weapon_attach_hand_right` port declares -- it names no item locator.
      carried.instance.matrix.identity();
      (this.rig?.byName.get('RightWeaponBone') ?? this.view.scene).add(carried.instance);
      return;
    }
    const host = this.hostFor(carried.port);
    carried.instance.matrix.copy(Kitbasher.mountFor(carried.template.helpers, carried.port.port.offset));
    (host ?? this.view.scene).add(carried.instance);
  }

  /** The magazine a weapon ships with, seated on the weapon's own port. */
  private async attachMagazine(carried: Carried): Promise<void> {
    const entry = carried.item.default_children?.find((d) => d.port.toLowerCase() === 'magazine_attach');
    const magazine = entry ? this.catalogue.byClass.get(entry.class_name.toLowerCase()) : undefined;
    if (!magazine) return;
    let template: Loaded;
    try {
      template = await this.loadGear(magazine);
    } catch {
      return;
    }
    const port = carried.item.ports?.find((p) => p.name.toLowerCase() === 'magazine_attach');
    const at = Kitbasher.helperMatrix(carried.template.helpers, port?.helper ?? 'magAttach') ?? new Matrix4();
    const instance = template.objects[0]!.clone();
    instance.matrixAutoUpdate = false;
    instance.matrix.copy(at).multiply(Kitbasher.mountFor(template.helpers, port?.offset ?? null));
    carried.instance.add(instance);
    carried.magazine = { item: magazine, template };
  }

  /** Put a piece of gear on the body: in `port` if it will take it, else the
   * first free holster that will. Says why when nothing will. */
  async carry(item: CatalogueItem, port?: string | null): Promise<boolean> {
    if (!this.rig) await this.init();
    if (this.disposed || !this.rig) return false;
    const name = displayName(item);
    const ports = resolvePorts(this.wearing);
    const occupied = new Set(this.carried.keys());
    // Choosing an occupied port swaps what is in it.
    if (port) occupied.delete(port);
    const choice = portFor(item, ports, occupied, port);
    if ('reason' in choice) {
      this.publish({ ports, status: `${name}: ${choice.reason}` });
      return false;
    }
    const owned = choice.port;
    this.publish({ busy: true, status: `${name}…` });
    let template: Loaded;
    try {
      template = await this.loadGear(item);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Four gear records point at files this build of the game does not
      // ship; say that rather than print a path.
      const why = message.startsWith('not in this archive')
        ? 'its model is not in this build of the game'
        : message;
      this.publish({ busy: false, status: `${name}: ${why}` });
      return false;
    }
    if (this.disposed) return false;
    const previous = this.carried.get(owned.port.name);
    if (previous) previous.instance.removeFromParent();
    const carried: Carried = {
      item, template, instance: template.objects[0]!.clone(), magazine: null, port: owned,
    };
    this.carried.set(owned.port.name, carried);
    await this.attachMagazine(carried);
    this.mountCarried(carried);
    this.evict();
    this.frameLoadout();
    this.publish({
      busy: false,
      ports,
      status: `${name} · ${portLabel(owned.port)}${owned.owner === 'backpack' ? ' on the backpack' : ''}`,
    });
    return true;
  }

  /** Take a piece of gear off. */
  uncarry(port: string): void {
    const carried = this.carried.get(port);
    if (!carried) return;
    carried.instance.removeFromParent();
    this.carried.delete(port);
    const wasHeld = this.holdingPort === port;
    if (wasHeld) this.holdingPort = null;
    this.evict();
    const status = `${displayName(carried.item)} put away`;
    this.publish({ status });
    // The removal is the news, so it keeps the status line over the re-pose.
    if (wasHeld) void this.setPose(this.unarmedPose()).then(() => this.publish({ status }));
  }

  /** Take everything off the belt and the back. */
  clearGear(): void {
    for (const port of [...this.carried.keys()]) this.uncarry(port);
  }

  /** Hold a carried item, or nothing. The item leaves its holster for the
   * hand, as in the game, and the pose follows its animation set. */
  async hold(port: string | null): Promise<void> {
    const carried = port ? this.carried.get(port) : undefined;
    if (port && (!carried || !HOLDABLE.has(carried.item.slot as GearSlot))) {
      this.publish({ status: carried ? `${displayName(carried.item)} is not held in the hand` : 'nothing there to hold' });
      return;
    }
    this.setHeld(carried ? port : null);
    const set = carried?.item.anim_set ? WEAPON_POSES[carried.item.anim_set] : undefined;
    if (carried && !set) {
      this.publish({ status: `${displayName(carried.item)} in hand; there is no stance for it yet` });
      return;
    }
    // Choosing a weapon while crouched keeps the crouch; otherwise it comes up.
    await this.setPose(carried ? (this.state.pose === 'crouch' ? 'crouch' : 'raised') : this.unarmedPose());
  }

  /** Re-seat carried gear after the armour changed, and say what came off.
   *
   * A heavy core swapped for a light one takes `wep_stocked_2`, two grenade
   * points and four magazine points with it; whatever hung there comes off,
   * and the status names it -- the same rule equip-set follows. Gear whose
   * port merely changed owner (a backpack went on, and now holds the rifles)
   * moves with it. */
  private revalidateGear(): { removed: string[]; ports: Map<string, OwnedPort>; lostHold: boolean } {
    const ports = resolvePorts(this.wearing);
    const { kept, removed } = revalidate(this.carried, ports);
    const lostHold = removed.some(({ port }) => port === this.holdingPort);
    for (const { port, carried } of removed) {
      carried.instance.removeFromParent();
      this.carried.delete(port);
      if (this.holdingPort === port) this.holdingPort = null;
    }
    for (const { carried, owned } of kept) {
      carried.port = owned;
      this.mountCarried(carried);
    }
    return { removed: tally(removed.map(({ carried }) => displayName(carried.item))), ports, lostHold };
  }

  /** Worn, or as it left the factory. Re-composites everything on the body. */
  async setWear(wear: boolean): Promise<void> {
    if (wear === this.state.wear) return;
    this.publish({ wear, busy: true, status: `recompositing ${wear ? 'worn' : 'as it left the factory'}…` });
    for (const item of [...this.wearing.values()]) await this.equip(item);
    this.publish({ busy: false, status: wear ? 'worn' : 'as it left the factory' });
  }

  loadout(): string {
    const carrying = new Map([...this.carried].map(([port, c]) => [port, c.item]));
    return encodeLoadout(this.wearing, carrying, this.holdingPort);
  }

  async restore(encoded: string): Promise<number> {
    const items = decodeLoadout(encoded, this.catalogue);
    for (const item of items) await this.equip(item);
    const gear = decodeGear(encoded, this.catalogue);
    for (const { port, item } of gear.carrying) await this.carry(item, port);
    if (gear.holding && this.carried.has(gear.holding)) await this.hold(gear.holding);
    return items.length + gear.carrying.length;
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
    for (const loaded of this.equipped.values()) {
      for (const object of loaded.objects) {
        bounds.expandByObject(object);
        any = true;
      }
    }
    for (const carried of this.carried.values()) {
      bounds.expandByObject(carried.instance);
      any = true;
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
    for (const carried of this.carried.values()) carried.instance.removeFromParent();
    this.carried.clear();
    this.clear();
    for (const loaded of this.cache.values()) loaded.dispose();
    this.cache.clear();
    this.rig?.root.removeFromParent();
    this.rig = null;
    this.listeners.clear();
  }
}

/** Names with repeats counted: four magazines read "4 × P4-AR Magazine". */
function tally(names: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, n]) => (n > 1 ? `${n} × ${name}` : name));
}

/** Lowest world height of the foot and toe bones.
 *
 * Clips apply rotations only, which keeps bone lengths ours but leaves the hips
 * at standing height: a crouch bent the knees and lifted the boots 30 cm off
 * the floor. The grid never showed it; the floor shadow, landing well clear of
 * the boots, did. */
const FOOT_BONES = ['LeftToeBase', 'RightToeBase', 'LeftFoot', 'RightFoot'];

function footHeight(rig: BuiltRig): number | null {
  const point = new Vector3();
  let lowest: number | null = null;
  for (const name of FOOT_BONES) {
    const bone = rig.byName.get(name);
    if (!bone) continue;
    bone.getWorldPosition(point);
    lowest = lowest === null ? point.y : Math.min(lowest, point.y);
  }
  return lowest;
}

/** Lower (or raise) the hips so the lowest foot is where it is at rest, which
 * is on the floor. The same rule the local viewer's poses use. */
function seatFeet(rig: BuiltRig, restGround: number | null): void {
  const hips = rig.byName.get('Hips');
  const posedGround = footHeight(rig);
  if (!hips?.parent || restGround === null || posedGround === null) return;
  const from = hips.parent.worldToLocal(new Vector3(0, 0, 0));
  const to = hips.parent.worldToLocal(new Vector3(0, restGround - posedGround, 0));
  hips.position.add(to.sub(from));
  rig.root.updateMatrixWorld(true);
}

/** Everything worn or carried casts the key light's shadow and takes it: onto
 * the floor, and from a helmet onto a collar or a rifle onto a back plate. A
 * clone copies both flags, so a carried instance inherits them. */
function shaded(object: Object3D): void {
  object.castShadow = true;
  object.receiveShadow = true;
}

/** A loaded piece: what goes in the scene, what it moves, and what it costs. */
interface Loaded {
  readonly key: string;
  readonly objects: Object3D[];
  readonly overrides: AttachmentOverride[];
  /** Estimated bytes held, GPU and CPU together. */
  readonly bytes: number;
  /** A rigid piece's helper nodes, in its own space: a backpack's holsters,
   * a rifle's `magAttach`. */
  readonly helpers?: Record<string, Float32Array>;
  /** Hosts made for those helpers, so a holster is made once. */
  readonly hosts: Map<string, Object3D>;
  dispose(): void;
}

/** A piece of gear on the body. */
interface Carried {
  readonly item: CatalogueItem;
  /** The loaded item this is a clone of: geometry and surfaces are shared. */
  readonly template: Loaded;
  readonly instance: Object3D;
  magazine: { item: CatalogueItem; template: Loaded } | null;
  port: OwnedPort;
}

/** Everything a loaded piece owns, measured, with a way to free it. */
function measure(
  key: string,
  objects: Object3D[],
  materials: Material[],
  overrides: AttachmentOverride[],
  helpers?: Record<string, Float32Array>,
): Loaded {
  const textures = new Set<Texture>();
  for (const material of materials) {
    const m = material as Material & Record<string, unknown>;
    for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) {
      const texture = m[slot] as Texture | null | undefined;
      if (texture && !texture.userData.shared) textures.add(texture);
    }
    const grain = m.userData?.fwGrain as Record<string, { value: unknown }> | undefined;
    for (const uniform of Object.values(grain ?? {})) {
      const texture = uniform.value as Texture | null;
      if (texture && typeof texture === 'object' && 'isTexture' in texture) textures.add(texture);
    }
  }
  let bytes = 0;
  for (const texture of textures) {
    const image = texture.image as { width?: number; height?: number; depth?: number; data?: ArrayLike<number> };
    const texels = (image.width ?? 0) * (image.height ?? 0) * (image.depth ?? 1);
    // GPU with mips, plus the CPU copy three.js keeps for re-upload.
    bytes += texels * 4 * 1.34 + (image.data?.length ?? 0);
  }
  const geometries = new Set<Mesh['geometry']>();
  for (const root of objects) {
    root.traverse((object) => {
      const geometry = (object as Mesh).geometry;
      if (!geometry || geometries.has(geometry)) return;
      geometries.add(geometry);
      for (const attribute of Object.values(geometry.attributes)) bytes += attribute.array.byteLength * 2;
      bytes += (geometry.index?.array.byteLength ?? 0) * 2;
    });
  }
  return {
    key,
    objects,
    overrides,
    bytes,
    helpers,
    hosts: new Map(),
    dispose() {
      for (const texture of textures) texture.dispose();
      for (const material of materials) material.dispose();
      for (const geometry of geometries) geometry.dispose();
    },
  };
}

