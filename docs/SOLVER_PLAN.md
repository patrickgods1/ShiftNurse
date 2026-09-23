# Solver plan: SA + LNS, CP-SAT, Hybrid

> **Where this lives:** `docs/SOLVER_PLAN.md`, adopted in Phase 0. `ROADMAP.md` tracks it as
> **M15 — Selectable solvers**. Tick a box only when the work has landed **and** its check has passed, the
> same rule as ROADMAP.md.
>
> **Each phase ends in its own commit and push** to `origin` (github.com/patrickgods1/ShiftNurse).
> Phases 1–2 go straight to `main` because each is self-contained and ships working. Phases 3–5
> share the branch `feat/or-tools` and are pushed per phase. That branch is merged to `main` only
> after Phase 5 passes, so `main` never has a half-wired OR-Tools setup.

## Context
ShiftNurse ships one solver (greedy seed → annealing + ruin-and-recreate). `solver/types.ts`
already defines a `Solver` interface, but `solve()` in `solver.ts` and `main/solver-worker.ts`
hard-wire it, so nothing selects between solvers.

The INRC-I/II literature research points to three backends:
- **SA + LNS**: the current engine, upgraded with the Ceschia, Guido & Schaerf block moves.
- **CP-SAT**: exact, with an optimality gap.
- **Hybrid**: annealing, with CP-SAT re-optimising small windows.

Decisions:
- OR-Tools ships as a small C++ helper program (the "runner") built by GitHub Actions.
- Hybrid is the default. The fallback is whichever of SA+LNS / CP-SAT scores better on the
  benchmark. SA+LNS is the only backend that needs no OR-Tools binary.
- This reverses the ROADMAP's locked decision "Pure TS engine, no runtime to bundle".

## Invariants (every phase)
- `packages/core` stays pure. It only builds models and reads answers (`encode`/`decode`,
  plain data). Starting the runner, sending it data and cancelling it all happen in Electron main.
- Every nurse's timeline is legal. Decoded CP-SAT assignments are loaded into `SolverModel`,
  and each must pass `canAdd`. A failure throws, naming the nurse and date.
- One report path: `buildReport` → `evaluateSchedule` / `scoreFairness` / `costSchedule`.
  `ObjectiveBreakdown` comes from `SolverModel.breakdown()` for every backend.
- Deterministic: CP-SAT uses `num_workers: 1`, `random_seed` = the period seed, and
  `max_deterministic_time` as the budget. The wall clock is only a safety valve.
- Test-first in `packages/core`: watch each new test fail before making it pass.
- `npm run check` must be green before every commit. The pre-commit hook enforces it.

---

## Phase 0 — Adopt the plan
- [x] 0.1 Copy this file to `docs/SOLVER_PLAN.md`.
- [x] 0.2 Add **M15 — Selectable solvers** to `ROADMAP.md`, linking here, with its phases as
      unchecked boxes.
- [x] 0.3 In ROADMAP's locked decisions, mark "Solver: Pure TypeScript engine" as *superseded by
      M15* (SA+LNS stays pure TS; CP-SAT/hybrid add a native runner).
- [x] 0.4 **Commit & push to `main`:** "Plan M15: selectable solvers (SA+LNS, CP-SAT, hybrid)".

## Phase 1 — Solver registry and setting (SA+LNS is the only backend so far)
**Core**
- [x] 1.1 Move `buildReport` and `unfilledFrom` from `solver/solver.ts` into `solver/report.ts`,
      with no behaviour change (the existing solver tests stay green).
- [x] 1.2 `solver/types.ts`:
  - Add `export type SolverId = 'hybrid' | 'sa-lns' | 'cp-sat'`.
  - Add `SolveStats.solver: SolverId`.
  - Add `SolveStats.bound?: number` and `SolveStats.gap?: number`.
  - Add `SolveStats.fellBackFrom?: { solver: SolverId; reason: string }`.
- [x] 1.3 `solver/registry.ts`:
  - `DEFAULT_SOLVER_ID = 'hybrid'`.
  - `FALLBACK_ORDER: readonly SolverId[] = ['hybrid', 'sa-lns', 'cp-sat']`, provisional until
    Phase 5.
  - `requiresOrTools(id): boolean`.
  - `PURE_SOLVERS: Partial<Record<SolverId, Solver>> = { 'sa-lns': localSearchSolver }`.
  - `resolveSolverId(requested, available): { id, fellBackFrom? }`.
