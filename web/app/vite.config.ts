import { createReadStream, statSync } from 'node:fs';
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

// Phase 5 turns this into a library build for `@fashionworks/web`. For now it
// serves the verification pages: the parts of this phase that cannot be tested
// headlessly -- OPFS, real storage quotas, a real drag-and-drop, and the wasm
// core against the real archive -- need a real browser, and this is how they
// get one.
export default defineConfig({
  plugins: [react(), archiveRange()],
  server: {
    port: 5183,
    // The wasm core is built into `web/core/pkg`, one level above this
    // package's root, and Vite refuses to serve outside the root by default.
    fs: { allow: ['..'] },
  },
  worker: { format: 'es' },
  // The wasm lives outside this package's root, so Vite needs permission to
  // serve it in dev.
  optimizeDeps: { exclude: ['../core/pkg/fashionworks_core.js'] },
});
