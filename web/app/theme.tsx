/** WEB.md phase 5's exit criterion, made testable.
 *
 * *Switching theme on the site restyles the page and the 3D view with no
 * reload, and AA contrast passes in every theme.*
 *
 * The first half needs a browser: CSS restyles itself, but a WebGL scene's
 * background and grid are numbers in a renderer, and the only way to know they
 * followed is to read pixels back off the canvas after a switch. The second
 * half is arithmetic and is also covered by `test/theme.test.ts`; it is
 * repeated here against the *resolved* tokens, which is what the browser
 * actually computes -- `color-mix()` and `var()` chains included.
 *
 * The four themes here stand in for the site's. Only `hangarworks` is public in
 * full; `dolomite` is known to be light-leaning from the four tokens it does
 * expose, and `keystone` and `navy` exist by name only. So this proves the
 * *mechanism* across dark, light and two tinted themes, and the host re-runs it
 * against the real values.
 */

import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Viewer } from './src/ui/Viewer';
import { checkContrast, readTokens, watchTheme, type Tokens } from './src/theme';

const THEMES = ['hangarworks', 'dolomite', 'keystone', 'navy'] as const;

const report = document.getElementById('report') as HTMLPreElement;
const bar = document.getElementById('bar') as HTMLDivElement;

/** The canvas's own corner pixel, which is scene background and nothing else.
 *
 * Read off the DOM canvas rather than through a stored renderer reference.
 * `getContext` returns the context the canvas already has -- attributes on a
 * second call are ignored -- so this needs no ref, and is not disturbed by
 * StrictMode mounting the view twice.
 */
function canvasPixel(): [number, number, number] | null {
  const canvas = document.querySelector('canvas');
  const gl = canvas?.getContext('webgl2');
  if (!gl) return null;
  const pixel = new Uint8Array(4);
  gl.readPixels(1, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  return [pixel[0]!, pixel[1]!, pixel[2]!];
}

function Harness() {
  const [theme, setTheme] = useState<string>(
    document.documentElement.getAttribute('data-theme') ?? 'hangarworks',
  );
  const [tokens, setTokens] = useState<Tokens>(() => readTokens());

  // The attribute is the source of truth, not React state. The real site flips
  // it from its own header, and anything the component believes about the
  // current theme has to come from there -- otherwise a switch made outside
  // React leaves the label disagreeing with the page, which is how this harness
  // first reported "hangarworks" over a plainly white page.
  useEffect(() => {
    const sync = () => {
      setTokens(readTokens());
      setTheme(document.documentElement.getAttribute('data-theme') ?? 'hangarworks');
    };
    sync();
    return watchTheme(sync);
  }, []);

  // The buttons live outside React, in the page chrome, so the switch is as
  // close as possible to the site flipping the attribute itself.
  useEffect(() => {
    bar.querySelectorAll('button').forEach((b) => b.remove());
    for (const name of THEMES) {
      const button = document.createElement('button');
      button.textContent = name;
      button.setAttribute('aria-pressed', String(name === theme));
      // Sets the attribute, as the site does; state follows from the observer.
      button.onclick = () => document.documentElement.setAttribute('data-theme', name);
      bar.appendChild(button);
    }
  }, [theme]);

  useEffect(() => {
    const results = checkContrast(tokens);
    const failures = results.filter((r) => !r.passes);
    const lines = [
      `theme            ${theme}`,
      `page colour      ${tokens['--sc-dark']}`,
      `text colour      ${tokens['--sc-text']}`,
      `canvas pixel     ${canvasPixel()?.join(', ') ?? 'not ready'}`,
      '',
      ...results.map((r) =>
        `  ${r.passes ? '✓' : '✗'} ${r.label.padEnd(28)} `
        + `${r.ratio.toFixed(2).padStart(6)} : 1   (needs ${r.required})`),
      '',
      failures.length ? `${failures.length} FAILING` : 'all pairings pass AA',
    ];
    report.textContent = lines.join('\n');
  }, [tokens, theme]);

  return <Viewer tokens={tokens} className="fw-view" />;
}

createRoot(document.getElementById('host')!).render(
  <StrictMode><Harness /></StrictMode>,
);

/** Drive the whole thing from a test: switch each theme, read the canvas back,
 * and report whether the scene actually followed. */
(window as unknown as { __themeCheck: unknown }).__themeCheck = async () => {
  const out: Array<Record<string, unknown>> = [];
  for (const name of THEMES) {
    document.documentElement.setAttribute('data-theme', name);
    // One frame for React to re-render and one for the renderer to draw it.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 120));
    const tokens = readTokens();
    const failures = checkContrast(tokens).filter((c) => !c.passes);
    out.push({
      theme: name,
      pageToken: tokens['--sc-dark'],
      canvas: canvasPixel(),
      contrastFailures: failures.map((f) => `${f.label} ${f.ratio.toFixed(2)}`),
    });
  }
  return out;
};
