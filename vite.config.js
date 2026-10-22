import { defineConfig } from 'vite';

export default defineConfig({
  // top-level await is used to preload fish models before the world is built
  build: { target: 'es2022' },
  esbuild: { target: 'es2022' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
});
