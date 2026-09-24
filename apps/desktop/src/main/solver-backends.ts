/**
 * The OR-Tools solver backends (CP-SAT, hybrid) and the one runner process they share.
 *
 * Core registers the pure backends it can run in the worker thread (`PURE_SOLVERS`); these need
 * the native runner, so they live in main. A backend is offered to the manager only when both
 * its code is registered here *and* the runner binary is installed — either alone would make
 * Generate pick a solver that cannot run.
 */

import type { SolverId } from '@shiftnurse/core';
import { app } from 'electron';
import { CpsatRunner, resolveRunnerPath } from './cpsat-process.js';

/** OR-Tools backends implemented in this build. CP-SAT and hybrid land in M15 phases 4 and 5. */
export const ORTOOLS_BACKEND_IDS: ReadonlySet<SolverId> = new Set<SolverId>();

let runnerPath: string | undefined | null = null;
let runner: CpsatRunner | undefined;

/** The installed runner binary, looked up once per launch; undefined when it is not installed. */
export function cpsatRunnerPath(): string | undefined {
  if (runnerPath === null) {
    runnerPath = resolveRunnerPath({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    });
  }
  return runnerPath;
}

/** The shared runner, spawned on first use. */
export function cpsatRunner(): CpsatRunner {
  const path = cpsatRunnerPath();
  if (!path) throw new Error('The OR-Tools runner is not installed');
  runner ??= new CpsatRunner(path);
  return runner;
}

/** Called on quit, so a CP-SAT search never outlives the app. */
export function disposeCpsatRunner(): void {
  runner?.dispose();
  runner = undefined;
}
