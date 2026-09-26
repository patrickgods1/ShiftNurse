import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/desktop/src/renderer/src/**/*.test.ts',
      'apps/desktop/src/main/**/*.test.ts',
    ],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/desktop/src/main/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.run.ts'],
      reporter: ['text-summary', 'json-summary'],
    },
  },
});
