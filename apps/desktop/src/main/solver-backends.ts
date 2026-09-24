/**
 * The OR-Tools solver backends (CP-SAT, hybrid): which are in this build, and where the runner is.
 *
 * Core registers the pure backends it can run in the worker thread (`PURE_SOLVERS`); these need
 * the native runner, so they live in main. A backend is offered to the manager only when both
 * its code is registered here *and* the runner binary is installed — either alone would make
 * Generate pick a solver that cannot run. Each solve job spawns its own runner inside the solver
 * worker thread (see solver-worker.ts), so nothing here holds a process.
 */

import type { SolverId } from '@shiftnurse/core';
import { app } from 'electron';
import { resolveRunnerPath } from './cpsat-process.js';

/** OR-Tools backends implemented in this build. */
export const ORTOOLS_BACKEND_IDS: ReadonlySet<SolverId> = new Set<SolverId>(['cp-sat', 'hybrid']);

let runnerPath: string | undefined | null = null;

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
