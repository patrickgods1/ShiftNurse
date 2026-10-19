/**
 * Whether this launch is the headless smoke run. Kept apart from `smoke.ts` so the entry point
 * can ask without loading the whole harness, which only a smoke run ever needs.
 */
export function isSmokeRun(): boolean {
  return process.env.SHIFTNURSE_SMOKE === '1';
}

/**
 * A smoke time limit from the environment, or `fallbackMs` when it is unset or unusable.
 * `scripts/smoke.mjs` refuses a bad value before launch; this guards a binary started with
 * SHIFTNURSE_SMOKE=1 by hand, where Number('4min') would be NaN and NaN ms fires at once.
 */
export function smokeTimeoutMs(raw: string | undefined, fallbackMs: number): number {
  if (raw === undefined || raw.trim() === '') return fallbackMs;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : fallbackMs;
}
