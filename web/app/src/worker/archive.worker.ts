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

export type ToWorker =
  | { type: 'open'; file: File; skeleton: 'male' | 'female'; catalogue?: boolean }
  /** For verification only: read ranges over HTTP instead of from a File. */
  | {
      type: 'open-url';
      url: string;
      byteLength: number;
      skeleton: 'male' | 'female';
      /** Skip the DataCore parse. A page drawing one mesh does not need it. */
      catalogue?: boolean;
    }
  /** Load one mesh from the already-open archive. */
  | { type: 'mesh'; path: string }
  /** Build the canonical armature before any mesh is loaded. */
  | { type: 'rig'; base: string; donors: string[] };

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

export interface MeshPayload {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  joints: Uint16Array;
  weights: Float32Array;
  bones: string[];
  submeshes: Array<{ materialId: number; start: number; count: number }>;
  materialFile: string | null;
  /** Null when the mesh was loaded without a rig. */
  rebind: { mapped: number; stray: number; redistributed: number; guessed: number } | null;
  min: Float32Array;
  max: Float32Array;
  unweighted: number;
}

export type FromWorker =
  | { type: 'progress'; step: IndexStep; fraction: number }
  | { type: 'indexed'; entryCount: number; fingerprint: string; ms: number }
  | { type: 'catalogue'; json: string; itemCount: number; ms: number }
  | { type: 'stats'; reads: number; fetched: number }
  | { type: 'mesh'; path: string; mesh: MeshPayload; ms: number }
  | { type: 'rig'; summary: RigSummary; bones: RigBone[]; ms: number }
  | { type: 'failed'; message: string };

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
let opened: {
  archive: {
    loadMesh(path: string): unknown;
    buildRig(base: string, donors: string[]): unknown;
    rigBones(): unknown;
  };
} | undefined;

async function run(message: ToWorker): Promise<void> {
  if (message.type === 'rig') {
    if (!opened) {
      say({ type: 'failed', message: 'no archive is open' });
      return;
    }
    const started = performance.now();
    const summary = opened.archive.buildRig(message.base, message.donors) as RigSummary;
    const bones = opened.archive.rigBones() as RigBone[];
    say({ type: 'rig', summary, bones, ms: performance.now() - started });
    return;
  }

  if (message.type === 'mesh') {
    if (!opened) {
      say({ type: 'failed', message: 'no archive is open' });
      return;
    }
    const started = performance.now();
    const mesh = opened.archive.loadMesh(message.path) as MeshPayload;
    say({ type: 'mesh', path: message.path, mesh, ms: performance.now() - started });
    return;
  }
  // The wasm is loaded here rather than at module scope so a worker that is
  // spun up and never used costs nothing.
  const wasm = await import('../../../core/pkg/fashionworks_core.js');
  await wasm.default();

  const skeleton = message.skeleton;
  let reads = 0;
  let fetched = 0;
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
  opened = { archive: archive as unknown as NonNullable<typeof opened>['archive'] };
  const entryCount = archive.entryCount();
  const fingerprint = archive.fingerprint();
  say({ type: 'indexed', entryCount, fingerprint, ms: performance.now() - started });
  say({ type: 'stats', reads, fetched });

  if (message.catalogue === false) {
    return;
  }

  progress('reading item database');
  started = performance.now();
  const dcbIndex = archive.find('Data\\Game2.dcb');
  if (dcbIndex === undefined || dcbIndex === null) {
    say({ type: 'failed', message: 'Data\\Game2.dcb is not in this archive' });
    return;
  }
  const dcb = archive.read(dcbIndex);
  progress('reading item database', 1);

  progress('item names');
  const iniIndex = archive.find('Data\\Localization\\english\\global.ini');
  if (iniIndex === undefined || iniIndex === null) {
    say({ type: 'failed', message: 'the English localization file is not in this archive' });
    return;
  }
  const ini = new TextDecoder('utf-8').decode(archive.read(iniIndex));
  progress('item names', 0.4);

  const json = wasm.buildCatalogue(dcb, ini, skeleton);
  const itemCount = (JSON.parse(json) as { items: unknown[] }).items.length;
  progress('skeleton and poses', 1);
  say({ type: 'catalogue', json, itemCount, ms: performance.now() - started });
  say({ type: 'stats', reads, fetched });
}

scope.onmessage = (event: MessageEvent<ToWorker>) => {
  run(event.data).catch((error: unknown) => {
    say({ type: 'failed', message: error instanceof Error ? error.message : String(error) });
  });
};
