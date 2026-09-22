/** Does the *built* package render the kitbasher?
 *
 * `built.html` proved the built package can open an archive and build a
 * catalogue. This goes the rest of the way: it mounts the exported `Kitbasher`
 * from `dist/` -- not `src/` -- against the real archive, so the listing, the
 * body, colourways, equip-set, poses and the theme switch are all exercised on
 * exactly the code a host installs.
 *
 * It uses `openUrl` because the archive here lives on a mounted volume and no
 * automated check can drive a native file picker. From the catalogue onwards
 * nothing differs from the dropped-file path.
 */
import { createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import {
  ArchiveClient,
  Kitbasher,
  readCatalogue,
  readTokens,
  watchTheme,
  type KitbasherEngine,
  type Tokens,
} from './dist/fashionworks.js';
import './dist/fashionworks.css';

const log = document.getElementById('log')!;
const say = (line: string) => { log.textContent = line; };

const themeButton = document.getElementById('theme') as HTMLButtonElement;
themeButton.onclick = () => {
  const html = document.documentElement;
  const next = html.getAttribute('data-theme') === 'dolomite' ? 'hangarworks' : 'dolomite';
  html.setAttribute('data-theme', next);
  themeButton.textContent = `theme: ${next}`;
};

async function main(): Promise<void> {
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
  say(`${catalogue.items.length.toLocaleString()} wearable pieces`);

  // Tokens are what the FashionWorks wrapper would thread; here the page does
  // it, so the theme button above restyles the kitbasher live.
  let tokens: Tokens = readTokens();
  const root = createRoot(document.getElementById('mount')!);
  const exposed: { engine?: KitbasherEngine; loadout?: string } = {};
  const render = () => root.render(
    createElement(StrictMode, null, createElement(Kitbasher, {
      client,
      catalogue,
      tokens,
      onEngine: (engine) => { exposed.engine = engine; },
      onLoadoutChange: (encoded) => { exposed.loadout = encoded; history.replaceState(null, '', `#${encoded}`); },
      initialLoadout: location.hash.slice(1) || undefined,
    })),
  );
  render();
  watchTheme((next) => { tokens = next; render(); });

  (window as unknown as { __kit: unknown }).__kit = { client, catalogue, exposed };
}

void main().catch((error: unknown) => {
  say(`threw: ${error instanceof Error ? error.message : String(error)}`);
});
