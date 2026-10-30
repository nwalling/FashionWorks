/** The kitbasher from SOURCE, full window, against the served archive.
 *
 * `kitbasher.html` exercises the built package; this is the fast loop for
 * working on it: Vite's HMR over `src/`, the same `openUrl` path, and the
 * engine exposed as `window.__kit` so a check can drive it. Development only --
 * the `/__p4k` endpoint it reads exists only on the dev server.
 */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { ArchiveClient } from './src/archive/client';
import { readCatalogue } from './src/archive/catalogue';
import { readTokens } from './src/theme';
import { Kitbasher } from './src/ui/Kitbasher';
import type { Kitbasher as Engine } from './src/three/kitbasher';

const log = document.getElementById('log')!;
const say = (line: string) => { log.textContent = line; };

async function main(): Promise<void> {
  const theme = new URLSearchParams(location.search).get('theme');
  if (theme) document.documentElement.setAttribute('data-theme', theme);
  const head = await fetch('/__p4k', { method: 'HEAD' });
  const total = Number(head.headers.get('content-length') ?? 0);
  if (!total) {
    say('no archive is being served; set FW_ARCHIVE and restart');
    return;
  }
  const client = new ArchiveClient();
  const opened = await client.openUrl('/__p4k', total, 'male', {
    onProgress: ({ step, fraction }) => say(`${step} ${(fraction * 100).toFixed(0)}%`),
  });
  const catalogue = readCatalogue(opened.catalogueJson);
  say(`${catalogue.items.length.toLocaleString()} pieces`);
  const exposed: { engine?: Engine; loadout?: string } = {};
  // `?backgrounds` stands in for a host passing its themes to the portrait,
  // the current one first (WEB-INTEGRATION.md).
  const portraitBackgrounds = new URLSearchParams(location.search).has('backgrounds')
    ? [
      { id: 'hangar', name: 'Hangar', from: '#2a3f52', to: '#0a1219' },
      { id: 'ember', name: 'Ember', from: '#7a3b1c', to: '#150806' },
      { id: 'dolomite', name: 'Dolomite', from: '#d9dde2', to: '#7d8691' },
    ]
    : undefined;
  createRoot(document.getElementById('mount')!).render(createElement(Kitbasher, {
    client,
    catalogue,
    tokens: readTokens(),
    onEngine: (engine) => { exposed.engine = engine; },
    onLoadoutChange: (encoded) => { exposed.loadout = encoded; history.replaceState(null, '', `#${encoded}`); },
    initialLoadout: location.hash.slice(1) || undefined,
    portraitBackgrounds,
  }));
  (window as unknown as { __kit: unknown }).__kit = { client, catalogue, exposed };
}

void main().catch((error: unknown) => {
  say(`threw: ${error instanceof Error ? error.message : String(error)}`);
});
