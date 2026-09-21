/** The piece cache: decoded geometry and textures, under a byte budget.
 *
 * The viewer already learned this lesson once. `three/gltfCache.ts` exists
 * because `useGLTF` never releases anything: on real assets the first sight of
 * an item costs 13.6 MB and keeps it, the catalogue has 471 distinct GLBs
 * averaging 7.3 MB, and browsing them all wants about 6.4 GB against a 4.19 GB
 * tab limit -- so the tab dies around two thirds of the way through. A cache
 * with no ceiling is a leak with a nicer name.
 *
 * On disk the failure is slower but worse, because it survives the reload. So
 * this has a cap from the start, evicting least-recently-used, and the cap is
 * something the visitor can see and change.
 *
 * Backed by the Origin Private File System: real files, no quota prompt beyond
 * the origin's own, and fast random access. Its absence is a warning, not a
 * blocker -- without it every piece is re-read from the archive, which is
 * slower and still correct.
 */

export interface CacheEntry {
  readonly key: string;
  readonly bytes: number;
  /** `Date.now()` of the last read or write. */
  readonly used: number;
}

interface Index {
  version: number;
  entries: Record<string, { bytes: number; used: number }>;
}

const INDEX_FILE = 'index.json';
const INDEX_VERSION = 1;
const DATA_DIR = 'pieces';

/** How long a touch-on-read waits before the index is written. Long enough to
 * fold a burst of browsing into one write, short enough that a visitor closing
 * the tab loses at most this much eviction ordering. */
const TOUCH_DEBOUNCE_MS = 1000;

/** Characters a key may contain once encoded. OPFS names are more permissive
 * than this, but a cache key here is derived from an archive path with
 * backslashes and colons in it, and those are worth not finding out about in
 * one browser only. */
function encodeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, (c) => `_${c.charCodeAt(0).toString(16)}`);
}

export class PieceCache {
  private index: Index = { version: INDEX_VERSION, entries: {} };

  private constructor(
    private readonly root: FileSystemDirectoryHandle,
    private data: FileSystemDirectoryHandle,
    private cap: number,
  ) {}

  /** Open the cache, or return `undefined` where OPFS is unavailable.
   *
   * Undefined rather than throwing: every caller's fallback is the same, to
   * read from the archive instead, and a cache is never load-bearing.
   */
  static async open(cap: number): Promise<PieceCache | undefined> {
    try {
      if (!navigator.storage?.getDirectory) return undefined;
      const root = await navigator.storage.getDirectory();
      const data = await root.getDirectoryHandle(DATA_DIR, { create: true });
      const cache = new PieceCache(root, data, cap);
      await cache.loadIndex();
      return cache;
    } catch {
      return undefined;
    }
  }

  private async loadIndex(): Promise<void> {
    try {
      await this.writes;
      const handle = await this.root.getFileHandle(INDEX_FILE);
      const file = await handle.getFile();
      const parsed = JSON.parse(await file.text()) as Index;
      if (parsed.version === INDEX_VERSION && parsed.entries) {
        this.index = parsed;
        return;
      }
    } catch {
      // No index, or an unreadable one. Either way the files on disk are of
      // unknown provenance, so they are dropped rather than adopted: an entry
      // whose size we do not know cannot be kept under a byte budget.
    }
    await this.clear();
  }

  /** Index writes, serialised.
   *
   * **Never call `writeIndex` directly.** `createWritable` truncates the file
   * and commits on `close`, so two overlapping writes -- or a write overlapping
   * the read in `loadIndex` -- can leave a half-written file. `JSON.parse` then
   * throws, and `loadIndex` responds to an unreadable index by clearing the
   * cache, because it cannot budget entries whose sizes it does not know.
   *
   * That combination is destructive out of proportion to its cause: a visitor
   * clicking through pieces quickly fires a touch-on-read write per piece, and
   * one of those landing across a reopen throws away everything they had
   * cached. It was found by the browser check, not by the unit tests -- no fake
   * reproduces it, because the behaviour being tested is the file system's.
   */
  private writes: Promise<void> = Promise.resolve();
  private touchTimer: ReturnType<typeof setTimeout> | undefined;

  private saveIndex(): Promise<void> {
    this.writes = this.writes.then(() => this.writeIndex()).catch(() => undefined);
    return this.writes;
  }

