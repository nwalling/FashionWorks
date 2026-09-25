/// <reference lib="webworker" />
/**
 * The archive worker. Everything to do with the P4K happens here.
 *
 * Not a style choice. The Rust core reads byte ranges **synchronously**, and
 * the only synchronous file read a browser offers is `FileReaderSync`, which
 * exists only in workers. `Blob.arrayBuffer()` cannot be awaited from inside a
 * WebAssembly call without unwinding the Rust stack, so there is no main-thread
 * version of this. That single fact is why WEB.md puts the archive in a
 * dedicated worker.
 *
 * It also keeps a 158 GB file and a 316 MB DataCore off the thread that is
 * rendering, which is the difference between a progress bar and a frozen tab.
 */

import type { IndexStep } from '../onboarding';
// Static, not dynamic: see the note beside `wasm.default` below.
import * as wasm from '../../../core/pkg/fashionworks_core.js';

/** One light of an authored rig, in the archive's Z-up frame. */
export interface RigLight {
  readonly name: string;
  /** `Projector` (a spot) or `Omni`. */
  readonly kind: string;
  readonly position: [number, number, number];
  readonly direction: [number, number, number];
  /** Linear 0-1. */
  readonly color: [number, number, number];
  /** The authored intensity, unscaled. */
  readonly intensity: number;
  readonly radius: number;
  /** Full cone angle, degrees. */
  readonly fov: number;
  readonly texture: string | null;
}

export type ToWorker = (
  | {
      type: 'open';
      file: File;
      skeleton: 'male' | 'female';
      catalogue?: boolean;
      /** Where to fetch the WebAssembly core from.
       *
       * Passed in rather than resolved here, because the published worker is a
       * **blob**: its own `import.meta.url` is the blob URL, so a relative path
       * resolved inside it points at nothing. The main thread knows where the
       * host's bundler put the asset; this worker cannot. Omitted by the
       * verification pages, which run the worker from source where the
       * bundler's own default resolution works.
       */
      coreUrl?: string;
    }
  /** For verification only: read ranges over HTTP instead of from a File. */
  | {
      type: 'open-url';
      url: string;
      byteLength: number;
      skeleton: 'male' | 'female';
      /** Skip the DataCore parse. A page drawing one mesh does not need it. */
      catalogue?: boolean;
      coreUrl?: string;
    }
  /** Rebuild the catalogue for the other body type, without re-indexing.
   *
   * The DataCore item is the same for both; what differs is which mesh the
   * geometry tree selects -- `SubGeometry[1]` is the female `f_*.skin` and
   * `SubGeometry[2]` the male `m_*.skin`. So switching body type is a
   * catalogue rebuild over an archive that is already open, not a re-open. */
  | { type: 'catalogue'; skeleton: 'male' | 'female' }
  /** Load one mesh from the already-open archive. */
  | { type: 'mesh'; path: string }
  /** A player's face from their `.chf`: the protos head and eyes, blended from
   * the library heads it names. CHARACTER.md. */
  | { type: 'character'; chf: Uint8Array }
  /** Build the canonical armature before any mesh is loaded. */
  | { type: 'rig'; base: string; donors: string[] }
  /** Resolve a `.mtl` and its whole layer library. */
  | { type: 'material'; path: string }
  /** Decode one texture to RGBA at the given mip. */
  | { type: 'texture'; path: string; maxSize: number; alpha?: boolean }
  /** A BC1 texture's raw blocks and mips, for upload still compressed. */
  | { type: 'blocks'; path: string; maxSize: number }
  /** Load a rigid prop and work out where it mounts. */
  | { type: 'prop'; path: string; socket: string }
  /** Retarget an animation clip onto the canonical armature. */
  | { type: 'pose'; path: string; clip: string }
  /** Every frame of a clip, for a looping player. RENDERING.md Phase 5. */
  | { type: 'clip'; path: string; clip: string }
  /** Find a material for an item whose record names none. */
  | { type: 'discover'; className: string; meshPath: string; meshMaterial: string | null }
  /** Load a gear item -- weapon, knife, pen, grenade, magazine -- and its
   * mount for the named locator on the item (empty for none). */
  | { type: 'gear'; path: string; locator: string }
  /** An HDR lighting probe as float RGBA faces. RENDERING.md Phase 1. */
  | { type: 'probe'; path: string; maxSize: number }
  /** The lights of one group in an object container. */
  | { type: 'lights'; socpak: string; group: string }
) & {
  /** Set on every request that expects an answer, and echoed on the answer.
   *
   * Without it replies were matched to requests by type alone, and a failed
   * request answered with a bare `failed` -- which the client could only treat
   * as the whole worker failing. One missing material then rejected every
   * request after it, for the rest of the session. */
  id?: number;
};

