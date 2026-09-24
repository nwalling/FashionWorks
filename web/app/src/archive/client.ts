/** The archive worker, as the package ships it.
 *
 * This module is the thing that was missing. `archive.worker.ts` has always
 * been complete, and `onboarding.ts` has always had the events it emits, but
 * nothing constructed one: the worker was reachable from `index.ts` only
 * through `import type`, which the bundler erases, so the published package
 * contained no worker and no WebAssembly at all and every dropped archive
 * stalled on the indexing screen forever.
 *
 * Two bundling decisions, both forced by this being a *library* rather than an
 * app, and both worth stating because the obvious alternatives fail quietly in
 * a consumer's build:
 *
 * **The worker is inlined.** `?worker&inline` bundles it to a self-contained
 * module and constructs it from a blob, so no consumer bundler has to resolve a
 * worker URL out of `node_modules`. The plain
 * `new Worker(new URL('./archive.worker.js', import.meta.url))` form depends on
 * the host's bundler reproducing a relative asset path from inside a dependency,
 * which webpack, Turbopack and Vite each do slightly differently.
 *
 * **The WebAssembly is not inlined.** It stays a separate asset, resolved here
 * and handed to the worker as an absolute URL. Inlining it would be simpler and
 * would merge two budgets the contract deliberately separates -- 400 KB brotli
 * for app JavaScript against 2 MB for the core -- and would put ~250 KB of
 * base64 into the main chunk. Resolving it on the main thread rather than
 * inside the worker is not a style choice either: a blob worker's
 * `import.meta.url` is the blob, so a relative URL resolved in there points at
 * nothing.
 */

import type { FromWorker, ToWorker } from '../worker/archive.worker';
// eslint-disable-next-line import/no-unresolved -- Vite's inline-worker import.
import ArchiveWorker from '../worker/archive.worker?worker&inline';

/** Where the core is, from wherever the host ended up putting this file.
 *
 * `new URL(..., import.meta.url)` is the one form webpack 5, Turbopack and Vite
 * all recognise as "emit this asset and rewrite the path", which is what gets
 * the `.wasm` into the host's build output at all.
 *
 * **Absolutised, and it has to be.** Vite hands back a full `http://…` URL, but
 * webpack rewrites the expression to its own asset module, which yields a
 * *root-relative* path — `/_next/static/media/fashionworks_core_bg.<hash>.wasm`
 * in a Next build. Handed to a blob worker that is a dead end: a blob URL has
 * an opaque path, so there is nothing for a leading `/` to resolve against, and
 * `fetch` rejects with "Failed to parse URL" before a byte is requested. The
 * archive would then hang on the indexing screen — the same symptom as shipping
 * no core at all, one step further in.
 *
 * Verified by experiment inside a real Next production build, because this is
 * invisible under Vite, where the URL is already absolute.
 */
export function coreUrl(): string {
  const resolved = new URL('./fashionworks_core_bg.wasm', import.meta.url).href;
  return typeof location === 'undefined' ? resolved : new URL(resolved, location.href).href;
}

export type Progress = Extract<FromWorker, { type: 'progress' }>;
export type Indexed = Extract<FromWorker, { type: 'indexed' }>;
export type Catalogue = Extract<FromWorker, { type: 'catalogue' }>;

export interface OpenResult {
  readonly fingerprint: string;
  readonly entryCount: number;
  readonly itemCount: number;
  readonly catalogueJson: string;
}

export interface OpenHandlers {
  readonly onProgress?: (progress: Progress) => void;
  /** Fires as soon as the central directory is read, before the catalogue. */
  readonly onIndexed?: (indexed: Indexed) => void;
}

/** A live worker. One per mounted component; `close` terminates it. */
export class ArchiveClient {
  private worker: Worker | null = null;

  private waiting = new Map<string, Array<(message: FromWorker) => void>>();

  /** Requests awaiting their own answer, by id. */
  private pending = new Map<number, (message: FromWorker) => void>();

  private nextId = 1;