  private async writeIndex(): Promise<void> {
    try {
      const handle = await this.root.getFileHandle(INDEX_FILE, { create: true });
      const writable = await handle.createWritable();
      await writable.write(JSON.stringify(this.index));
      await writable.close();
    } catch {
      // A failed index write means the next visit re-reads from the archive.
      // Not worth failing a piece load over.
    }
  }

  /** Note that the index changed, without writing immediately. */
  private touch(): void {
    if (this.touchTimer !== undefined) return;
    this.touchTimer = setTimeout(() => {
      this.touchTimer = undefined;
      void this.saveIndex();
    }, TOUCH_DEBOUNCE_MS);
  }

  /** Wait for every queued index write to land.
   *
   * The caller needs this before reopening the cache, and before telling the
   * visitor their cache is safe to navigate away from.
   */
  async flush(): Promise<void> {
    if (this.touchTimer !== undefined) {
      clearTimeout(this.touchTimer);
      this.touchTimer = undefined;
      void this.saveIndex();
    }
    await this.writes;
  }

  get bytes(): number {
    return Object.values(this.index.entries).reduce((sum, e) => sum + e.bytes, 0);
  }

  get count(): number {
    return Object.keys(this.index.entries).length;
  }

  get capacity(): number {
    return this.cap;
  }

  entries(): CacheEntry[] {
    return Object.entries(this.index.entries)
      .map(([key, e]) => ({ key, bytes: e.bytes, used: e.used }))
      .sort((a, b) => b.used - a.used);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const entry = this.index.entries[key];
    if (!entry) return undefined;
    try {
      const handle = await this.data.getFileHandle(encodeKey(key));
      const file = await handle.getFile();
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Touch on read: that is what makes this least-recently-*used* rather
      // than least-recently-written, and the difference matters for a visitor
      // who keeps returning to one favourite set.
      //
      // The write is coalesced. Browsing a slot fires one of these per piece,
      // and a timestamp is not worth a file write each time -- losing the most
      // recent few on a crash costs nothing but eviction order.
      entry.used = Date.now();
      this.touch();
      return bytes;
    } catch {
      // The index says it is there and it is not. Forget it and move on.
      delete this.index.entries[key];
      this.touch();
      return undefined;
    }
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    // A single item larger than the whole budget would evict everything and
    // then not fit. Refuse it instead of thrashing.
    if (bytes.byteLength > this.cap) return;
    try {
      const handle = await this.data.getFileHandle(encodeKey(key), { create: true });
      const writable = await handle.createWritable();
      // `write` wants an ArrayBuffer-backed view, and a Uint8Array may sit over
      // a SharedArrayBuffer, which is not one. The copy is what makes the type
      // honest rather than asserted away.
      await writable.write(bytes.slice().buffer as ArrayBuffer);
      await writable.close();
      this.index.entries[key] = { bytes: bytes.byteLength, used: Date.now() };
      await this.evictTo(this.cap);
      await this.saveIndex();
    } catch {
      // Out of quota, or the directory vanished. The piece still renders; it
      // just will not be there next time.
    }
  }

  /** Drop least-recently-used entries until the total fits `limit`. */
  async evictTo(limit: number): Promise<number> {
    let freed = 0;
    const order = Object.entries(this.index.entries).sort((a, b) => a[1].used - b[1].used);
    let total = this.bytes;
    for (const [key, entry] of order) {
      if (total <= limit) break;
      try {
        await this.data.removeEntry(encodeKey(key));
      } catch {
        // Already gone; dropping it from the index is still right.
      }
      delete this.index.entries[key];
      total -= entry.bytes;
      freed += entry.bytes;
    }
    return freed;
  }

  async setCap(cap: number): Promise<void> {
    this.cap = cap;
    await this.evictTo(cap);
    await this.saveIndex();
  }

  async clear(): Promise<void> {
    try {
      await this.root.removeEntry(DATA_DIR, { recursive: true });
    } catch {
      // Nothing there.
    }
    // The directory has to be re-made and the handle replaced. Removing it
    // leaves `this.data` pointing at something that no longer exists, and every
    // later `put` then throws into its own catch and silently caches nothing --
    // a cache that works until the visitor uses "Clear cache" once, and never
    // again until they reload.
    try {
      this.data = await this.root.getDirectoryHandle(DATA_DIR, { create: true });
    } catch {
      // Storage has gone away entirely; reads and writes will no-op.
    }
    this.index = { version: INDEX_VERSION, entries: {} };
    await this.saveIndex();
  }
}