export interface RigSummary {
  /** Total bones: the base skeleton plus the grafted attachment points. */
  bones: number;
  base: number;
  grafted: number;
  attachments: number;
}

export interface RigBone {
  name: string;
  /** Index of the parent bone, or -1 for the root. */
  parent: number;
  /** Parent-relative position. */
  position: Float32Array;
  /** Parent-relative rotation, as the archive stores it: [w, x, y, z]. */
  rotation: Float32Array;
  world: Float32Array;
  attachment: boolean;
}

export interface LayerRef {
  name: string;
  path: string;
  /** The layer's own colour, linear. */
  tintColor: Float32Array;
  /** 0 = the artist chose it; 1-3 index palette entry A/B/C. */
  paletteTint: number;
  glossMult: number;
  uvTiling: number;
  worn: LayerRef | null;
}

export interface LayerMaterial {
  path: string;
  diffuse: Float32Array;
  specular: Float32Array;
  shininess: number;
  metal: boolean;
  diffuseTex: string | null;
  normalTex: string | null;
  /** The layer's own `TexMod` tiling, multiplied into the reference's. */
  tileU: number;
}

export interface MaterialPayload {
  submaterials: Array<{
    name: string;
    shader: string;
    tintable: boolean;
    textures: Record<string, string>;
    layers: LayerRef[];
    /** The submaterial's own constants, linear. All a non-LayerBlend shader
     * has; ignored by the compositor. Absent on payloads from older cores. */
    diffuse?: Float32Array;
    specular?: Float32Array;
    emissive?: Float32Array;
    glow: number;
    opacity: number;
    alphaTest: number;
    /** 0-1. */
    shininess: number;
    /** Numeric `PublicParams`, for shaders other than LayerBlend: a number, or
     * a vector for a comma-separated value. Absent on older cores. */
    params?: Record<string, number | Float32Array>;
    /** `TexSlot9` where the shader is compiled with `%DECALS`, else null. */
    decalSheet?: string | null;
  }>;
  /** Every distinct detail layer the piece references, by lowercased path. */
  library: Record<string, LayerMaterial>;
}

export interface TexturePayload {
  path: string;
  width: number;
  height: number;
  rgba: Uint8Array;
}

export interface PosePayload {
  clip: string;
  /** Rotation deltas in the archive frame, `[w, x, y, z]`, for a rig whose
   * bone frames no longer match the clip's. */
  bones: Array<{ name: string; root: boolean; delta: Float32Array }>;
  /** The clip's own local rotations, `[w, x, y, z]`, which apply directly to a
   * rig built from the same `.chr` the clip targets. */
  locals: Array<{ name: string; rotation: Float32Array | null; position: Float32Array | null }>;
  /** How many of our bones the clip actually animates. */
  animated: number;
  clipBones: number;
}

/** A clip sampled at its own rate, for playing in a loop. */
export interface ClipPayload {
  fps: number;
  frames: number;
  /** The rig bones the clip animates, the root left out. */
  bones: string[];
  /** `frames x bones x 4`, local rotations `[w, x, y, z]` in the archive's
   * frame -- the same as `PosePayload.locals`. */
  rotations: Float32Array;
}

export interface PropPayload extends MeshPayload {
  /** The prop's own space mapped onto its socket bone: row-major 3x4, in the
   * archive's Z-up frame. Null when no locator was found. */
  mount: Float32Array | null;
  /** Where the grips land once mounted. These, not the bounding box, are what
   * tell a pack mounted backwards from one mounted correctly. */
  grips: { left?: Float32Array; right?: Float32Array };
  helpers: string[];
  /** Where each helper node sits, in the prop's own space, row-major 3x4. A
   * backpack's `wep_stocked_attach_*_override` nodes are where rifles hang. */
  helperTransforms?: Record<string, Float32Array>;
}

/** A player's face, blended. CHARACTER.md. */
export interface CharacterFace {
  readonly body: 'male' | 'female';
  /** The protos head and eyes, skinned as the figure's, with every vertex
   * blended from the library. */
  readonly head: MeshPayload;
  readonly eyes: MeshPayload;
  /** The library heads the face drew on, and any it wanted that this build
   * ships no mesh for. */
  readonly heads: string[];
  readonly missing: string[];
}

