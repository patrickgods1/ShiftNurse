/**
 * Whether this launch is the headless smoke run. Kept apart from `smoke.ts` so the entry point
 * can ask without loading the whole harness, which only a smoke run ever needs.
 */
export function isSmokeRun(): boolean {
  return process.env.SHIFTNURSE_SMOKE === '1';
}
