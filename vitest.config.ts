import { configDefaults, defineConfig } from 'vitest/config';

// v8 instrumentation slows the solver-heavy tests 2-3x, so a coverage run gets longer limits (a
// plain `npm test` still fails a hang fast). Detected from the flag rather than set in the npm
// script, because `VAR=1 cmd` does not work in Windows' cmd; the env var lets the per-test
// `slow()` helpers see it in the workers, which inherit the environment.
if (process.argv.includes('--coverage')) process.env.COVERAGE = '1';
const SCALE = process.env.COVERAGE ? 3 : 1;

// Files that run a full solve. Under 100 parallel workers they time out and pass alone, so they
// get their own project that runs one file at a time after the fast tests.
const SOLVER_HEAVY = [
  'packages/db/src/seed/demo/*.test.ts',
  'packages/core/src/solver/cpsat/index.test.ts',
  'apps/desktop/src/main/api/solver.test.ts',
  'apps/desktop/src/main/cpsat-backend.test.ts',
];

const INCLUDE = [
  'packages/*/src/**/*.test.ts',
  'apps/desktop/src/renderer/src/**/*.test.{ts,tsx}',
  'apps/desktop/src/main/**/*.test.ts',
  'apps/desktop/src/shared/**/*.test.ts',
];

export default defineConfig({
  test: {
    testTimeout: 5_000 * SCALE,
    hookTimeout: 10_000 * SCALE,
    // `include` lives in each project: a root-level one is inherited by `extends: true` and
    // would put every file in solver-heavy too.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: INCLUDE,
          exclude: [...configDefaults.exclude, ...SOLVER_HEAVY],
        },
      },
      {
        extends: true,
        test: {
          name: 'solver-heavy',
          include: SOLVER_HEAVY,
          fileParallelism: false,
          maxConcurrency: 1,
        },
      },
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
        'apps/desktop/src/renderer/src/**/*.{ts,tsx}',
      ],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.test-support.ts',
        '**/*.run.ts',
        // The in-app smoke driver: it runs only inside the real Electron app (npm run smoke).
        'apps/desktop/src/main/smoke.ts',
        'apps/desktop/src/renderer/src/test/**',
      ],
      reporter: ['text-summary', 'json-summary'],
    },
  },
});