export interface MeshPayload {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  joints: Uint16Array;
  weights: Float32Array;
  /** The fifth to eighth influences, where the mesh uses more than four.
   * RENDERING.md Phase 7. */
  joints1?: Uint16Array;
  weights1?: Float32Array;
  /** u,v per vertex into the decal sheet, decoded from the vertex colour.
   * Absent on a mesh with no decal. */
  decalUvs?: Float32Array;
  bones: string[];
  /** `zone` names a character mesh's body zone where the core knows it;
   * `zoneWord` is the mesh's own word for it, named or not. CLOTHING.md. */
  submeshes: Array<{ materialId: number; start: number; count: number; zone?: string; zoneWord?: number }>;
  materialFile: string | null;
  /** Null when the mesh was loaded without a rig. */
  rebind: { mapped: number; stray: number; redistributed: number; inherited?: number; guessed: number } | null;
  min: Float32Array;
  max: Float32Array;
  unweighted: number;
  /** The attachment points this piece re-declares, from its own skeleton.
   * Archive frame, parent-relative. Absent for a rigid prop. */
  overrides?: AttachmentOverride[];
}

/** A gear item, in its own space: parts to draw, helpers by name, and the
 * mount for the locator asked for. Transforms are row-major 3x4, archive frame. */
export interface GearPayload {
  parts: Array<{ name: string; material: string | null; mesh: MeshPayload }>;
  helpers: Record<string, Float32Array>;
  mount: Float32Array | null;
}

export interface AttachmentOverride {
  name: string;
  parent: string | null;
  position: Float32Array;
  /** `[w, x, y, z]`. */
  rotation: Float32Array;
  world: Float32Array;
}

export type FromWorker = (
  | { type: 'progress'; step: IndexStep; fraction: number }
  | { type: 'indexed'; entryCount: number; fingerprint: string; ms: number }
  | { type: 'catalogue'; json: string; itemCount: number; ms: number }
  | { type: 'stats'; reads: number; fetched: number }
  | { type: 'mesh'; path: string; mesh: MeshPayload; ms: number }
  | { type: 'character'; face: CharacterFace; ms: number }
  | { type: 'rig'; summary: RigSummary; bones: RigBone[]; ms: number }
  | { type: 'material'; path: string; material: MaterialPayload; ms: number }
  | { type: 'texture'; texture: TexturePayload | null; ms: number; reads: number; fetched: number }
  | { type: 'prop'; path: string; prop: PropPayload; ms: number }
  | { type: 'pose'; pose: PosePayload; ms: number }
  | { type: 'clip'; clip: ClipPayload; ms: number }
  | { type: 'discovered'; path: string | null }
  | { type: 'gear'; path: string; gear: GearPayload; ms: number }
  | { type: 'probe'; path: string; size: number; rgba: Float32Array; ms: number }
  | { type: 'blocks'; path: string; blocks: { width: number; height: number; mips: Uint8Array[] } | null }
  | { type: 'lights'; lights: RigLight[] }
  | { type: 'failed'; message: string }
) & { id?: number };

const scope = self as unknown as DedicatedWorkerGlobalScope;

function say(message: FromWorker): void {
  scope.postMessage(message);
}

/** Where the work goes, as a fraction of the whole, so the bar moves at a rate
 * that matches what is happening rather than jumping at step boundaries.
 * Measured in the Phase 0 spike: indexing 8.3s, the DataCore read 1.2s and its
 * parse 0.1s, against a catalogue build of about 4s. */
const WEIGHTS: Record<IndexStep, number> = {
  'reading archive index': 0.55,
  'reading item database': 0.15,
  'item names': 0.25,
  'skeleton and poses': 0.05,
};

const ORDER: IndexStep[] = [
  'reading archive index',
  'reading item database',
  'item names',
  'skeleton and poses',
];

function progress(step: IndexStep, within = 0): void {
  const before = ORDER.slice(0, ORDER.indexOf(step)).reduce((sum, s) => sum + WEIGHTS[s], 0);
  say({ type: 'progress', step, fraction: Math.min(1, before + WEIGHTS[step] * within) });
}

