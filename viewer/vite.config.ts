import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// ASSET_BASE_URL points the viewer at wherever manifest.json and the item GLBs
// live: /assets in dev (a symlink to data/out), a CDN origin for a web build.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: {
    __ASSET_BASE_URL__: JSON.stringify(process.env.ASSET_BASE_URL ?? '/assets'),
    __BUILD_MODE__: JSON.stringify(mode),
  },
  // Only what the viewer serves: its own tree and the baked output that
  // `public/assets` links to (`data/out`, whose `tint` links into
  // `data/interim`). `'..'` exposed the whole repository, `.git` and
  // `settings.local.toml` included, through `/@fs/`.
  server: { port: 5173, fs: { allow: ['.', '../data/out', '../data/interim/tint'] } },
  build: { target: 'es2022', sourcemap: mode !== 'production' },
}));
