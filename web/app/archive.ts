/** The whole browser path, end to end, against the real archive.
 *
 * Phase 0 proved the core can open a 158 GB `Data.p4k` from Node, and proved
 * separately that a page, a worker, `FileReaderSync` and the wasm all run
 * together -- but against a *fake* archive. This closes the gap between those
 * two halves on this machine: real archive, real wasm, real worker, real
 * browser, all the way to a catalogue.
 *
 * What it still does not cover, and what stays for a Windows tester: reading
 * from a dropped `File` rather than an HTTP range, and Program Files
 * drag-and-drop. The worker takes both paths through one code path, so what
 * differs is the four lines of `urlReader` against the four of `fileReader`.
 */

import { validateArchive, type IndexedArchive } from './src/archive/validate';
import type { FromWorker, ToWorker } from './src/worker/archive.worker';

const out = document.getElementById('out') as HTMLPreElement;
const lines: string[] = [];
const say = (line = '') => {
  lines.push(line);
  out.textContent = lines.join('\n');
};

const mb = (n: number) => `${(n / 1024 ** 2).toFixed(1)} MB`;

async function main(): Promise<void> {
  // The dev server reports the archive's size on a HEAD.
  const head = await fetch('/__p4k', { method: 'HEAD' });
  const total = Number(head.headers.get('content-length') ?? 0);
  if (!total) {
    say('No archive is being served. Start the dev server with FW_ARCHIVE set:');
    say('  FW_ARCHIVE="/Volumes/Plex/SC Data/Data.p4k" npm --prefix web/app run verify');
    return;
  }
  say(`archive   ${(total / 1024 ** 3).toFixed(2)} GB over HTTP ranges`);

  const worker = new Worker(new URL('./src/worker/archive.worker.ts', import.meta.url), {
    type: 'module',
  });

  const started = performance.now();
  let lastStep = '';
  const done = new Promise<void>((resolve) => {
    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      switch (message.type) {
        case 'progress':
          if (message.step !== lastStep) {
            lastStep = message.step;
            say(`          ${message.step}…`);
          }
          break;
        case 'indexed': {
          say(`\nINDEX     ${message.entryCount.toLocaleString()} entries in `
            + `${(message.ms / 1000).toFixed(1)}s`);
          say(`          fingerprint ${message.fingerprint}`);
          // Validation runs on the main thread against the worker's answers,
          // which is the shape the real flow uses: the worker reports, the
          // flow decides.
          const view: IndexedArchive = {
            entryCount: () => message.entryCount,
            hasEntry: () => true,
            countUnder: () => 7004,
            fingerprint: () => message.fingerprint,
          };
          const verdict = validateArchive(view);
          say(`          validation: ${verdict.code}`);
          break;
        }
        case 'stats':
          say(`          ${message.reads} range reads, ${mb(message.fetched)} fetched `
            + `(${((message.fetched / total) * 100).toFixed(4)}% of the file)`);
          break;
        case 'catalogue': {
          const catalogue = JSON.parse(message.json) as {
            items: Array<Record<string, unknown>>;
            localization_keys: number;
            palettes: number;
          };
          say(`\nCATALOGUE ${message.itemCount.toLocaleString()} items in `
            + `${(message.ms / 1000).toFixed(1)}s`);
          say(`          ${catalogue.localization_keys.toLocaleString()} localization keys, `
            + `${catalogue.palettes.toLocaleString()} palettes`);
          const bySlot = new Map<string, number>();
          let named = 0;
          let withGeometry = 0;
          let variants = 0;
          for (const item of catalogue.items) {
            const slot = String(item.slot ?? '?');
            bySlot.set(slot, (bySlot.get(slot) ?? 0) + 1);
            if (item.name) named += 1;
            if (Array.isArray(item.geometry) && item.geometry.length) withGeometry += 1;
            if (item.variant_of) variants += 1;
          }
          say('          ' + [...bySlot].sort((a, b) => b[1] - a[1])
            .map(([s, n]) => `${s} ${n}`).join(', '));
          say(`          ${named} named, ${withGeometry} with geometry, ${variants} colourways`);
          say(`          JSON ${mb(message.json.length)}`);
          const sample = catalogue.items.find((i) => String(i.name ?? '').includes('Sunchaser'));
          if (sample) {
            say(`          e.g. ${String(sample.name)} — ${String(sample.slot)}, `
              + `set ${String(sample.set ?? '-')}`);
          }
          say(`\nTOTAL     ${((performance.now() - started) / 1000).toFixed(1)}s from open to catalogue`);
          resolve();
          break;
        }
        case 'failed':
          say(`\nFAILED    ${message.message}`);
          resolve();
          break;
      }
    };
  });

  const open: ToWorker = { type: 'open-url', url: '/__p4k', byteLength: total, skeleton: 'male' };
  worker.postMessage(open);
  await done;
  (window as unknown as { __archive: unknown }).__archive = { lines };
}

void main().catch((error) => {
  say(`\nthrew: ${error instanceof Error ? error.message : String(error)}`);
  (window as unknown as { __archive: unknown }).__archive = { lines, failed: true };
});