- [x] 1.4 Test (write first): `resolveSolverId` picks the requested solver when it's available.
      When `hybrid` is requested but OR-Tools is missing, it falls back along `FALLBACK_ORDER`
      to the first available solver and records why.
- [x] 1.5 Export the new types and functions from `packages/core/src/index.ts`.

**DB**
- [x] 1.6 `schema.ts`: add a `solver_settings` table: `id`, `unitId` (unique, FK cascade),
      `solverId` (text, default `'hybrid'`), `maxIterations` (int, nullable). It follows the
      `conflict_policy` pattern.
- [x] 1.7 Generate the migration and check the SQL by hand.
- [x] 1.8 `repositories/solver.ts`: `getSolverSettings(db, unitId)` returns the default when there
      is no row; `saveSolverSettings(db, unitId, settings, actor)` validates the id and writes an
      audit entry (`create`, or `update` with `before`).
- [x] 1.9 `repositories/solver.test.ts`: the default for a unit with no row; saving and reading
      back; the update audit entry carries `before`; an unknown solver id is refused.

**IPC / main**
- [x] 1.10 `shared/api.ts`:
  - `solverSettings: { get(unitId), save(unitId, settings) }`.
  - `solver.available(): SolverAvailability[]` (id, available, reason?).
  - `SolveJobOptions.solver?: SolverId`.
  - Add the new channels to `API_CHANNELS`.
- [x] 1.11 `main/api.ts`: implement the new methods. In Phase 1, `available()` reports `sa-lns`
      only; the others say "OR-Tools runner not installed".
- [x] 1.12 `main/solver-jobs.ts`: resolve the solver as per-run choice → unit default →
      `resolveSolverId`. Pass the `solverId` in `SolverWorkerData`. The applied-solve audit
      entry records `solver` and `fellBackFrom`.
- [x] 1.13 `main/solver-worker.ts`: pick the backend from the registry, not the hard-wired
      `solve`.
- [x] 1.14 Extend `solver-jobs` tests (if present) or add them: a job requesting `hybrid` with
      no runner reports `fellBackFrom`. *(Done as `main/solver-choice.test.ts`, which tests the
      choice apart from the worker, plus a smoke assertion on the real job.)*

**Renderer**
- [x] 1.15 `api-solver.ts`: `useSolverSettings`, `useSaveSolverSettings`,
      `useSolverAvailability`.
- [x] 1.16 `pages/settings/solver.tsx`:
  - A radio list: Hybrid (recommended), SA + LNS, CP-SAT, each with a one-line trade-off.
  - Unavailable options are disabled and show the reason.
  - A "falls back to…" note.
- [x] 1.17 `pages/settings.tsx`: add a **Solver** tab.
- [x] 1.18 `schedule/generate-dialog.tsx`: a solver select, preset to the unit default. The result
      summary shows the solver used, the fallback reason and the gap when present.

**Check and ship**
- [x] 1.19 `npm run check` is green.
- [x] 1.20 `npm run build:packages && npm run smoke -w @shiftnurse/desktop` is green.
- [x] 1.21 Manual: in Settings › Solver, Hybrid is selected. Generating falls back to SA+LNS and
      the dialog says why. *(Automated in `main/smoke.ts`: the Solver tab renders 3 options with
      hybrid checked, and Generate reports the fallback.)*
- [x] 1.22 **Commit & push to `main`:** "Add solver registry and per-unit solver setting".

## Phase 2 — SA + LNS upgrade (`packages/core/src/solver/anneal.ts`)
- [ ] 2.1 Test (first, must fail): *"two nurses trade their preferred 3-night blocks"*.
  - Each nurse holds the other's preferred block.
  - A single-shift swap is blocked by the rest rule.
  - Assert that after the solve each nurse holds their preferred block. The expected result is
    worked out by hand.
- [ ] 2.2 Implement `blockSwap(model, rng)`:
  - Pick two same-role nurses, both eligible for each other's shifts, and a run of 2–7
    consecutive days.
  - Swap all their unlocked assignments in that run.
  - Remove everything first, then add; if either timeline fails the gate, undo all of it.
  - Returns a `Move` with an exact `undo`.
