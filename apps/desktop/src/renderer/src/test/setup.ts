/**
 * Vitest setup file. `api.ts` captures `window.shiftnurse` at import, so the fake bridge's stable
 * proxy has to be on the window before any test file imports a hook. The guard is because setup
 * files also run for the node-environment suites, which have no window and need no bridge.
 */

if (typeof window !== 'undefined') {
  await import('./fake-bridge.js');
}

export {};
