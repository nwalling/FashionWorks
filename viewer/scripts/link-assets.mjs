// Symlink viewer/public/assets -> data/out so the dev server serves generated
// assets without copying them. Windows falls back to a junction.
import { mkdirSync, rmSync, symlinkSync, existsSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const link = resolve(here, '..', 'public', 'assets');
const target = resolve(here, '..', '..', 'data', 'out');

mkdirSync(dirname(link), { recursive: true });
if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) {
  rmSync(link, { recursive: true, force: true });
}
if (!existsSync(target)) {
  console.error(`no build output at ${target} — run \`scx synth\` or \`scx all\` first`);
  process.exit(1);
}
symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
console.log(`${link} -> ${target}`);