- [ ] 2.3 Implement `multiDayReassign(model, rng)`: move one nurse's 2–7 day block to another
      eligible nurse, using the same gate and undo pattern.
- [ ] 2.4 Add both to `randomMove` with fixed weights, documented in the header comment with
      the reason (the Ceschia et al. 2020 citation).
- [ ] 2.5 Test: the block moves never touch a locked assignment.
- [ ] 2.6 Test: the existing property suite still passes (no nurse-scope hard violations; same
      seed → identical schedule; locks preserved).
- [ ] 2.7 Record the demo objective before and after (seed-fixed) in the commit message. If it
      got worse, retune the weights, `TARGETED` or `LNS_EVERY` and record why.
- [ ] 2.8 Update the `anneal.ts` header ("Why block moves").
- [ ] 2.9 `npm run check` is green. Generate on the demo fills every floor.
- [ ] 2.10 Run `/scheduling-review` on the diff.
- [ ] 2.11 **Commit & push to `main`:** "Add block-swap and multi-day reassign moves to the
      annealer".

## Phase 3 — OR-Tools runner and packaging (branch `feat/or-tools`)
**Runner**
- [ ] 3.1 `git checkout -b feat/or-tools`.
- [ ] 3.2 `native/cpsat-runner/CMakeLists.txt`: link against a pinned OR-Tools C++ release
      archive (record the version and URL in the file).
- [ ] 3.3 `native/cpsat-runner/main.cc`, reading and writing one JSON object per line:
  - Requests: `{"id","model"(CpModelProto JSON),"params"(SatParameters JSON)}` or
    `{"stop":true}`.
  - Progress lines: `{"id","type":"progress","objective","bound","wallMs"}`, sent from the
    solution callback.
  - Final line: `{"id","type":"result","status","values":[...],"objective","bound"}`.
  - Errors: `{"id","type":"error","message"}`. The process stays alive for the next request.
  - `stop` calls `StopSearch` through the solver's stop flag.
- [ ] 3.4 `native/cpsat-runner/test/smoke.jsonl`: a 3-variable model with a known optimum
      (worked out by hand) and the expected result line.
- [ ] 3.5 `native/cpsat-runner/README.md`: the protocol and how to build locally
      (`brew install cmake`).

**CI**
- [ ] 3.6 `.github/workflows/cpsat-runner.yml`:
  - A matrix of `macos-14` (arm64), `macos-13` (x64) and `windows-2022` (x64).
  - Each job: fetch the OR-Tools archive, run cmake, build, then pipe the smoke model in and
    `diff` against the expected output.
- [ ] 3.7 On tag `cpsat-runner-v*`: upload `cpsat-runner-<platform>-<arch>[.exe]` and
      `SHA256SUMS` to the GitHub release.
- [ ] 3.8 Push the branch; the workflow is green on all three runners.
- [ ] 3.9 Tag `cpsat-runner-v1` and confirm the release assets exist.

**Fetch and bundle**
- [ ] 3.10 `apps/desktop/scripts/fetch-cpsat.mjs`: `fetchCpsat({platform, arch, dest})`.
  - Downloads the pinned release asset and checks it against `SHA256SUMS`, failing on a mismatch.
  - Sets `chmod +x` on mac.
- [ ] 3.11 Call it from `postinstall` for the host into `apps/desktop/.cpsat/`, and add
      `.cpsat/` to `.gitignore`.
- [ ] 3.12 `scripts/before-pack.mjs`: call `fetchCpsat` per target next to
      `fetchSqliteForElectron`.
- [ ] 3.13 `electron-builder.yml`: `extraResources` for `.cpsat/` → `cpsat/`.

**Main-process client**
- [ ] 3.14 `main/cpsat-process.ts`:
  - `resolveRunnerPath()`: `process.resourcesPath/cpsat` when packaged, `.cpsat/` in dev.
  - `class CpsatRunner`: `start()`, `solve(model, params, onProgress)` returning a Promise,
    `stop()`, `dispose()`.
  - The request queue has one request in flight at a time.
- [ ] 3.15 `main/cpsat-process.test.ts`: runs against a fake runner script that follows the same
      protocol. Covers the result, progress, error and stop paths, and a crashed runner rejecting
      its pending request.
