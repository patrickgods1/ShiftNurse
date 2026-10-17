/**
 * Per-test timeouts for the solver-heavy tests. They are hang guards, not performance
 * assertions: the solves are seeded and iteration-bounded, so a run only fails to finish if
 * something inside an iteration hangs. The literals are set at roughly 4x the idle time measured
 * on the development machine, so a plain `npm test` still fails a real hang fast. v8 coverage
 * runs these 2-3x slower, so `npm run test:coverage` (COVERAGE=1) triples them. A busy machine or
 * slow runner should set `SHIFTNURSE_TEST_SLOW_SCALE` (a number >= 1; anything else is ignored)
 * rather than edit a literal. CI does not set it. An explicit timeout beats the config-wide one,
 * which is why these tests cannot lean on vitest.config.ts alone.
 */
const envScale = Number(process.env.SHIFTNURSE_TEST_SLOW_SCALE);
const scale =
  (process.env.COVERAGE ? 3 : 1) * (Number.isFinite(envScale) && envScale >= 1 ? envScale : 1);

export const slow = (ms: number): number => ms * scale;
