// Static server for the shader check, rooted at the repository.
//
// The golden names its textures relative to the repo root -- `data/raw/...`
// for the control maps and layer library, `data/interim/tint/...` for the
// bakes -- so the harness needs a server rooted there and nothing more. None of
// that leaves the machine: it is CIG copyright and gitignored, and this binds
// to localhost.
//
//   node web/gpu/serve.mjs [port]
//   open http://127.0.0.1:8777/web/gpu/check.html?golden=/path/to/golden.json

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const PORT = Number(process.argv[2] ?? 8777);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
};

// Binding to 127.0.0.1 keeps other machines out, but not other web pages: a
// site that rebinds its own hostname to 127.0.0.1 can read anything served
// here, and this serves the whole repository plus extracted game data. So the
// Host header must name this machine.
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

createServer((request, response) => {
  const host = (request.headers.host ?? '').replace(/:\d+$/, '');
  if (!LOCAL_HOSTS.has(host)) {
    response.writeHead(403).end('localhost only');
    return;
  }
  const url = new URL(request.url, 'http://localhost');
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  // Everything served must resolve inside the repo, even after `..`. A bare
  // prefix test would also admit a sibling such as `StarFashion-old/`.
  const path = normalize(join(ROOT, relative));
  if (path !== ROOT && !path.startsWith(ROOT + sep)) {
    response.writeHead(403).end('outside the repository');
    return;
  }
  let stat;
  try {
    stat = statSync(path);
  } catch {
    response.writeHead(404).end(`no such file: ${relative}`);
    return;
  }
  if (stat.isDirectory()) {
    response.writeHead(404).end('directory');
    return;
  }
  response.writeHead(200, {
    'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-store',
  });
  createReadStream(path).pipe(response);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`);
});