  /** Set by the first `failed` message, and re-thrown at every pending waiter
   * so a failure surfaces as a rejection rather than as a hang. */
  private failure: string | null = null;

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const worker = new ArchiveWorker();
    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      // An answer to one request, success or failure, goes to that request
      // and nowhere else. A missing texture is that texture's problem.
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        waiter?.(message);
        return;
      }
      if (message.type === 'failed') {
        this.failure = message.message;
        // Every waiter, not just the matching one: nothing else is coming.
        for (const queue of this.waiting.values()) {
          for (const resolve of queue) resolve(message);
        }
        this.waiting.clear();
        for (const resolve of this.pending.values()) resolve(message);
        this.pending.clear();
        return;
      }
      this.waiting.get(message.type)?.shift()?.(message);
    };
    // An `error` event is a worker that failed to *load* -- a missing chunk, a
    // CSP that forbids blob workers. Without this it is a silent hang.
    worker.onerror = (event: ErrorEvent) => {
      this.failure = event.message || 'the archive worker could not start';
      for (const queue of this.waiting.values()) {
        for (const resolve of queue) {
          resolve({ type: 'failed', message: this.failure });
        }
      }
      this.waiting.clear();
      for (const resolve of this.pending.values()) resolve({ type: 'failed', message: this.failure });
      this.pending.clear();
    };
    this.worker = worker;
    return worker;
  }

  /** Wait for a message the worker sends unprompted. Registered *before* the
   * request that triggers it, because the catalogue arrives as part of opening
   * rather than in answer to its own request. */
  private expect<T extends FromWorker['type']>(
    type: T,
  ): Promise<Extract<FromWorker, { type: T }>> {
    if (this.failure) return Promise.reject(new Error(this.failure));
    return new Promise((resolve, reject) => {
      const queue = this.waiting.get(type) ?? [];
      queue.push((message) => {
        if (message.type === 'failed') reject(new Error(message.message));
        else resolve(message as Extract<FromWorker, { type: T }>);
      });
      this.waiting.set(type, queue);
    });
  }

  private send(message: ToWorker): void {
    this.ensure().postMessage(message);
  }

  /** Send a request and wait for *its* answer. */
  private request<T extends FromWorker['type']>(
    type: T,
    message: ToWorker,
  ): Promise<Extract<FromWorker, { type: T }>> {
    if (this.failure) return Promise.reject(new Error(this.failure));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (answer) => {
        if (answer.type === 'failed') reject(new Error(answer.message));
        else if (answer.type !== type) reject(new Error(`expected ${type}, got ${answer.type}`));
        else resolve(answer as Extract<FromWorker, { type: T }>);
      });
      this.send({ ...message, id });
    });
  }

  /** Open a dropped archive and build its catalogue.
   *
   * Progress and the index both arrive before this resolves, which is why they
   * are callbacks rather than part of the result: the visitor is watching a bar
   * for several seconds and the state machine has an event for each step.
   */
  async open(
    file: File,
    skeleton: 'male' | 'female' = 'male',
    handlers: OpenHandlers = {},
  ): Promise<OpenResult> {
    this.ensure();
    const indexed = this.expect('indexed');
    const catalogue = this.expect('catalogue');
    this.relayProgress(handlers.onProgress);
    this.send({ type: 'open', file, skeleton, catalogue: true, coreUrl: coreUrl() });

    const index = await indexed;
    handlers.onIndexed?.(index);
    const built = await catalogue;
    return {
      fingerprint: index.fingerprint,
      entryCount: index.entryCount,
      itemCount: built.itemCount,
      catalogueJson: built.json,
    };
  }

  /** Open an archive over HTTP byte ranges. **Verification only.**
   *
   * The production path is a dropped `File` read through `FileReaderSync`, and
   * this changes nothing about it: same worker, same core, same range protocol,
   * only a different source for the bytes. It exists because the archive on a
   * development machine lives on a mounted volume, and no automated check can
   * drive a native file picker — so without it the built package could only
   * ever be exercised against a fake.
   */
  async openUrl(
    url: string,
    byteLength: number,
    skeleton: 'male' | 'female' = 'male',
    handlers: OpenHandlers = {},
  ): Promise<OpenResult> {
    this.ensure();
    const indexed = this.expect('indexed');
    const catalogue = this.expect('catalogue');
    this.relayProgress(handlers.onProgress);
    this.send({
      type: 'open-url',
      // Absolute, always. The worker is a blob, and a blob URL is not
      // hierarchical, so resolving `/__p4k` against it throws "Invalid URL"
      // inside `XMLHttpRequest.open` rather than reaching the server. Same
      // reason `coreUrl` is resolved out here: nothing relative survives the
      // crossing into a blob worker.
      url: new URL(url, location.href).href,
      byteLength,
      skeleton,
      catalogue: true,
      coreUrl: coreUrl(),
    });

    const index = await indexed;
    handlers.onIndexed?.(index);
    const built = await catalogue;
    return {
      fingerprint: index.fingerprint,
      entryCount: index.entryCount,
      itemCount: built.itemCount,
      catalogueJson: built.json,
    };
  }

  /** Progress is a stream, not a single message, so it is relayed by patching
   * the queue rather than awaited. */
  private relayProgress(onProgress?: (progress: Progress) => void): void {
    if (!onProgress) return;
    const pump = () => {
      const queue = this.waiting.get('progress') ?? [];
      queue.push((message) => {
        if (message.type !== 'progress') return;
        onProgress(message);
        pump();
      });
      this.waiting.set('progress', queue);
    };
    pump();
  }

  /** Rebuild the catalogue for the other body type, over the open archive.
   *
   * Not a re-open: the DataCore item is the same for both, and only the mesh
   * the geometry tree selects differs. Takes a couple of seconds, because the
   * 316 MB DataCore is re-read rather than held in memory for a switch most
   * visitors make once or never.
   */
  async catalogue(skeleton: 'male' | 'female', onProgress?: (progress: Progress) => void) {
    this.ensure();
    this.relayProgress(onProgress);
    return this.request('catalogue', { type: 'catalogue', skeleton });
  }

  /** Build the canonical armature: the base skeleton plus the attachment bones
   * the donor pieces introduce. */
  async rig(base: string, donors: string[]) {
    return this.request('rig', { type: 'rig', base, donors });
  }

  async mesh(path: string) {
    return this.request('mesh', { type: 'mesh', path });
  }

  async material(path: string) {
    return this.request('material', { type: 'material', path });
  }

  async texture(path: string, maxSize: number) {
    return this.request('texture', { type: 'texture', path, maxSize });
  }

  async prop(path: string, socket: string) {
    return this.request('prop', { type: 'prop', path, socket });
  }

  async pose(path: string, clip: string) {
    return this.request('pose', { type: 'pose', path, clip });
  }

  /** A gear item's parts, helpers and mount. `locator` is the helper on the
   * item that meets the port's bone; empty for a held item. */
  async gear(path: string, locator = '') {
    return this.request('gear', { type: 'gear', path, locator });
  }

  /** A material for an item whose record names none: by class name, then by
   * the mesh. `null` when the archive has nothing plausible. */
  async discoverMaterial(className: string, meshPath: string, meshMaterial: string | null = null) {
    const answer = await this.request('discovered', {
      type: 'discover', className, meshPath, meshMaterial,
    });
    return answer.path;
  }

  /** An HDR lighting probe, decoded to linear float: six faces of `size`². */
  async probe(path: string, maxSize = 256) {
    return this.request('probe', { type: 'probe', path, maxSize });
  }

  /** The lights of one group in an object container. */
  async lightRig(socpak: string, group: string) {
    return (await this.request('lights', { type: 'lights', socpak, group })).lights;
  }

  close(): void {
    this.worker?.terminate();
    this.worker = null;
    this.waiting.clear();
    this.pending.clear();
    this.failure = null;
  }
}
