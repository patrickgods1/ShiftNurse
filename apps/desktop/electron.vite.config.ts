import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    // `@shiftnurse/core` and `@shiftnurse/db` are bundled into the main process rather than
    // resolved at runtime. That matters for one reason: `db` imports `better-sqlite3`, and
    // the copy it would find from its own folder is built for the system Node (used by the
    // tests and the seeder), not for Electron's embedded Node. Bundling lets the alias below
    // redirect that import to `better-sqlite3-electron`, the Electron-ABI copy, which stays
    // external so the native binary loads from disk. See scripts/rebuild-sqlite-for-electron.mjs.
    plugins: [externalizeDepsPlugin({ exclude: ['@shiftnurse/core', '@shiftnurse/db'] })],
    resolve: {
      alias: { 'better-sqlite3': 'better-sqlite3-electron' },
    },
    build: {
      rollupOptions: { external: ['better-sqlite3-electron'] },
    },
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