/** A synchronous range reader over a `File`. The production path. */
function fileReader(file: File): (offset: number, length: number) => Uint8Array {
  const sync = new FileReaderSync();
  return (offset, length) => {
    const slice = file.slice(offset, offset + length);
    return new Uint8Array(sync.readAsArrayBuffer(slice));
  };
}

/** A synchronous range reader over HTTP, for verification.
 *
 * Synchronous `XMLHttpRequest` is permitted in a worker, which is what makes
 * this possible at all. It exists so the whole browser path can be run against
 * the real 158 GB archive on a machine that cannot produce a drag-and-drop --
 * the archive is on a volume, not in a picker. The bytes and the wasm are the
 * same; only where the range comes from differs.
 */
function urlReader(url: string): (offset: number, length: number) => Uint8Array {
  return (offset, length) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    // A synchronous XHR may set `responseType` in a worker, though not in a
    // document. It matters here: indexing this archive pulls 442 MB in two
    // reads, and the `charset=x-user-defined` text trick would build a
    // 440-million-character string and then walk it one `charCodeAt` at a
    // time.
    try {
      xhr.responseType = 'arraybuffer';
    } catch {
      xhr.overrideMimeType('text/plain; charset=x-user-defined');
    }
    xhr.setRequestHeader('Range', `bytes=${offset}-${offset + length - 1}`);
    xhr.send();
    if (xhr.status !== 206 && xhr.status !== 200) {
      throw new Error(`range request failed: ${xhr.status}`);
    }
    if (xhr.response instanceof ArrayBuffer) {
      return new Uint8Array(xhr.response);
    }
    const text = xhr.responseText;
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
    return out;
  };
}

/** The archive stays open between messages: re-indexing 1.37 M entries for
 * every mesh would cost 15 seconds each. */
/** Range reads and bytes, across the session. The texture path reports these
 * because a split DDS gathers its mip streams from sibling entries, and in the
 * HTTP harness each of those is a round trip -- which is a property of the
 * harness, not of the production `FileReaderSync` path. */
let reads = 0;
let fetched = 0;

let opened: {
  archive: {
    find(path: string): number | undefined | null;
    read(index: number): Uint8Array;
    loadMesh(path: string): unknown;
    buildRig(base: string, donors: string[]): unknown;
    rigBones(): unknown;
    loadMaterial(path: string): unknown;
    loadProp(path: string, socket: string): unknown;
    retargetPose(path: string, clip: string): unknown;
    sampleClip(path: string, clip: string): unknown;
    loadTexture(path: string, mip: number): [number, number, Uint8Array];
    loadTextureAlpha(path: string, mip: number): [number, number, Uint8Array];
    textureBlocks(path: string, maxSize: number): [number, number, ...Uint8Array[]];
    textureSizes(path: string): Uint32Array;
    discoverMaterial(className: string, meshPath: string, meshMaterial?: string): string | undefined;
    loadGear(path: string, locator: string): unknown;
    cubeHdr(path: string, maxSize: number): [number, Float32Array];
    lightRig(socpak: string, group: string): string;
    characterFace(chf: Uint8Array): unknown;
  };
  /** Built catalogues, by body type.
   *
   * The DataCore is 316 MB and is not kept, but the catalogue it produces is
   * a few MB of JSON -- so the first switch to a body pays for the read and
   * every switch after it is free. Measured before this: 11.5s out and 8.3s
   * back, nearly all of it re-reading the same DCB. */
  catalogues: Map<'male' | 'female', { json: string; itemCount: number }>;
} | undefined;

/** Read the DataCore and the localization file, build a catalogue, report it.
 *
 * Shared by opening an archive and by switching body type. The DCB is 316 MB
 * and is deliberately **not** kept between calls: re-reading it costs a couple
 * of seconds where holding it costs that much memory for the whole session,
 * and a body switch is a rare, deliberate act.
 */
