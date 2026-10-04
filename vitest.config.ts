import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/desktop/src/renderer/src/**/*.test.{ts,tsx}',
      'apps/desktop/src/main/**/*.test.ts',
      'apps/desktop/src/shared/**/*.test.ts',
    ],
    // Component tests opt into jsdom per file (`// @vitest-environment jsdom`); the rest of
    // the suite is pure logic and runs faster under node.
    environment: 'node',
    // Puts the fake `window.shiftnurse` proxy in place before any jsdom test imports api.ts.
    setupFiles: ['apps/desktop/src/renderer/src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: [
        'packages/*/src/**/*.ts',
        'apps/desktop/src/main/**/*.ts',
        'apps/desktop/src/shared/**/*.ts',
      ],
      exclude: ['**/*.test.ts', '**/*.run.ts'],
      reporter: ['text-summary', 'json-summary'],
    },
  },
});
