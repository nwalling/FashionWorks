/**
 * Does the package we are about to publish actually contain the pipeline?
 *
 * Run: node scripts/check-package.mjs   (after `vite build`; the build runs it)
 *
 * 0.1.0 shipped with **no worker and no WebAssembly**. Nothing caught it,
 * because every test and every verification page imports from `src/`, where the
 * worker is right there and the dev server resolves the core happily. The only
 * thing that would have noticed is an assertion about the built artefact, which
 * is what this is.
 *
 * The failure mode it guards is silent by construction: a package missing the
 * core type-checks, builds, imports, renders its whole onboarding flow, accepts
 * a dropped archive — and then sits on the indexing screen forever, because
 * `archive.worker.ts` was reachable only through `import type` and the bundler
 * erased it.
 */
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const rel = (p) => relative(root, p);

let pass = 0;
let fail = 0;
const check = (name, condition, detail = '') => {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
  }
};

function size(path) {
  const stat = statSync(path, { throwIfNoEntry: false });
  return stat ? stat.size : 0;
}

// ── the core ────────────────────────────────────────────────────────────────

const core = join(dist, 'fashionworks_core_bg.wasm');
const coreSize = size(core);
check('the WebAssembly core is in the package', coreSize > 100_000, rel(core));
if (coreSize === 0) {
  // Stop here rather than letting the budget checks below throw ENOENT. The
  // whole point of this script is to be a clear diagnostic, and a stack trace
  // about a missing file is how the original bug stayed invisible.
  console.log(
    '\nThe package has no WebAssembly core, which is the 0.1.0 bug exactly:\n'
      + 'it will build, import, render and then hang on the indexing screen.\n'
      + 'Build the core first:\n'
      + '  cd web/core && cargo build --release --target wasm32-unknown-unknown\n'
      + '  wasm-bindgen --target web --out-dir pkg '
      + 'target/wasm32-unknown-unknown/release/fashionworks_core.wasm',
  );
  process.exit(1);
}

// ── the bundle, and the worker inside it ────────────────────────────────────

const bundlePath = join(dist, 'fashionworks.js');
check('the ES bundle exists', size(bundlePath) > 0, rel(bundlePath));
const bundle = readFileSync(bundlePath, 'utf8');

check(
  'the bundle resolves the core as an asset URL',
  bundle.includes("new URL(\"./fashionworks_core_bg.wasm\", import.meta.url)"),
  'webpack, Turbopack and Vite all key on this exact form to emit the asset',
);

check(
  'the core URL is absolutised before it crosses into the worker',
  /new URL\(\w+,\s*location\.href\)/.test(bundle),
  'webpack yields a ROOT-RELATIVE path, and a blob worker cannot resolve one: '
    + 'fetch rejects with "Failed to parse URL" and the archive hangs',
);

/** The inlined worker, decoded.
 *
 * Vite 5 emitted it as one long base64 literal; Vite 6 emits the source as a
 * template literal handed to `new Blob([...])`. Either is an inlined worker. */
function inlinedWorker() {
  const base64 = bundle.match(/=\s*"([A-Za-z0-9+/=]{5000,})"/);
  if (base64) return Buffer.from(base64[1], 'base64').toString('utf8');
  const blob = bundle.match(/new Blob\(\["URL\.revokeObjectURL\(import\.meta\.url\);",\s*([\w$]+)\]/);
  if (!blob) return null;
  const start = bundle.indexOf(`${blob[1]} = \``);
  if (start < 0) return null;
  let end = start + blob[1].length + 4;
  while (end < bundle.length && !(bundle[end] === '`' && bundle[end - 1] !== '\\')) end += 1;
  const source = bundle.slice(start + blob[1].length + 4, end);
  return source.length > 5000 ? source : null;
}
const worker = inlinedWorker();
check('a worker is inlined in the bundle', Boolean(worker), 'no inlined worker source found');

if (worker) {

  check(
    'the inlined worker is the archive worker',
    worker.includes('FileReaderSync'),
    'the synchronous read is the whole reason the archive lives in a worker',
  );
  check(
    'the wasm-bindgen glue rides inside the worker',
    /wbindgen/.test(worker),
    'a dynamic import splits it into a chunk the blob worker cannot resolve',
  );

  const dynamicImports = [...worker.matchAll(/import\(([^)]{0,120})\)/g)].map((m) => m[1]);
  check(
    'the worker has no dynamic imports',
    dynamicImports.length === 0,
    `a blob worker resolves these against the blob URL, which is nothing: ${dynamicImports.join(', ')}`,
  );

  check(
    'the core is NOT base64-inlined into the worker',
    !/data:application\/wasm;base64/.test(worker),
    'that merges the 400 KB app budget with the 2 MB core budget, and costs ~900 KB',
  );
}

// ── budgets, from WEB-INTEGRATION.md section 5 ──────────────────────────────

const { brotliCompressSync } = await import('node:zlib');
const brotli = (path) => brotliCompressSync(readFileSync(path)).length;

const APP_BUDGET = 400 * 1024;
const CORE_BUDGET = 2 * 1024 * 1024;
const appBytes = brotli(bundlePath) + brotli(join(dist, 'fashionworks.css'));
const coreBytes = brotli(core);

check(
  `app JavaScript is inside its budget (${(appBytes / 1024).toFixed(0)} KB brotli of 400)`,
  appBytes <= APP_BUDGET,
);
check(
  `the core is inside its budget (${(coreBytes / 1024).toFixed(0)} KB brotli of 2048)`,
  coreBytes <= CORE_BUDGET,
);

// ── no stray chunks ─────────────────────────────────────────────────────────
//
// A split chunk means something is resolved relatively at runtime, which is
// exactly what a consumer's bundler will not reproduce from inside node_modules.

const { readdirSync } = await import('node:fs');
const assets = readdirSync(join(dist, 'assets'), { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.js'))
  .map((e) => e.name);
check(
  'no JavaScript chunks are split out of the bundle',
  assets.length === 0,
  assets.join(', '),
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
