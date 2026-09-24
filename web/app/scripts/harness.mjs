#!/usr/bin/env node
/** The render harness: RENDERING.md Phase 0.
 *
 * Every later phase changes how armour looks, so this turns "better" into
 * numbers. It drives a page that exposes the kitbasher as `window.__kit` --
 * `kitbasher.html` (the *built* package, by default) or `studio.html` (source)
 * -- in headless Chrome, poses fixed scenes under fixed cameras, and scores
 * them with the measures `CLAUDE.md` already trusts:
 *
 * - **Sunchaser**, per piece: gold fraction of the piece's visible pixels, and
 *   gold-to-non-gold contrast pooled over the armour, against the in-game
 *   sheet and CIG's store renders;
 * - **Defiance Tactical** with an Artimex helmet: torso luminance mean,
 *   median and p95 against the in-game capture;
 * - **Corbel Halcyon, Beacon Orange, Lynx Blue**: the hue of the saturated
 *   pixels against the colour in the name -- hue, never luminance, since hue
 *   survives lighting changes;
 * - **the 23-item loadout**: frame time, draw calls, triangles and memory by
 *   the engine's own accounting.
 *
 *   npm run harness -- <label>                 score and write harness-out/<label>.json
 *   npm run harness -- <label> --compare <old> and print the difference
 *   FW_HARNESS_URL=http://localhost:5183/studio.html npm run harness -- dev
 *
 * The dev server must be running with an archive (`npm run verify` with
 * FW_ARCHIVE set). Output lives in `harness-out/`, which is gitignored: the
 * screenshots are renders of CIG's assets.
 *
 * **How a piece's pixels are found.** Two captures differing only in the
 * background colour agree exactly where armour is, which survives tone
 * mapping and post-processing where a keyed colour would not. A piece's own
 * region is what changes when that piece alone is hidden, taken with shadows
 * off so a helmet's shadow on a collar is not counted as helmet.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import { chromium } from 'playwright-core';

const URL_ = process.env.FW_HARNESS_URL ?? 'http://localhost:5183/kitbasher.html';
const OUT = process.env.FW_HARNESS_OUT ?? fileURLToPath(new URL('../harness-out/', import.meta.url));
const args = process.argv.slice(2);
const label = args.find((a) => !a.startsWith('--')) ?? 'run';
const compareWith = args.includes('--compare') ? args[args.indexOf('--compare') + 1] : null;

/** What the numbers are held against. Sources are CLAUDE.md's sections. */
export const REFERENCE = {
  // "Sunchaser, measured on screen against the in-game reference".
  sunchaserGold: { helmet: 50.1, torso: 24.5, arms: [8.9, 11.8], legs: 5.3 },
  // "Compare contrast, not absolute luminance": store render 2.95, user
  // sheet 3.47; the blend-table section measured 2.48 off the store renders.
  contrastBand: [2.48, 3.47],
  // "Lighting is matched to an in-game capture": torso over Defiance Tactical.
  tacticalTorso: { mean: 34, median: 29, p95: 68 },
  // The colour in each name, as a hue in degrees.
  hues: { 'Corbel Halcyon': 48, 'Beacon Undersuit Orange': 25, 'Lynx Arms Blue': 235 },
};

const VIEWPORT = { width: 1600, height: 1000 };

// Front and back, full length. The character faces -z.
const FRONT = { position: [0, 1.0, -3.5], target: [0, 0.95, 0] };
const BACK = { position: [0, 1.15, 3.1], target: [0, 1.15, 0] };
const TORSO = { position: [0, 1.25, -1.9], target: [0, 1.2, 0] };

