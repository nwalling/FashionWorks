import { createReadStream, readFileSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
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
        // An inverted or out-of-file range would otherwise go out with a
        // negative content-length.
        if (start > end) {
          response.writeHead(416, { 'content-range': `bytes */${size}` });
          response.end();
          return;
        }
        response.writeHead(206, {
          'content-type': 'application/octet-stream',
          'content-range': `bytes ${start}-${end}/${size}`,
          'content-length': end - start + 1,
          'accept-ranges': 'bytes',
        });
        void sendRange(path, start, end, response);
      });
    },
  };
}

/** Send `start..=end` of the archive, a chunk at a time, retrying a chunk
 * that fails.
 *
 * The archive here sits on an SMB share, and a share hands back the odd
 * `EIO`. Piped straight from a read stream, one such error was an unhandled
 * `'error'` event that took the whole dev server down -- three times in one
 * day. A failed chunk is retried; only if it keeps failing does this one
 * request end early, and the server stays up. */
async function sendRange(path: string, start: number, end: number, response: ServerResponse): Promise<void> {
  const CHUNK = 4 * 1024 * 1024;
  const ATTEMPTS = 4;
  // A browser that has what it needs drops the connection mid-range. Waiting
  // on 'drain' then waits forever, the handle is never closed, and Node
  // kills the process when the garbage collector finds it open.
  const closed = new Promise<void>((resolve) => response.once('close', () => resolve()));
  let file: Awaited<ReturnType<typeof open>> | null = null;
  try {
    file = await open(path, 'r');
    for (let at = start; at <= end && !response.destroyed; at += CHUNK) {
      const length = Math.min(CHUNK, end - at + 1);
      const buffer = Buffer.alloc(length);
      for (let attempt = 1; ; attempt += 1) {
        try {
          let filled = 0;
          while (filled < length) {
            const { bytesRead } = await file.read(buffer, filled, length - filled, at + filled);
            if (bytesRead === 0) throw new Error('unexpected end of archive');
            filled += bytesRead;
          }
          break;
        } catch (error) {
          if (attempt >= ATTEMPTS) throw error;
          await new Promise((r) => setTimeout(r, 200 * attempt));
        }
      }
      if (response.destroyed) break;
      if (!response.write(buffer)) {
        await Promise.race([new Promise<void>((resolve) => response.once('drain', () => resolve())), closed]);
      }
    }
    if (!response.destroyed) response.end();
  } catch (error) {
    console.error(`[fashionworks] range ${start}-${end} failed:`, error);
    response.destroy();
  } finally {
    await file?.close().catch(() => {});
  }
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

/** Serve the core where `coreUrl()` looks for it when running from source.
 *
 * `coreUrl` resolves `./fashionworks_core_bg.wasm` next to `client.ts`, which
 * is right for the built package -- `emitCore` puts it there -- and a 404 under
 * the dev server, where `client.ts` is `src/archive/client.ts`. Dev only.
 */
function serveCore(): Plugin {
  const source = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../core/pkg/fashionworks_core_bg.wasm',
  );
  return {
    name: 'fashionworks-serve-core',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/src/archive/fashionworks_core_bg.wasm', (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/wasm', 'cache-control': 'no-store' });
        createReadStream(source).pipe(response);
      });
    },
  };
}

// Two jobs. `vite build` produces the `@fashionworks/web` library; `vite`
// serves the verification pages, which is how the parts that cannot be tested
// headlessly -- OPFS, real storage quotas, a real drag-and-drop, the wasm core
// against the real archive, and a live theme switch -- get a real browser.
export default defineConfig({
  plugins: [react(), archiveRange(), serveCore(), unbundleCore(), emitCore()],
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
