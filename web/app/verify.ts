/** The half of phase 4 that a headless test cannot reach.
 *
 * `vitest` covers the flow, the validation and IndexedDB, because all three are
 * either pure or have a faithful fake. The Origin Private File System has
 * neither: `fake-indexeddb` has no counterpart, and the behaviours that matter
 * here -- whether eviction really deletes files, whether a cleared directory
 * handle still works, whether a quota refusal throws or returns -- are exactly
 * the ones a fake would get wrong by construction.
 *
 * So this runs in a real browser and reports. Open it with `npm run verify`.
 */

import { checkCapabilities, RECOMMENDED_BYTES } from './src/capabilities';
import { PieceCache } from './src/storage/cache';

const out = document.getElementById('out') as HTMLPreElement;
const lines: string[] = [];
let failures = 0;

function say(line = ''): void {
  lines.push(line);
  out.textContent = lines.join('\n');
}

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  say(`  ${ok ? '✓' : '✗'} ${label}${detail ? `   ${detail}` : ''}`);
}

function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(1)} KB`;
}

const block = (n: number, fill: number) => new Uint8Array(n).fill(fill);

async function capabilities(): Promise<void> {
  say('CAPABILITIES');
  const report = await checkCapabilities();
  for (const c of report.capabilities) {
    say(`  ${c.ok ? '✓' : '✗'} ${c.name.padEnd(20)} ${c.ok ? '' : `(${c.severity}) ${c.remedy ?? ''}`}`);
  }
  say(`  usable: ${report.usable}`);
  if (report.storageQuota !== undefined) {
    const free = report.storageQuota - (report.storageUsage ?? 0);
    say(`  quota ${bytes(report.storageQuota)}, used ${bytes(report.storageUsage ?? 0)}, `
      + `free ${bytes(free)} (want ${bytes(RECOMMENDED_BYTES)})`);
  } else {
    say('  the browser would not report a quota');
  }
  say(`  persisted: ${report.persisted}`);
  say();
}

async function cache(): Promise<void> {
  say('PIECE CACHE (OPFS)');
  const cap = 300 * 1024;
  const c = await PieceCache.open(cap);
  if (!c) {
    check('OPFS available', false, 'cannot verify the cache in this browser');
    say();
    return;
  }
  await c.clear();

  // Round trip.
  await c.put('Data\\a\\one.glb', block(100 * 1024, 1));
  const got = await c.get('Data\\a\\one.glb');
  check('a piece comes back byte for byte', got?.length === 100 * 1024 && got[0] === 1,
    `${got?.length ?? 0} bytes`);

  // A key with archive separators in it must survive the file system.
  check('a backslash key round-trips', got !== undefined);

  // Eviction. Three 100 KB pieces fit a 300 KB cap; a fourth must push one out.
  await c.put('Data\\a\\two.glb', block(100 * 1024, 2));
  await c.put('Data\\a\\three.glb', block(100 * 1024, 3));
  check('three pieces fit the budget', c.count === 3 && c.bytes === 300 * 1024,
    `${c.count} entries, ${bytes(c.bytes)}`);

  // Touch the oldest so it is no longer the least recently *used*. This is the
  // difference between LRU and least-recently-written, and it is what keeps a
  // visitor's favourite set resident.
  await c.get('Data\\a\\one.glb');
  await c.put('Data\\a\\four.glb', block(100 * 1024, 4));
  check('the budget still holds after a fourth', c.bytes <= cap, `${bytes(c.bytes)} of ${bytes(cap)}`);
  check('the touched piece survived', (await c.get('Data\\a\\one.glb')) !== undefined);
  check('the untouched one was evicted', (await c.get('Data\\a\\two.glb')) === undefined);

  // An evicted entry's file must actually be gone, not merely unlisted --
  // otherwise the budget is a fiction and the disk fills anyway.
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('pieces', { create: true });
  let files = 0;
  for await (const _ of (dir as unknown as AsyncIterable<unknown>)) files += 1;
  check('eviction deleted the file, not just the index entry', files === c.count,
    `${files} files on disk, ${c.count} in the index`);

  // Lowering the cap evicts immediately, which is what the settings slider does.
  await c.setCap(150 * 1024);
  check('lowering the cap evicts at once', c.bytes <= 150 * 1024, `${bytes(c.bytes)}`);

  // An item bigger than the whole budget is refused rather than thrashing.
  const before = c.count;
  await c.put('Data\\a\\huge.glb', block(400 * 1024, 9));
  check('an oversized piece is refused, not thrashed', c.count === before && c.bytes <= 150 * 1024);

  // Clearing, then caching again. This is the bug worth catching: removing the
  // directory leaves the handle pointing at nothing, so every later write
  // silently no-ops until a reload.
  await c.setCap(cap);
  await c.clear();
  check('clear empties the cache', c.count === 0 && c.bytes === 0);
  await c.put('Data\\a\\after-clear.glb', block(50 * 1024, 7));
  const after = await c.get('Data\\a\\after-clear.glb');
  check('caching still works after a clear', after?.length === 50 * 1024,
    after ? `${after.length} bytes` : 'nothing came back');

  // The index has to survive a reopen, or every return visit re-reads. The
  // flush is the point of the check as much as the reopen is: without it the
  // touch-on-read write from the `get` above is still in flight, and it used to
  // race the reopen's read, corrupt the index, and take the whole cache with
  // it.
  await c.flush();
  const reopened = await PieceCache.open(cap);
  check('the index survives a reopen', (reopened?.count ?? 0) === 1,
    `${reopened?.count ?? 0} entries`);
  check('and its contents do too', (await reopened?.get('Data\\a\\after-clear.glb')) !== undefined);

  await reopened?.clear();
  say();
}

async function main(): Promise<void> {
  lines.length = 0;
  await capabilities();
  await cache();
  say(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  (window as unknown as { __verify: unknown }).__verify = { failures, lines };
}

void main().catch((error) => {
  say(`\nthrew: ${error instanceof Error ? error.message : String(error)}`);
  (window as unknown as { __verify: unknown }).__verify = { failures: failures + 1, lines };
});