async function main() {
  mkdirSync(`${OUT}${label}`, { recursive: true });
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [
      ...(platform() === 'darwin' ? ['--use-angle=metal'] : []),
      '--enable-gpu',
      '--ignore-gpu-blocklist',
    ],
  });
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon/.test(m.text())) console.log('[console]', m.text().slice(0, 300));
  });
  try {
    await page.goto(URL_);
  } catch (error) {
    console.error(`cannot reach ${URL_}: start the dev server (npm run verify with FW_ARCHIVE set)`);
    process.exit(2);
  }
  await page.waitForFunction(() => window.__kit?.exposed?.engine && !window.__kit.exposed.engine.current.busy,
    null, { timeout: 240_000, polling: 500 });
  // kitbasher.html mimics the host's 72vh box, below a page header: switch it
  // to the tall box so the whole view is on screen and measured at full size.
  await page.evaluate(async () => {
    const tall = document.getElementById('tall');
    if (tall && !document.getElementById('mount')?.classList.contains('tall')) tall.click();
    await new Promise((r) => setTimeout(r, 500));
    window.__kit.exposed.engine.view.renderer.domElement.scrollIntoView({ block: 'start' });
  });
  await page.evaluate(installHelpers);

  const report = { label, url: URL_, at: new Date().toISOString(), viewport: VIEWPORT, scenes: {} };
  const shot = async (name) => {
    const box = await page.evaluate(() => {
      const r = window.__kit.exposed.engine.view.renderer.domElement.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    await page.screenshot({ path: `${OUT}${label}/${name}.png`, clip: box });
  };

  // ---- Sunchaser, front: gold per piece and pooled contrast.
  report.scenes.sunchaser = await page.evaluate(async ({ camera }) => {
    const h = window.__harness;
    await h.dress(['Defiance Helmet Sunchaser', 'Defiance Core Sunchaser', 'Defiance Arms Sunchaser', 'Defiance Legs Sunchaser']);
    h.look(camera);
    return h.measurePieces(['helmet', 'torso', 'arms', 'legs']);
  }, { camera: FRONT });
  await shot('sunchaser-front');

  // ---- Sunchaser, back: the upper back is 33.0% gold on CIG's store render.
  report.scenes.sunchaserBack = await page.evaluate(async ({ camera }) => {
    const h = window.__harness;
    h.look(camera);
    return h.measurePieces(['torso']);
  }, { camera: BACK });
  await shot('sunchaser-back');

  // ---- Defiance Tactical with an Artimex helmet: torso luminance.
  report.scenes.tactical = await page.evaluate(async ({ camera }) => {
    const h = window.__harness;
    await h.dress(['Artimex Helmet', 'Defiance Core Tactical', 'Defiance Arms Tactical', 'Defiance Legs Tactical']);
    h.look(camera);
    return h.measurePieces(['torso']);
  }, { camera: TORSO });
  await shot('tactical-torso');

  // ---- Hue of named colourways.
  report.scenes.hues = {};
  for (const [name, pieces, slot] of [
    ['Corbel Halcyon', ['Corbel Helmet Halcyon', 'Corbel Core Halcyon', 'Corbel Arms Halcyon', 'Corbel Legs Halcyon'], 'torso'],
    ['Beacon Undersuit Orange', ['Beacon Undersuit Orange'], 'undersuit'],
    ['Lynx Arms Blue', ['Lynx Arms Blue'], 'arms'],
  ]) {
    report.scenes.hues[name] = await page.evaluate(async ({ pieces, slot, camera }) => {
      const h = window.__harness;
      await h.dress(pieces);
      h.look(camera);
      return (await h.measurePieces([slot]))[slot];
    }, { pieces, slot, camera: FRONT });
    await shot(`hue-${name.toLowerCase().replace(/\W+/g, '-')}`);
  }

  // ---- The heavy loadout: 23 carried items on a full set.
  report.scenes.loadout = await page.evaluate(async ({ camera }) => {
    const h = window.__harness;
    return h.heavyLoadout(camera);
  }, { camera: FRONT });
  await shot('loadout');

  await browser.close();
  writeFileSync(`${OUT}${label}.json`, `${JSON.stringify(report, null, 1)}\n`);
  printReport(report, compareWith ? JSON.parse(readFileSync(`${OUT}${compareWith}.json`, 'utf8')) : null);
}

/** Runs in the page. Installs `window.__harness`. */
function installHelpers() {
  const kit = window.__kit;
  const engine = () => kit.exposed.engine;
  const frames = (n = 2) => new Promise((resolve) => {
    let left = n;
    const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
  const settle = async () => {
    while (engine().current.busy) await new Promise((r) => setTimeout(r, 100));
    await frames(4);
  };

  const hsv = (r, g, b) => {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d > 1e-6) {
      if (max === r) h = 60 * (((g - b) / d) % 6);
      else if (max === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    return [h, max <= 1e-6 ? 0 : d / max, max];
  };
  // web/core/src/gold.rs, exactly.
  const isGold = (r, g, b) => {
    const [h, s, v] = hsv(r, g, b);
    return h >= 30 && h <= 55 && s >= 0.35 && v >= 0.2;
  };
  const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const median = (values) => {
    if (!values.length) return 0;
    const sorted = Float32Array.from(values).sort();
    return sorted[Math.floor(sorted.length / 2)];
  };
  const pct = (values, p) => {
    if (!values.length) return 0;
    const sorted = Float32Array.from(values).sort();
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  };

  const scratch = document.createElement('canvas');
  const capture = async (background) => {
    const { scene, renderer } = engine().view;
    // The theme's background is a Color; swapping in a clone keeps the one
    // the viewer themes untouched.
    const previous = scene.background;
    scene.background = previous.clone().setHex(background);
    await frames(3);
    const canvas = renderer.domElement;
    scratch.width = canvas.width;
    scratch.height = canvas.height;
    const ctx = scratch.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0);
    const data = ctx.getImageData(0, 0, scratch.width, scratch.height).data;
    scene.background = previous;
    return data;
  };

  // Everything that is not armour or gear: the floor, the grid, the lights.
  const stage = () => {
    const { scene } = engine().view;
    const hidden = [];
    scene.traverse((o) => {
      if (o.name === 'fw-ground' || o.type === 'GridHelper') hidden.push(o);
    });
    return hidden;
  };
  const withVisible = async (objects, visible, fn) => {
    const was = objects.map((o) => o.visible);
    objects.forEach((o) => { o.visible = visible; });
    try {
      return await fn();
    } finally {
      objects.forEach((o, i) => { o.visible = was[i]; });
    }
  };
  const casters = () => {
    const list = [];
    engine().view.scene.traverse((o) => { if (o.isMesh && o.castShadow) list.push(o); });
    return list;
  };
  const withoutShadows = async (fn) => {
    const list = casters();
    list.forEach((o) => { o.castShadow = false; });
    try {
      return await fn();
    } finally {
      list.forEach((o) => { o.castShadow = true; });
    }
  };
  const objectsOf = (slot) => engine().equipped.get(slot)?.objects ?? [];

  const MAGENTA = 0xff00ff;
  const GREEN = 0x00ff00;

  window.__harness = {
    settle,
    look({ position, target }) {
      const { camera, controls } = engine().view;
      camera.position.set(...position);
      controls.target.set(...target);
      controls.update();
    },
    async dress(names) {
      const e = engine();
      e.clearGear();
      e.clear();
      await settle();
      await e.setPose('idle');
      for (const name of names) {
        const item = e.catalogue.items.find((i) => i.name === name);
        if (!item) throw new Error(`no item named ${name}`);
        await e.equip(item);
      }
      await e.setPose('idle');
      await settle();
    },

    /** Gold, contrast, luminance and hue per piece, over its visible pixels. */
    async measurePieces(slots) {
      await settle();
      const hidden = stage();
      return withVisible(hidden, false, async () => {
        const a = await capture(MAGENTA);
        const b = await capture(GREEN);
        const silhouette = new Uint8Array(a.length / 4);
        for (let i = 0, p = 0; i < a.length; i += 4, p += 1) {
          if (Math.abs(a[i] - b[i]) <= 2 && Math.abs(a[i + 1] - b[i + 1]) <= 2 && Math.abs(a[i + 2] - b[i + 2]) <= 2) {
            silhouette[p] = 1;
          }
        }
        const regions = {};
        await withoutShadows(async () => {
          const full = await capture(MAGENTA);
          for (const slot of slots) {
            const objects = objectsOf(slot);
            if (!objects.length) continue;
            const without = await withVisible(objects, false, () => capture(MAGENTA));
            const mask = new Uint8Array(silhouette.length);
            for (let i = 0, p = 0; i < full.length; i += 4, p += 1) {
              if (!silhouette[p]) continue;
              if (Math.abs(full[i] - without[i]) > 8 || Math.abs(full[i + 1] - without[i + 1]) > 8
                || Math.abs(full[i + 2] - without[i + 2]) > 8) mask[p] = 1;
            }
            regions[slot] = mask;
          }
        });

        const out = {};
        const pooledGold = [];
        const pooledOther = [];
        for (const [slot, mask] of Object.entries(regions)) {
          const gold = [];
          const other = [];
          const lum = [];
          const hues = new Float64Array(36);
          let pixels = 0;
          let saturated = 0;
          for (let p = 0, i = 0; p < mask.length; p += 1, i += 4) {
            if (!mask[p]) continue;
            pixels += 1;
            const r = a[i];
            const g = a[i + 1];
            const bl = a[i + 2];
            const y = luma(r, g, bl);
            lum.push(y);
            if (isGold(r, g, bl)) { gold.push(y); pooledGold.push(y); } else { other.push(y); pooledOther.push(y); }
            const [h, s, v] = hsv(r, g, bl);
            if (s >= 0.35 && v >= 0.2) {
              saturated += 1;
              hues[Math.floor(h / 10) % 36] += 1;
            }
          }
          let peak = 0;
          for (let k = 1; k < 36; k += 1) if (hues[k] > hues[peak]) peak = k;
          const mean = lum.reduce((s, x) => s + x, 0) / Math.max(1, lum.length);
          out[slot] = {
            pixels,
            gold: pixels ? +(gold.length * 100 / pixels).toFixed(1) : 0,
            contrast: median(other) > 0 ? +(median(gold) / median(other)).toFixed(2) : 0,
            mean: +mean.toFixed(1),
            median: +median(lum).toFixed(1),
            p95: +pct(lum, 0.95).toFixed(1),
            saturated: pixels ? +(saturated * 100 / pixels).toFixed(1) : 0,
            hue: saturated ? peak * 10 + 5 : null,
          };
        }
        out.pooled = {
          gold: pooledGold.length + pooledOther.length
            ? +(pooledGold.length * 100 / (pooledGold.length + pooledOther.length)).toFixed(1) : 0,
          contrast: median(pooledOther) > 0 ? +(median(pooledGold) / median(pooledOther)).toFixed(2) : 0,
        };
        return out;
      });
    },

    /** A full set, an ammo-carrier pack and 23 carried items; then timing. */
    async heavyLoadout(camera) {
      const e = engine();
      await window.__harness.dress(['Defiance Helmet Sunchaser', 'Defiance Core Sunchaser', 'Defiance Arms Sunchaser', 'Defiance Legs Sunchaser']);
      const C = e.catalogue;
      const pack = C.items.find((i) => i.slot === 'backpack' && (i.ports || []).some((p) => /magattach/i.test(p.name)));
      if (pack) await e.equip(pack);
      const G = C.gear;
      const one = (f) => G.find(f);
      const rifle = one((i) => /^P4-AR Rifle$/.test(i.name || ''));
      const items = [rifle, rifle, one((i) => i.slot === 'sidearm' && /Pistol/.test(i.name || '')),
        one((i) => i.slot === 'knife'), one((i) => i.slot === 'gadget')];
      for (let k = 0; k < 4; k += 1) items.push(one((i) => i.slot === 'grenade'));
      const mag = one((i) => i.slot === 'magazine' && /P4/.test(i.name || '')) || one((i) => i.slot === 'magazine');
      for (let k = 0; k < 12; k += 1) items.push(mag);
      for (let k = 0; k < 4; k += 1) items.push(one((i) => i.slot === 'consumable'));
      for (const item of items) if (item) await e.carry(item);
      window.__harness.look(camera);
      await settle();

      const { renderer, scene, camera: cam } = e.view;
      const render = e.view.render ?? (() => renderer.render(scene, cam));
      const gl = renderer.getContext();
      const pixel = new Uint8Array(4);
      const times = [];
      for (let k = 0; k < 40; k += 1) {
        const t0 = performance.now();
        render();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        times.push(performance.now() - t0);
      }
      let n = 0;
      const t0 = performance.now();
      await new Promise((resolve) => {
        const tick = () => { n += 1; if (performance.now() - t0 < 3000) requestAnimationFrame(tick); else resolve(); };
        requestAnimationFrame(tick);
      });
      // Carried items of one kind share a template: twelve magazines are one
      // set of textures, so each template is counted once.
      const live = new Set([...e.equipped.values(), ...[...e.carried.values()].map((c) => c.template)]);
      let worn = 0;
      for (const loaded of live) worn += loaded.bytes;
      const stats = e.cacheStats();
      return {
        carried: e.carried.size,
        fps: Math.round(n / 3),
        renderMs: +median(times).toFixed(2),
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        textures: renderer.info.memory.textures,
        geometries: renderer.info.memory.geometries,
        wornMB: +(worn / 1048576).toFixed(1),
        wornPieces: live.size,
        uncachedMB: +([...live].filter((l) => ![...e.cache.values()].includes(l))
          .reduce((sum, l) => sum + l.bytes, 0) / 1048576).toFixed(1),
        cacheMB: +(stats.bytes / 1048576).toFixed(1),
      };
    },
  };
}

function printReport(report, previous) {
  const rows = [];
  const add = (metric, value, target, old) => rows.push({ metric, value, target, old });
  const s = report.scenes;
  const p = previous?.scenes;
  const R = REFERENCE;
  for (const slot of ['helmet', 'torso', 'arms', 'legs']) {
    const t = R.sunchaserGold[slot];
    add(`sunchaser ${slot} gold %`, s.sunchaser[slot]?.gold, Array.isArray(t) ? `${t[0]}-${t[1]}` : t, p?.sunchaser?.[slot]?.gold);
  }
  add('sunchaser contrast (pooled)', s.sunchaser.pooled.contrast, `${R.contrastBand[0]}-${R.contrastBand[1]}`, p?.sunchaser?.pooled?.contrast);
  add('sunchaser back torso gold %', s.sunchaserBack.torso?.gold, 33.0, p?.sunchaserBack?.torso?.gold);
  for (const k of ['mean', 'median', 'p95']) add(`tactical torso ${k}`, s.tactical.torso?.[k], R.tacticalTorso[k], p?.tactical?.torso?.[k]);
  for (const [name, target] of Object.entries(R.hues)) {
    add(`${name} hue`, s.hues[name]?.hue, target, p?.hues?.[name]?.hue);
    add(`${name} saturated %`, s.hues[name]?.saturated, '', p?.hues?.[name]?.saturated);
  }
  for (const k of ['fps', 'renderMs', 'calls', 'triangles', 'textures', 'wornMB', 'cacheMB']) {
    add(`loadout ${k}`, s.loadout[k], '', p?.loadout?.[k]);
  }
  const width = Math.max(...rows.map((r) => r.metric.length));
  console.log(`\n${report.label}  (${report.url})`);
  console.log(`${'metric'.padEnd(width)}  ${'value'.padStart(9)}  ${'target'.padStart(11)}${previous ? `  ${previous.label.padStart(9)}` : ''}`);
  for (const r of rows) {
    console.log(`${r.metric.padEnd(width)}  ${String(r.value ?? '-').padStart(9)}  ${String(r.target ?? '').padStart(11)}${previous ? `  ${String(r.old ?? '-').padStart(9)}` : ''}`);
  }
}

await main();
