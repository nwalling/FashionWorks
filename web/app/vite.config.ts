import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Phase 5 turns this into a library build for `@fashionworks/web`. For now it
// serves the verification pages: the parts of this phase that cannot be tested
// headlessly -- OPFS, real storage quotas, a real drag-and-drop -- need a real
// browser, and this is how they get one.
export default defineConfig({
  plugins: [react()],
  server: { port: 5183 },
});
