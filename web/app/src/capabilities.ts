/** What this browser can do, and what to say when it cannot.
 *
 * WEB.md's onboarding step 1: *"WebGL2 and WebAssembly are required. Everything
 * else only warns."* The split matters. A visitor whose browser cannot run the
 * tool should be told in one sentence, before they pick a 158 GB file; a
 * visitor missing something optional should not be stopped at all.
 *
 * Every probe is wrapped, because several of these throw rather than return
 * false in a locked-down browser: `navigator.storage` is absent over plain
 * HTTP, OPFS throws in a Firefox private window, and creating a WebGL context
 * can fail outright on a machine with no GPU driver.
 */

export type Severity = 'blocking' | 'warning';

export interface Capability {
  readonly name: string;
  readonly ok: boolean;
  readonly severity: Severity;
  /** Shown when `ok` is false. One sentence, and a way forward. */
  readonly remedy?: string;
}

export interface CapabilityReport {
  readonly capabilities: readonly Capability[];
  /** True when nothing blocking is missing. */
  readonly usable: boolean;
  readonly blocking: readonly Capability[];
  readonly warnings: readonly Capability[];
  /** Bytes available, when the browser will say. */
  readonly storageQuota?: number;
  readonly storageUsage?: number;
  /** Whether the browser promised not to evict our cache. */
  readonly persisted?: boolean;
  readonly mobile: boolean;
}

/** Enough free space to be worth starting. A catalogue plus a few sets. */
export const RECOMMENDED_BYTES = 2 * 1024 ** 3;

function probe(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
}

/** Whether a WebGL2 context can actually be created, not merely named.
 *
 * `'WebGL2RenderingContext' in window` is true on machines where creating the
 * context then fails, so the constructor is the only honest test.
 */
export function hasWebGL2(): boolean {
  return probe(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return false;
    // A software rasteriser will not run the LayerBlend shader at a useful
    // rate, but it does run it, so this is not a reason to block.
    canvas.width = 0;
    canvas.height = 0;
    return true;
  });
}

export function hasWebAssembly(): boolean {
  return probe(() => typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function');
}

/** Workers, and specifically `FileReaderSync` inside one.
 *
 * The Rust core reads byte ranges **synchronously**, and `FileReaderSync` is
 * the only synchronous file read a browser offers. It exists only in workers.
 * Without it there is no way to feed the archive to WebAssembly at all, so this
 * is as blocking as WebAssembly itself.
 */
export function hasWorkers(): boolean {
  return probe(() => typeof Worker === 'function');
}

export function hasFileReaderSync(): boolean {
  // Cannot be probed from the main thread -- the constructor is not defined
  // here even in browsers that have it. Every browser with Workers and
  // WebAssembly has had it for years, so its presence is inferred and then
  // confirmed by the worker on first use.
  return hasWorkers();
}

/** The Origin Private File System, where decoded geometry and textures live. */
export function hasOpfs(): boolean {
  return probe(() => typeof navigator !== 'undefined' && 'storage' in navigator
    && typeof navigator.storage?.getDirectory === 'function');
}

export function hasIndexedDb(): boolean {
  return probe(() => typeof indexedDB !== 'undefined');
}

/** A persistent handle to the file, so a return visit is one click.
 *
 * Chrome and Edge only, and **it does not help on a default install**:
 * Chromium's blocklist refuses every picker under Program Files, which is where
 * Star Citizen installs. So this is a convenience for visitors with the game on
 * another drive, never the primary path.
 */
export function hasFileSystemAccess(): boolean {
  return probe(() => typeof (globalThis as { showOpenFilePicker?: unknown }).showOpenFilePicker === 'function');
}

export function isMobile(): boolean {
  return probe(() => {
    const ua = navigator.userAgent;
    if (/Android|iPhone|iPad|iPod|Windows Phone/i.test(ua)) return true;
    // iPadOS reports a desktop UA; touch plus no hover is the giveaway.
    return navigator.maxTouchPoints > 1 && matchMedia('(hover: none)').matches;
  });
}

export async function storageEstimate(): Promise<{ quota?: number; usage?: number }> {
  try {
    if (!navigator.storage?.estimate) return {};
    const { quota, usage } = await navigator.storage.estimate();
    return { quota, usage };
  } catch {
    return {};
  }
}

/** Ask the browser not to evict the cache.
 *
 * Chrome grants this silently once the site is used; Firefox prompts. A refusal
 * is not an error -- it means a return visit may have to re-index.
 */
export async function requestPersistence(): Promise<boolean | undefined> {
  try {
    if (!navigator.storage?.persist) return undefined;
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return undefined;
  }
}

export async function checkCapabilities(): Promise<CapabilityReport> {
  const mobile = isMobile();
  const { quota, usage } = await storageEstimate();
  const persisted = await requestPersistence();

  const capabilities: Capability[] = [
    {
      name: 'WebAssembly',
      ok: hasWebAssembly(),
      severity: 'blocking',
      remedy: 'Update your browser, or turn WebAssembly back on if you disabled it.',
    },
    {
      name: 'WebGL2',
      ok: hasWebGL2(),
      severity: 'blocking',
      remedy: 'Turn on hardware acceleration in your browser settings, or update your graphics driver.',
    },
    {
      name: 'Background workers',
      ok: hasWorkers(),
      severity: 'blocking',
      remedy: 'Workers are blocked. This usually means a privacy extension; try a normal window.',
    },
    {
      name: 'Desktop browser',
      ok: !mobile,
      severity: 'blocking',
      remedy: 'Star Citizen is installed on a PC, and this tool reads those files directly, '
        + 'so it needs the same computer. Open this page on your desktop.',
    },
    {
      name: 'Saved catalogue',
      ok: hasIndexedDb(),
      severity: 'warning',
      remedy: 'Your catalogue cannot be saved, so it will be rebuilt on every visit. '
        + 'A private window usually causes this.',
    },
    {
      name: 'Cached pieces',
      ok: hasOpfs(),
      severity: 'warning',
      remedy: 'Armour pieces cannot be cached, so each one is re-read from your game files.',
    },
    {
      name: 'Quick reconnect',
      ok: hasFileSystemAccess(),
      severity: 'warning',
      remedy: 'Your browser cannot remember the file, so you will drop Data.p4k again next time. '
        + 'Chrome and Edge can remember it, unless the game is in Program Files.',
    },
    {
      name: 'Free space',
      // Only a warning when the browser actually told us, and told us it is low.
      ok: quota === undefined || quota - (usage ?? 0) >= RECOMMENDED_BYTES,
      severity: 'warning',
      remedy: 'Less than 2 GB free. The tool will work, but it will cache fewer pieces.',
    },
  ];

  const blocking = capabilities.filter((c) => !c.ok && c.severity === 'blocking');
  const warnings = capabilities.filter((c) => !c.ok && c.severity === 'warning');
  return {
    capabilities,
    usable: blocking.length === 0,
    blocking,
    warnings,
    storageQuota: quota,
    storageUsage: usage,
    persisted,
    mobile,
  };
}
