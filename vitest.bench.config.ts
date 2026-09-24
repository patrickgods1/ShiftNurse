import { defineConfig } from 'vitest/config';

/**
 * `npm run bench:solvers`: the solver benchmark, run as a single long "test" so it can use the
 * desktop's TypeScript runner client and core's fixtures without a separate TS runtime. Not part
 * of `npm test` — it takes minutes and needs the OR-Tools runner.
 */
export default defineConfig({
  test: {
    include: ['apps/desktop/src/main/solver-bench.run.ts'],
    environment: 'node',
    testTimeout: 60 * 60 * 1000,
  },
});