function reportCatalogue(
  archive: NonNullable<typeof opened>['archive'],
  skeleton: 'male' | 'female',
  cache?: NonNullable<typeof opened>['catalogues'],
  out: (message: FromWorker) => void = say,
): void {
  const started = performance.now();

  const hit = cache?.get(skeleton);
  if (hit) {
    progress('skeleton and poses', 1);
    out({ type: 'catalogue', json: hit.json, itemCount: hit.itemCount, ms: performance.now() - started });
    return;
  }

  progress('reading item database');
  const dcbIndex = archive.find('Data\\Game2.dcb');
  if (dcbIndex === undefined || dcbIndex === null) {
    out({ type: 'failed', message: 'Data\\Game2.dcb is not in this archive' });
    return;
  }
  const dcb = archive.read(dcbIndex);
  progress('reading item database', 1);

  progress('item names');
  const iniIndex = archive.find('Data\\Localization\\english\\global.ini');
  if (iniIndex === undefined || iniIndex === null) {
    out({ type: 'failed', message: 'the English localization file is not in this archive' });
    return;
  }
  const ini = new TextDecoder('utf-8').decode(archive.read(iniIndex));
  progress('item names', 0.4);

  const json = wasm.buildCatalogue(dcb, ini, skeleton);
  const itemCount = (JSON.parse(json) as { items: unknown[] }).items.length;
  cache?.set(skeleton, { json, itemCount });
  progress('skeleton and poses', 1);
  out({ type: 'catalogue', json, itemCount, ms: performance.now() - started });
}