- [ ] 3.16 `SolverJobs.stopAll` also disposes the runners. `solver.available()` now reports
      OR-Tools as available when `resolveRunnerPath()` finds an executable.

**Check and ship**
- [ ] 3.17 `npm run check` is green.
- [ ] 3.18 `npm run dist` (mac): the `.app` contains `Contents/Resources/cpsat/cpsat-runner`.
      `smoke:packaged` is green.
- [ ] 3.19 **Commit & push to `feat/or-tools`:** "Add CP-SAT runner, CI build and per-target
      bundling".

## Phase 4 — CP-SAT backend (`packages/core/src/solver/cpsat/`, test-first)
**Encoding**
- [ ] 4.1 `cpsat/proto.ts`: minimal TS types for the parts of `CpModelProto`, `SatParameters`
      and `CpSolverResponse` that we use.
- [ ] 4.2 `cpsat/vars.ts`: builds the variables.
  - `x[n,d,s]` only where it can be true: the role matches, credentials are held, and there is
    no approved time off. Reuse `SolverModel.eligible` logic; do not re-derive it.
  - `charge[n,d,s] ≤ x` for charge-capable nurses.
  - Locked assignments fixed to 1; lookback-tail shifts as constants.
- [ ] 4.3 Test: *"a nurse on approved leave gets no variable that week"*; *"a locked shift is
      fixed on"*.
- [ ] 4.4 `cpsat/rules/rest.ts`, for `no-overlapping-assignments` and `min-rest-between-shifts`:
      at-most-one over pairs closer than the rest gap on the wall-clock timeline.
  - Test first: a 19:00–07:00 night then a 07:00 day is a forbidden pair (0 h rest,
    hand-computed).
  - Test: nights across the spring DST weekend are judged with the same 12 h as any other week.
- [ ] 4.5 `cpsat/rules/consecutive.ts` (`max-consecutive-shifts`): sliding window, Σ ≤ k.
  - Test: 4 in a row is allowed and the 5th is forbidden when k = 4.
- [ ] 4.6 `cpsat/rules/hours.ts` (`max-hours-per-week`): Σ `durationHours·x` + tail ≤ max per
      work week, with the week start from the rule params.
  - Test: a shift in the lookback tail counts toward week 1.
- [ ] 4.7 `cpsat/rules/coverage.ts` (`coverage-minimums`, `patient-ratio-compliance`):
      Σ staffed + `short` ≥ required from `SolveInput.demand`. Charge and all-novice use the
      same counting-with-slack pattern.
- [ ] 4.8 `cpsat/rules/contract.ts` (`fte-target-hours`): per pay period,
      hours + `under` ≥ contracted.
- [ ] 4.9 `approved-time-off-is-absolute`: handled by 4.2 (no variable). Registered as
      `'by-construction'`.
- [ ] 4.10 `cpsat/encoders.ts`: `CPSAT_ENCODERS: Record<string, Encoder | 'by-construction'>`.
- [ ] 4.11 Test: *"every registered rule has a CP-SAT encoding"*. It iterates `ALL_RULES` and
      fails on any missing id.
- [ ] 4.12 `encode()` refuses to run, with the rule id named, when an enabled hard rule has no
      encoder.

**Objective**
- [ ] 4.13 `cpsat/objective.ts`: `ObjectiveWeights` scaled to integers, with the scale factor
      stated in one constant.
  - Terms: `short`, over-target, `under`, preferences, straight-time cost.
- [ ] 4.14 Fairness: burden counts as integer expressions. The positive deviation from a fair
      share pinned to `contractedHoursPerPeriod` is squared via `AddMultiplicationEquality`.
- [ ] 4.15 Test: the objective of a hand-built 2-nurse, 3-day solution equals
      `SolverModel.breakdown().total` for the same assignments, within the scaling rounding.

**Decode and backend**
- [ ] 4.16 `cpsat/decode.ts`: response values → `Assignment[]`, with locked ids echoed back. Each
      assignment is loaded into `SolverModel` via `canAdd`/`add`, and a failure throws naming the
      nurse, date and shift.
- [ ] 4.17 Test: a hand-written response that breaks the rest rule makes decode throw.
- [ ] 4.18 `cpsat/params.ts`: `num_workers: 1`, `random_seed: seed`,
      `max_deterministic_time` from options.
