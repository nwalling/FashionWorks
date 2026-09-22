import { createReadStream, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** Serve a local `Data.p4k` over HTTP byte ranges, for verification only.
 *
 * The production path is `FileReaderSync` over a dropped `File`, and nothing
 * here changes that. This exists because the archive on this machine lives on a
 * mounted volume and there is no way to drive a native file picker from an
 * automated check -- so without it the whole browser path could only ever be
 * run against a fake.
 *
 * The bytes, the wasm and the range protocol are identical; only where the
 * range comes from differs. It is off unless `FW_ARCHIVE` names a file, and it
 * binds to the dev server, which is localhost. **Nothing it serves may ever
 * reach a build**: the archive is CIG copyright, and WEB.md's whole design is
 * that the server ships code and never game data.
 */
function archiveRange(): Plugin {
  const path = process.env.FW_ARCHIVE;
  return {
    name: 'fashionworks-archive-range',
    apply: 'serve',
    configureServer(server) {
      if (!path) return;
      const size = statSync(path).size;
      server.config.logger.info(
        `[fashionworks] serving ${path} (${(size / 1024 ** 3).toFixed(2)} GB) at /__p4k`,
      );
      server.middlewares.use('/__p4k', (request, response) => {
        // HEAD is how the page learns the size. Answering a plain GET with
        // `content-length: size` and an empty body is a content-length
        // mismatch, and the browser tears the connection down -- which is
        // exactly what it did.
        if (request.method === 'HEAD') {
          response.writeHead(200, { 'content-length': size, 'accept-ranges': 'bytes' });
          response.end();
          return;
        }
        const range = /^bytes=(\d+)-(\d+)?$/.exec(request.headers.range ?? '');
        if (!range) {
          response.writeHead(400, { 'content-type': 'text/plain' });
          response.end('this endpoint serves byte ranges only; send a Range header');
          return;
        }
        const start = Number(range[1]);
        const end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
        response.writeHead(206, {
          'content-type': 'application/octet-stream',
          'content-range': `bytes ${start}-${end}/${size}`,
          'content-length': end - start + 1,
          'accept-ranges': 'bytes',
        });
        createReadStream(path, { start, end }).pipe(response);
      });
    },
  };
}

/** Put the WebAssembly core in the published package.
 *
 * It is built into `web/core/pkg`, one directory above this package's root, so
 * nothing in `src/` imports it as an asset and `vite build` would otherwise
 * emit a library that references a `.wasm` it does not ship. That is exactly
 * what 0.1.0 did: no core, no worker, and an indexing screen that never
 * finished.
 *
 * Emitted with its name fixed, because `src/archive/client.ts` resolves it as
 * `new URL('./fashionworks_core_bg.wasm', import.meta.url)` and a content hash
 * would break that. The file is immutable per release anyway, and the host
 * serves it from its own hashed asset pipeline.
 */
/** Stop the core being base64'd into the bundle.
 *
 * wasm-bindgen's glue ends its argument handling with
 *
 *   if (module_or_path === undefined) {
 *     module_or_path = new URL('fashionworks_core_bg.wasm', import.meta.url);
 *   }
 *
 * and Vite resolves that reference and inlines the target. `assetsInlineLimit`
 * does not reach the worker sub-build, so the 657 KB core came back as a 906 KB
 * data URL **inside the inlined worker** -- a 1.8 MB bundle against a 400 KB
 * budget, with the core no longer separately cacheable.
 *
 * The branch is dead in the published package: `ArchiveClient` always passes an
 * explicit URL, because a blob worker cannot resolve a relative one anyway.
 * Removing it leaves wasm-bindgen's own "expected a URL" error for anyone who
 * calls init with nothing, which is a better failure than a silent 906 KB.
 *
 * Build only. The dev server serves the glue as-is, so the verification pages
 * keep working without passing a URL.
 */
function unbundleCore(): Plugin {
  const NEEDLE = "new URL('fashionworks_core_bg.wasm', import.meta.url)";
  return {
    name: 'fashionworks-unbundle-core',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('fashionworks_core.js') || !code.includes(NEEDLE)) return null;
      return { code: code.replace(NEEDLE, 'undefined'), map: null };
    },
  };
}

function emitCore(): Plugin {
  const source = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../core/pkg/fashionworks_core_bg.wasm',
  );
  return {
    name: 'fashionworks-emit-core',
    apply: 'build',
    buildStart() {
      if (!statSync(source, { throwIfNoEntry: false })) {
        // Failing the build is the point: a package without the core is the
        // bug this plugin exists to prevent, and it is invisible at runtime
        // until someone drops a 158 GB file on it.
        this.error(
          `the WebAssembly core is missing at ${source}. Build it first:\n`
            + '  cd web/core && cargo build --release --target wasm32-unknown-unknown\n'
            + '  wasm-bindgen --target web --out-dir pkg '
            + 'target/wasm32-unknown-unknown/release/fashionworks_core.wasm',
        );
      }
      this.emitFile({
        type: 'asset',
        fileName: 'fashionworks_core_bg.wasm',
        source: readFileSync(source),
      });
    },
  };
}

// Two jobs. `vite build` produces the `@fashionworks/web` library; `vite`
// serves the verification pages, which is how the parts that cannot be tested
// headlessly -- OPFS, real storage quotas, a real drag-and-drop, the wasm core
// against the real archive, and a live theme switch -- get a real browser.
export default defineConfig({
  plugins: [react(), archiveRange(), unbundleCore(), emitCore()],
  build: {
    lib: {
      entry: resolve(dirname(fileURLToPath(import.meta.url)), 'src/index.ts'),
      name: 'FashionWorks',
      formats: ['es', 'cjs'],
      fileName: (format) => `fashionworks.${format === 'es' ? 'js' : 'cjs'}`,
    },
    rollupOptions: {
      // React is a peer dependency: bundling it would give the host two copies
      // and break hooks.
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      output: { assetFileNames: 'fashionworks.[ext]' },
    },
    // The host's budget is 400 KB brotli for app JavaScript, so an accidental
    // dependency should fail the build rather than ship.
    // Never turn an asset into a data URL. Vite's default inlines anything
    // under 4 KB, but wasm-bindgen's glue resolves the core with
    // `new URL('..._bg.wasm', import.meta.url)`, and left to itself Vite
    // base64'd the whole 657 KB core into the chunk -- which both blew the
    // budget and put the core somewhere the host could not cache separately.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 500,
    sourcemap: true,
  },
  server: {
    port: 5183,
    // The wasm core is built into `web/core/pkg`, one level above this
    // package's root, and Vite refuses to serve outside the root by default.
    fs: { allow: ['..'] },
  },
  worker: {
    format: 'es',
    // Vite 5 builds the worker with its OWN plugin list, not the one above, so
    // a plugin registered only in `plugins` never sees worker modules. That is
    // why the core kept being inlined even with `unbundleCore` in place: the
    // glue is imported by the worker, and the worker is a separate build.
    plugins: () => [unbundleCore()],
  },
  // The wasm lives outside this package's root, so Vite needs permission to
  // serve it in dev.
  optimizeDeps: { exclude: ['../core/pkg/fashionworks_core.js'] },
});
