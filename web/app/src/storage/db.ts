/** What survives between visits: the catalogue, the settings, the file handle.
 *
 * Keyed by the archive's fingerprint, so a game patch does not quietly serve a
 * stale catalogue and a visitor who switches between LIVE and PTU keeps both.
 *
 * **Not `localStorage`.** Its 5 MB is shared with the whole origin, and
 * Hangarworks already stores its blueprint cache (`sc_scmdb_cache_v2`) there. A
 * catalogue is megabytes of JSON; putting it in `localStorage` would evict the
 * site's own data.
 */

const DB_NAME = 'fashionworks';
const DB_VERSION = 1;

export const STORE_CATALOGUE = 'catalogue';
export const STORE_SETTINGS = 'settings';
export const STORE_HANDLES = 'handles';

/** Bumped when the catalogue's shape changes.
 *
 * This is the same discipline as `SCHEMA_VERSION` on the manifest, and for the
 * same reason: a stage that adds a field ships it under the old number, and the
 * reader then trusts data it cannot actually read. A cached catalogue whose
 * version does not match is discarded rather than migrated -- rebuilding costs
 * a couple of minutes and migration code costs forever.
 */
export const CATALOGUE_VERSION = 1;

export interface CachedCatalogue {
  /** The archive fingerprint this was built from. */
  readonly fingerprint: string;
  readonly version: number;
  readonly builtAt: number;
  readonly itemCount: number;
  /** The catalogue itself, as the build worker produced it. */
  readonly items: unknown;
  /** What the visitor called this install, e.g. "LIVE". */
  readonly channel?: string;
}

export interface Settings {
  /** Male or female skeleton. */
  bodyType: 'male' | 'female';
  /** Show armour worn, or as it left the factory. */
  wear: boolean;
  /** Bytes the piece cache may use. */
  cacheCap: number;
  channel: string;
  /** Fingerprint of the archive last used, for the update check. */
  lastFingerprint?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  bodyType: 'male',
  wear: true,
  cacheCap: 2 * 1024 ** 3,
  channel: 'LIVE',
};

export function open(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_CATALOGUE)) {
        db.createObjectStore(STORE_CATALOGUE, { keyPath: 'fingerprint' });
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS);
      }
      if (!db.objectStoreNames.contains(STORE_HANDLES)) {
        db.createObjectStore(STORE_HANDLES);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('could not open the database'));
  });
}

function run<T>(store: IDBObjectStore, request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('storage request failed'));
    store.transaction.onabort = () =>
      reject(store.transaction.error ?? new Error('storage transaction aborted'));
  });
}

export async function putCatalogue(db: IDBDatabase, entry: CachedCatalogue): Promise<void> {
  const tx = db.transaction(STORE_CATALOGUE, 'readwrite');
  const store = tx.objectStore(STORE_CATALOGUE);
  await run(store, store.put(entry));
}

/** The cached catalogue for a fingerprint, if it is still readable.
 *
 * Returns `undefined` rather than throwing for a version mismatch, because to
 * the caller "there is no usable cache" and "the cache is too old" lead to the
 * same place: rebuild it.
 */
export async function getCatalogue(
  db: IDBDatabase,
  fingerprint: string,
): Promise<CachedCatalogue | undefined> {
  const tx = db.transaction(STORE_CATALOGUE, 'readonly');
  const store = tx.objectStore(STORE_CATALOGUE);
  const found = await run(store, store.get(fingerprint) as IDBRequest<CachedCatalogue | undefined>);
  if (!found || found.version !== CATALOGUE_VERSION) return undefined;
  return found;
}

/** Every catalogue held, newest first. Shown in settings so a visitor can see
 * what is taking up space, and so switching channels is visible. */
export async function listCatalogues(db: IDBDatabase): Promise<CachedCatalogue[]> {
  const tx = db.transaction(STORE_CATALOGUE, 'readonly');
  const store = tx.objectStore(STORE_CATALOGUE);
  const all = await run(store, store.getAll() as IDBRequest<CachedCatalogue[]>);
  return all.sort((a, b) => b.builtAt - a.builtAt);
}

export async function deleteCatalogue(db: IDBDatabase, fingerprint: string): Promise<void> {
  const tx = db.transaction(STORE_CATALOGUE, 'readwrite');
  const store = tx.objectStore(STORE_CATALOGUE);
  await run(store, store.delete(fingerprint));
}

export async function getSettings(db: IDBDatabase): Promise<Settings> {
  const tx = db.transaction(STORE_SETTINGS, 'readonly');
  const store = tx.objectStore(STORE_SETTINGS);
  const found = await run(store, store.get('settings') as IDBRequest<Partial<Settings> | undefined>);
  // Merged rather than replaced, so a settings field added later has its
  // default instead of arriving undefined on every returning visitor.
  return { ...DEFAULT_SETTINGS, ...(found ?? {}) };
}

export async function putSettings(db: IDBDatabase, settings: Settings): Promise<void> {
  const tx = db.transaction(STORE_SETTINGS, 'readwrite');
  const store = tx.objectStore(STORE_SETTINGS);
  await run(store, store.put(settings, 'settings'));
}

/** Store the visitor's file handle, where the browser has one.
 *
 * Chrome and Edge only, and **useless on a default install**: Chromium refuses
 * every File System Access picker under Program Files, which is where Star
 * Citizen installs. Worth doing for visitors with the game on another drive,
 * never worth designing the flow around.
 */
export async function putHandle(db: IDBDatabase, key: string, handle: unknown): Promise<void> {
  const tx = db.transaction(STORE_HANDLES, 'readwrite');
  const store = tx.objectStore(STORE_HANDLES);
  await run(store, store.put(handle, key));
}

export async function getHandle(db: IDBDatabase, key: string): Promise<unknown | undefined> {
  const tx = db.transaction(STORE_HANDLES, 'readonly');
  const store = tx.objectStore(STORE_HANDLES);
  return run(store, store.get(key) as IDBRequest<unknown | undefined>);
}
