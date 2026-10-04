/**
 * Per-test timeouts for the solver-heavy tests. v8 coverage instruments every line and runs these
 * 2-3x slower, so `npm run test:coverage` (which sets COVERAGE=1) scales the limits; a plain
 * `npm test` keeps them tight so a real hang still fails fast. An explicit timeout beats the
 * config-wide one, which is why these tests cannot lean on vitest.config.ts alone.
 */
export const slow = (ms: number): number => ms * (process.env.COVERAGE ? 3 : 1);
