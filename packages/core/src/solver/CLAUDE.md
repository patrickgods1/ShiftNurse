# core/solver

> Loaded automatically when Claude works on files under this folder. Cross-cutting rules live in the root `CLAUDE.md`. How each rule is priced by both solvers is stated on that rule in `packages/core/CLAUDE.md`. These apply equally to the main-process halves (`apps/desktop/src/main/solver-*.ts`, `ortools-solvers.ts`, `cpsat-*.ts`).

## M15 — Selectable solvers

- **M15 — Selectable solvers** (complete; plan of record `docs/SOLVER_PLAN.md`, results
  `docs/solver-bench.md`): Settings › Generate (the solver tab) picks **hybrid** (default), **SA + LNS** or **CP-SAT**
  per unit; the Generate dialog overrides per run. `native/cpsat-runner` is the C++ OR-Tools
  runner (JSON lines, `runner.proto`), built by `.github/workflows/cpsat-runner.yml` and released
  as `cpsat-runner-v*`; `apps/desktop/scripts/fetch-cpsat.mjs` pins tag + SHA-256 and fills
  `.cpsat/host` (postinstall) and `.cpsat/target` (before-pack). In main: `cpsat-process.ts`
  (runner client), `ortools-solvers.ts` (CP-SAT and hybrid orchestration, used by the worker and
  the benchmark), `solver-choice.ts` / `solver-backends.ts` (availability and fallback),
  `solver-bench.run.ts` (`npm run bench:solvers`).

`npm run bench:solvers` runs every solver × three units × three seeds → `docs/solver-bench.md`. Needs the runner; minutes; not part of `npm test`. `FALLBACK_ORDER` cites its result.

## Conventions

- **Generate speaks in the manager's numbers.** `buildReport` adds `SolveReport.digest`
  (`solver/digest.ts`: nights per nurse who works nights, weekends per contracted nurse, quick
  flips, nurses under contract, shifts against preferences), which the Generate dialog, the
  candidates bar and the comparison show in place of the solver's score.
- **The solver is deterministic by construction.** All randomness comes from `Rng` seeded from
  a hash of the period id; the iteration budget, not the clock, ends the run (the wall-clock limit
  is a safety valve). Anything that depends on wall time in a solve path breaks "regenerate
  unchanged inputs → identical schedule", which the smoke test asserts. A batch's variation k is
  seeded `seedFor(period) + k`, so variation 1 is the schedule a single Generate always gave and
  the same inputs give the same variations whatever ran in parallel. "Generate more" passes
  `continueAfter`, carrying numbering and seeds on (a second batch of three is variations 4–6 —
  `SolveBatchStatus.offset`), so it searches seeds not yet tried; unticking it starts over at 1.
  The offset lives in memory with the batch, so a restart begins again at variation 1. The grid's
  own schedule is scored beside every batch (`draftObjective`) and counts as a contender: when no
  variation beats it, the app says keep it.
- **Generate candidates go stale by fingerprint, not by event.** `inputFingerprint`
  (`main/solver-plan.ts`) hashes the whole `SolveInput` minus the unlocked draft rows the solver
  discards; `solver.current`/`candidate`/`save` re-check it, so any change to anything the solver
  reads — a table added later included — drops the candidates and `save` refuses them. OR-Tools
  variations run `floor(cores / SEARCH_WORKERS)` at a time: oversubscribing the runner's threads
  only stretches wall time into the hybrid's fallback, which is a different schedule.
- **The OR-Tools runner lives in the solver worker, never in core or on the main thread.**
  Core holds the pure halves (`prepareCpsat`/`finishCpsat`, `LocalSearch.encodeWindow`/
  `applyWindow`); `main/ortools-solvers.ts` does the async step between. CP-SAT is deterministic
  only as configured in `cpsat/params.ts`: 8 workers with `interleave_search`, a seed from the
  period, a deterministic-time budget — its parallel portfolio is faster but not reproducible.
  A runner that is missing, crashes or times out makes the hybrid finish as SA + LNS with
  `fellBackFrom` set; that is a *different schedule*, which is why the ready timeout is generous.
  A runner that fails part-way after windows were applied reports `solver: 'hybrid'` with
  `fellBackFrom` naming when it stopped. An encoding disagreement (`EncodingDisagreementError`) is
  never a runner failure: it fails the run.
  Whole-period CP-SAT that reports INFEASIBLE/MODEL_INVALID (`CpsatInfeasibleError`) is an
  encoding bug, not the pins' fault: it finishes as SA + LNS on the same seed with
  `fellBackFrom: cp-sat` and a reason saying so, listing locked shifts that already break a hard
  rule (`lockedHardViolations`) as context only.
- **The solver gates removals too.** `SolverModel.isLegal` re-checks a nurse who lost a shift:
  some rules are not monotone under removal. A waived turnaround (night Mon, waived day Tue, day
  Wed, 36 h owed after a night) is legal, but without Tuesday the night sits 24 h before
  Wednesday's day; `long-stretch` is the other. The night cap counts night runs wherever they
  sit, so it is monotone under removal. Any new move that takes a shift from a nurse must
  re-check them. `retype` trades a nurse's shift for another type of the same length on the same
  day, gated like `relocate`. The gate tolerates a hard breach only if every shift it names is
  locked or in the lookback tail and the locked shifts alone already had the same breach at least
  as big (`solver/gate.ts`); a pinned problem never freezes a nurse out, and Generate never deepens,
  merges or trades it.
- **What Generate does not steer by (stated limits).** Some soft rules are judged on the grid but
  carry no price in either solver while soft, so Generate neither seeks nor avoids them:
  `max-hours-in-24`, `long-stretch`, `tour-rotation` and `days-off-together`. Make one hard to
  have Generate keep to it. INRC-II's pattern terms (minimum consecutive days worked, complete
  weekends, per-shift-type consecutive limits) are not modelled. Both are deferred: adding a
  price changes the objective of SA + LNS and CP-SAT alike, which needs a bench study and a
  determinism re-pin.
- **Solver speed-ups must not change a schedule.** `SolverModel` caches fairness (cleared in
  `count`), staffing per shift and role, prepared rules (`prepareRules`/`evaluatePrepared`) and
  per-nurse rule contexts. `solver/model.test.ts` checks every cached term against a fresh
  rebuild after a random walk of moves and undos. Array order is behaviour (`pickUnlocked` samples
  by index, `ensureCharge` takes the first eligible nurse on the roster), so no swap-removes.
  Check a performance change by hashing SA + LNS output on fixed inputs before and after.
  Ids are compared by code unit, never `localeCompare` (host locale).
- **Fair shares come from `computeBurden`.** `historyFairness` hands both solvers each nurse's
  `fairWeight` (contracted share × exposure, rounded to hundredths); SA prices
  `teamTotal × fairWeight / teamFairWeight` and CP-SAT the same in integers (`shareUnit` ≤ 100), so
  Generate prices the fair share the Fairness page shows. A change to the fairness model is a
  change to both solvers' objective: re-run `npm run bench:solvers`.
