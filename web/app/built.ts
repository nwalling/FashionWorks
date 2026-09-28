/** Does the *built* package actually open an archive?
 *
 * Every other verification page imports from `src/`, which is what let the
 * published package ship with no worker and no WebAssembly for a whole release:
 * the source worked, and nothing ever loaded the thing a host installs. This
 * page imports `dist/` deliberately.
 *
 * It uses `openUrl` because the archive here lives on a mounted volume and no
 * automated check can drive a native file picker. The worker, the core, the
 * range protocol and the catalogue build are identical to the dropped-file
 * path; only the source of the bytes differs.
 */
import { ArchiveClient, coreUrl, readCatalogue } from './dist/fashionworks.js';

const log = document.getElementById('log')!;
// Built as nodes, not markup: a line can carry an error message from the
// worker, which quotes archive content.
const say = (line: string, cls = '') => {
  if (log.childNodes.length) log.append('\n');
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = line;
  log.append(span);
};

async function main(): Promise<void> {
  say(`core URL: ${coreUrl()}`);
  const head = await fetch('/__p4k', { method: 'HEAD' });
  const total = Number(head.headers.get('content-length') ?? 0);
  if (!total) {
    say('no archive is being served; set FW_ARCHIVE and restart', 'bad');
    return;
  }
  say(`archive ${(total / 1024 ** 3).toFixed(2)} GB`);

  const client = new ArchiveClient();
  const started = performance.now();
  const opened = await client.openUrl('/__p4k', total, 'male', {
    onProgress: ({ step, fraction }) => say(`  ${step} ${(fraction * 100).toFixed(0)}%`),
    onIndexed: ({ entryCount, fingerprint, ms }) =>
      say(`indexed ${entryCount.toLocaleString()} entries in ${(ms / 1000).toFixed(1)}s`
          + ` · fingerprint ${fingerprint.slice(0, 16)}…`),
  });

  const catalogue = readCatalogue(opened.catalogueJson);
  say(`catalogue ${opened.itemCount.toLocaleString()} items`
      + ` · ${catalogue.items.length.toLocaleString()} wearable`);
  for (const [slot, items] of catalogue.bySlot) say(`  ${slot} ${items.length}`);

  const legs = catalogue.bySlot.get('legs')!
    .filter((i) => (i.name ?? '').startsWith('Defiance Legs') && !i.variant_of);
  for (const root of legs) {
    const family = catalogue.families.get(root.id) ?? [];
    say(`  ${root.name} · ${family.length} colourway(s)`);
  }

  say(`TOTAL ${(performance.now() - started) / 1000 | 0}s`);
  say('the built package opened a real archive', 'ok');
  (window as unknown as { __built: unknown }).__built = { catalogue, opened };
}

void main().catch((error: unknown) => {
  say(`threw: ${error instanceof Error ? error.message : String(error)}`, 'bad');
});