async function run(message: ToWorker): Promise<void> {
  // Answers to a request carry its id; progress and stats do not.
  const reply = (answer: FromWorker) => say({ ...answer, id: message.id } as FromWorker);

  if (message.type === 'catalogue') {
    if (!opened) {
      reply({ type: 'failed', message: 'no archive is open' });
      return;
    }
    reportCatalogue(opened.archive, message.skeleton, opened.catalogues, reply);
    say({ type: 'stats', reads, fetched });
    return;
  }

  if (message.type === 'rig') {
    if (!opened) {
      reply({ type: 'failed', message: 'no archive is open' });
      return;
    }
    const started = performance.now();
    const summary = opened.archive.buildRig(message.base, message.donors) as RigSummary;
    const bones = opened.archive.rigBones() as RigBone[];
    reply({ type: 'rig', summary, bones, ms: performance.now() - started });
    return;
  }

  if (message.type === 'pose') {
    if (!opened) {
      reply({ type: 'failed', message: 'no archive is open' });
      return;
    }
    const started = performance.now();
    const pose = opened.archive.retargetPose(message.path, message.clip) as PosePayload;
    reply({ type: 'pose', pose, ms: performance.now() - started });
    return;
  }

  if (message.type === 'clip') {
    if (!opened) {
      reply({ type: 'failed', message: 'no archive is open' });
      return;
    }
    const started = performance.now();
    const clip = opened.archive.sampleClip(message.path, message.clip) as ClipPayload;
    reply({ type: 'clip', clip, ms: performance.now() - started });
    return;
  }

  if (message.type === 'prop') {
    if (!opened) {
      reply({ type: 'failed', message: 'no archive is open' });
      return;
    }
    const started = performance.now();
    const prop = opened.archive.loadProp(message.path, message.socket) as PropPayload;
    reply({ type: 'prop', path: message.path, prop, ms: performance.now() - started });
    return;
  }

  if (message.type === 'material') {
    if (!opened) {
      reply({ type: 'failed', message: 'no archive is open' });
      return;
    }
    const started = performance.now();
    const material = opened.archive.loadMaterial(message.path) as MaterialPayload;
    reply({ type: 'material', path: message.path, material, ms: performance.now() - started });
    return;
  }

  if (message.type === 'texture') {
    if (!opened) {
      reply({ type: 'failed', message: 'no archive is open' });
      return;
    }
    const started = performance.now();
    try {
      // Pick the largest mip that fits the cap, from the *header*. Choosing it
      // by decoding candidates costs a full BC decode per try, and mip 0 of a
      // control map is routinely 2048 -- so asking for 512 cost more than
      // taking the 2048 would have.
      const sizes = opened.archive.textureSizes(message.path);
      let mip = 0;
      while ((mip + 1) * 2 < sizes.length && sizes[mip * 2]! > message.maxSize) {
        mip += 1;
      }
      const [w, h, rgba] = message.alpha
        ? opened.archive.loadTextureAlpha(message.path, mip)
        : opened.archive.loadTexture(message.path, mip);
      reply({
        type: 'texture',
        texture: { path: message.path, width: w, height: h, rgba },
        ms: performance.now() - started,
        reads,
        fetched,
      });
    } catch {
      // A texture that will not decode is not fatal: the surface falls back.
      reply({ type: 'texture', texture: null, ms: performance.now() - started, reads, fetched });
    }
    return;
  }

  if (message.type === 'blocks') {
    if (!opened) {
      reply({ type: 'failed', message: 'no archive is open' });
      return;
    }
    try {
      const [width, height, ...mips] = opened.archive.textureBlocks(message.path, message.maxSize);
      reply({ type: 'blocks', path: message.path, blocks: { width, height, mips } });
    } catch {
      // Not BC1, or missing: the caller decodes instead.
      reply({ type: 'blocks', path: message.path, blocks: null });
    }
    return;
  }

  if (message.type === 'gear') {
    if (!opened) {
      reply({ type: 'failed', message: 'no archive is open' });
      return;
    }
    const started = performance.now();
    const gear = opened.archive.loadGear(message.path, message.locator) as GearPayload;
    reply({ type: 'gear', path: message.path, gear, ms: performance.now() - started });
    return;
  }

  if (message.type === 'probe') {
    if (!opened) {
      reply({ type: 'failed', message: 'no archive is open' });
      return;
    }
    const started = performance.now();
    const [size, rgba] = opened.archive.cubeHdr(message.path, message.maxSize);
    reply({ type: 'probe', path: message.path, size, rgba, ms: performance.now() - started });
    return;
  }

  if (message.type === 'lights') {
    if (!opened) {
      reply({ type: 'failed', message: 'no archive is open' });
      return;
    }
    const lights = JSON.parse(opened.archive.lightRig(message.socpak, message.group)) as RigLight[];
    reply({ type: 'lights', lights });
    return;
  }

  if (message.type === 'discover') {
    if (!opened) {
      reply({ type: 'failed', message: 'no archive is open' });
      return;
    }
    const path = opened.archive.discoverMaterial(
      message.className, message.meshPath, message.meshMaterial ?? undefined,
    );
    reply({ type: 'discovered', path: path ?? null });
    return;
  }

  if (message.type === 'character') {
    if (!opened) {
      reply({ type: 'failed', message: 'no archive is open' });
      return;
    }
    const started = performance.now();
    const face = opened.archive.characterFace(message.chf) as CharacterFace;
    reply({ type: 'character', face, ms: performance.now() - started });
    return;
  }
  if (message.type === 'mesh') {
    if (!opened) {
      reply({ type: 'failed', message: 'no archive is open' });
      return;
    }
    const started = performance.now();
    const mesh = opened.archive.loadMesh(message.path) as MeshPayload;
    reply({ type: 'mesh', path: message.path, mesh, ms: performance.now() - started });
    return;
  }
  // An explicit URL where the caller gave one. wasm-bindgen's glue defaults to
  // `new URL('..._bg.wasm', import.meta.url)`, which is right when the worker
  // is a real module served from a real path and wrong when it is a blob.
  //
  // Only the *instantiation* is lazy. The glue is a static import at module
  // scope (see the top of this file) because a dynamic one makes Rollup split
  // it into its own chunk, which the published worker -- a blob -- then cannot
  // resolve: `import('./fashionworks_core-<hash>.js')` from a blob URL is a
  // fetch against nothing. Statically imported, it rides inside the worker.
  await wasm.default(message.coreUrl ? message.coreUrl : undefined);

  const skeleton = message.skeleton;
  const base = message.type === 'open' || message.type === 'open-url'
    ? (message.type === 'open' ? fileReader(message.file) : urlReader(message.url))
    : (() => { throw new Error('unreachable'); })();
  const read = (offset: number, length: number) => {
    reads += 1;
    fetched += length;
    return base(offset, length);
  };
  const byteLength = message.type === 'open' ? message.file.size : message.byteLength;

  progress('reading archive index');
  let started = performance.now();
  const archive = new wasm.Archive(read, byteLength);
  opened = {
    archive: archive as unknown as NonNullable<typeof opened>['archive'],
    catalogues: new Map(),
  };
  const entryCount = archive.entryCount();
  const fingerprint = archive.fingerprint();
  say({ type: 'indexed', entryCount, fingerprint, ms: performance.now() - started });
  say({ type: 'stats', reads, fetched });

  if (message.catalogue === false) {
    return;
  }

  reportCatalogue(opened.archive, skeleton, opened.catalogues);
  say({ type: 'stats', reads, fetched });
}

scope.onmessage = (event: MessageEvent<ToWorker>) => {
  run(event.data).catch((error: unknown) => {
    // Scoped to the request that failed, when there was one. Only a failure
    // with no id -- opening the archive -- is the worker's own.
    say({
      type: 'failed',
      message: error instanceof Error ? error.message : String(error),
      id: event.data.id,
    });
  });
};
