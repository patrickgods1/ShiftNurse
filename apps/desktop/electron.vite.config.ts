import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    // `@shiftnurse/core`, `@shiftnurse/db` and `drizzle-orm` are bundled into the main process;
    // everything in `dependencies` (better-sqlite3 above all) stays external and loads from disk.
    // They are workspace packages and devDependencies, so a packaged app that tried to load them
    // from disk would not find them: v0.1.0's first draft did exactly that with `drizzle-orm`
    // (ERR_MODULE_NOT_FOUND on launch, macOS and Windows), and the packaged smoke test missed it
    // because it ran inside the repo, where Node found the dev copy by walking up the folders.
    //
    // better-sqlite3 13 is a Node-API module: one binary per platform, the same for the system
    // Node that runs the tests and for Electron's embedded Node, shipped inside the package. There
    // is no per-ABI rebuild or alias any more (12.x needed both, and had no build for Electron 44).
    plugins: [
      externalizeDepsPlugin({ exclude: ['@shiftnurse/core', '@shiftnurse/db', 'drizzle-orm'] }),
    ],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    // A sandboxed preload must be CommonJS: Electron loads it in a restricted context that
    // has no ESM loader. Everything else in the package is ESM, so this is the one exception.
    build: { rollupOptions: { output: { format: 'cjs' } } },
  },
  renderer: {
    resolve: {
      alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') },
    },
    plugins: [react(), tailwindcss()],
  },
});