- [ ] 4.19 Main: `main/solver-backends.ts`, `cp-sat` backend: `encode` → `CpsatRunner.solve` →
      `decode` → `buildReport`. It maps progress onto `SolveProgress` and cancel onto `stop`,
      and fills `stats.bound` and `stats.gap`.
- [ ] 4.20 Integration test (skipped when the runner is missing): the fixtures unit solves, has no
      nurse-scope hard violations, and two runs give identical assignments.

**Check and ship**
- [ ] 4.21 `npm run check` is green.
- [ ] 4.22 Manual: Generate with CP-SAT on the demo. Every floor is filled and the gap is shown.
- [ ] 4.23 Run `/scheduling-review` on the diff.
- [ ] 4.24 **Commit & push to `feat/or-tools`:** "Add CP-SAT solver backend".

## Phase 5 — Hybrid backend and benchmark
**Core (pure and synchronous)**
- [ ] 5.1 `solver/stepwise.ts`: `createLocalSearch(input, options)`, which provides:
  - `seed()`, `runAnneal(iterations)`, `pickWindow(rng)` (2–3 days, weighted toward the worst
    coverage/fairness days), `encodeWindow(window)` (the Phase 4 encoders, with everything
    outside the window fixed).
  - `applyWindow(assignments)` (through the model gate; accepted only if the objective doesn't
    get worse), `report(stats)`.
- [ ] 5.2 Test: `applyWindow` never changes an assignment outside the window.
- [ ] 5.3 Test: a window solution that makes the objective worse is rejected and the model state
      is unchanged.
- [ ] 5.4 Test: `pickWindow` is deterministic for a given seed.

**Main**
- [ ] 5.5 `hybrid` backend: seed → a loop of `runAnneal(N)` → `pickWindow` → CP-SAT solve →
      `applyWindow`, until the iteration budget is spent. It reports progress and handles cancel.
- [ ] 5.6 If the runner fails mid-run, finish as SA+LNS and set
      `fellBackFrom: { solver: 'hybrid', reason }`.
- [ ] 5.7 Integration test (skipped when the runner is missing): identical schedules across two
      runs; the objective is ≤ SA+LNS on the fixtures with the same seed and budget.

**Benchmark**
- [ ] 5.8 `packages/core/src/solver/bench/` and a root script `npm run bench:solvers`:
  - Runs every available backend on the demo and fixture units at 3 seeds.
  - Writes `docs/solver-bench.md` (objective, breakdown, unfilled, gap, time).
- [ ] 5.9 Set `FALLBACK_ORDER` to hybrid, then whichever of SA+LNS / CP-SAT has the lower
      median objective. The comment cites `docs/solver-bench.md` and its date.
- [ ] 5.10 Update the Settings › Solver copy to match the measured trade-offs.

**Check and ship**
- [ ] 5.11 `npm run check` is green.
- [ ] 5.12 Extend `main/smoke.ts` to generate once with each available backend, and assert that
      regenerating is identical and no nurse-scope hard violations appear.
- [ ] 5.13 `npm run smoke` and, after `npm run dist`, `smoke:packaged` are green on mac arm64.
      Mac x64 is run under Rosetta.
- [ ] 5.14 Run `/scheduling-review` on the diff.
- [ ] 5.15 **Commit & push to `feat/or-tools`:** "Add hybrid SA + CP-SAT solver and benchmark".
- [ ] 5.16 Open a PR from `feat/or-tools` to `main`. CI is green; merge.

## Phase 6 — Docs
- [ ] 6.1 `CLAUDE.md`: Current state (the solver registry, `cpsat/`, the runner), the commands
      (`bench:solvers`), and the new conventions (every rule needs a CP-SAT encoder; the runner
      lives in main; CP-SAT determinism settings).
- [ ] 6.2 `README.md`: building the runner locally, the CI release flow, and bumping OR-Tools.
- [ ] 6.3 `ARCHITECTURE.md`: why a C++ sidecar (no JS bindings; Python too heavy) and why the
      hybrid is the default.
- [ ] 6.4 `ROADMAP.md`: tick M15. Windows real-hardware launch stays open and now also covers
      the runner.
- [ ] 6.5 **Commit & push to `main`:** "Document selectable solvers (M15)".

## Open risk
- The Windows runner is built in CI but, like the installer, not launched on real Windows 11
  hardware until the existing M14 item is done.
