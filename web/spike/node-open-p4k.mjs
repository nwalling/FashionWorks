/**
 * Open a real Data.p4k with the WebAssembly core, outside a browser.
 *
 * WEB.md Phase 0 asks for a spike against the real 158 GB archive. The browser
 * half of that needs Windows, Chrome and Firefox and a default Program Files
 * install, and cannot be run from a Mac. This half can: Node's `fs.readSync`
 * is a synchronous byte-range read, which is exactly the contract `range.rs`
 * expects from `FileReaderSync` in a worker. So the same .wasm, the same
 * range protocol and the same archive are exercised here -- only the host
 * differs.
 *
 * What this proves: indexing cost, entry lookup, decompression, and peak
 * memory, against the real file rather than against a compiler.
 * What it does not prove: File System Access permissions, drag-and-drop from
 * Program Files, worker plumbing, or Firefox. Those stay open.
 *
 *   node web/spike/node-open-p4k.mjs "/Volumes/Plex/SC Data/Data.p4k"
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const archivePath = process.argv[2];
if (!archivePath) {
  console.error('usage: node node-open-p4k.mjs <path to Data.p4k>');
  process.exit(2);
}

const here = path.dirname(new URL(import.meta.url).pathname);
const pkg = path.join(here, 'pkg', 'fashionworks_core.js');
if (!fs.existsSync(pkg)) {
  console.error(`missing ${pkg} -- run the wasm-bindgen step first`);
  process.exit(2);
}
const { Archive } = await import(pkg);

const stat = fs.statSync(archivePath);
const fd = fs.openSync(archivePath, 'r');

let reads = 0;
let bytesRead = 0;
/** The synchronous (offset, length) -> Uint8Array the core asks for. */
function readRange(offset, length) {
  const buf = Buffer.allocUnsafe(length);
  const n = fs.readSync(fd, buf, 0, length, offset);
  reads += 1;
  bytesRead += n;
  return new Uint8Array(buf.buffer, buf.byteOffset, n);
}

const mb = (n) => (n / 1024 / 1024).toFixed(1);
const gb = (n) => (n / 1024 / 1024 / 1024).toFixed(2);
const peak = () => process.memoryUsage().rss;
let peakRss = peak();
const watch = setInterval(() => { peakRss = Math.max(peakRss, peak()); }, 100);

console.log(`archive   ${archivePath}`);
console.log(`size      ${gb(stat.size)} GB`);

const t0 = Date.now();
const archive = new Archive(readRange, stat.size);
const indexMs = Date.now() - t0;
peakRss = Math.max(peakRss, peak());

const count = archive.entryCount();
console.log(`\nINDEX     ${count.toLocaleString()} entries in ${(indexMs / 1000).toFixed(1)}s`);
console.log(`          ${reads} range reads, ${mb(bytesRead)} MB fetched ` +
            `(${((bytesRead / stat.size) * 100).toFixed(4)}% of the file)`);

// Read back a few entries of different kinds and sizes.
const wanted = [
  'Data\\Game2.dcb',
  'Data\\Localization\\english\\global.ini',
];
let failures = 0;
for (const name of wanted) {
  const t = Date.now();
  const idx = archive.find(name);
  if (idx === undefined || idx === null) {
    console.log(`\nMISS      ${name} not in the index`);
    failures += 1;
    continue;
  }
  const declared = archive.entrySize(idx);
  try {
    const bytes = archive.read(idx);
    const ok = declared === undefined || BigInt(bytes.length) === BigInt(declared);
    console.log(`\nREAD      ${name}`);
    console.log(`          index ${idx}, ${mb(bytes.length)} MB in ${Date.now() - t}ms` +
                `${ok ? '' : `  !! declared ${declared}`}`);
    console.log(`          first bytes ${Buffer.from(bytes.slice(0, 8)).toString('hex')}`);
    if (!ok) failures += 1;
  } catch (e) {
    console.log(`\nFAIL      ${name}: ${e}`);
    failures += 1;
  }
}

clearInterval(watch);
console.log(`\nPEAK RSS  ${mb(peakRss)} MB`);
console.log(`TOTAL     ${reads} range reads, ${mb(bytesRead)} MB fetched`);

// WEB.md Phase 0 exit: indexing under 2 minutes, peak memory under 2 GB.
const checks = [
  ['index < 120s', indexMs < 120_000, `${(indexMs / 1000).toFixed(1)}s`],
  ['peak RSS < 2 GB', peakRss < 2 * 1024 ** 3, `${mb(peakRss)} MB`],
  ['entries found', count > 1_000_000, count.toLocaleString()],
  ['reads succeeded', failures === 0, `${failures} failure(s)`],
];
console.log('\nPhase 0 exit criteria');
for (const [label, pass, detail] of checks) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label.padEnd(18)} ${detail}`);
}
fs.closeSync(fd);
process.exit(checks.every(([, p]) => p) ? 0 : 1);
