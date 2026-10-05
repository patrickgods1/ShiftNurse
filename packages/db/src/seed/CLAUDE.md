# db/seed

> Loaded automatically when Claude works on files under this folder. Cross-cutting rules live in the root `CLAUDE.md`.

- **Two kinds of seeded data, for two audiences.** The realistic demos an evaluator explores
  are `DemoProfile`s (`seed/demo/profiles.ts`: community med-surg, VA San Francisco med-surg,
  California ICU) run through one engine (`seed/demo/engine.ts`); `seed/demo.ts` holds
  `seedDemoUnit(db, { demo })` and the `DEMO_SUMMARIES` the welcome screen lists through
  `setup.demos`. Each profile's numbers come from real practice for that setting, stated in its
  comment, and nothing is planted. A new demo is a profile, a summary and a test file in
  `seed/demo/` that runs `realisticDemoChecks` (`checks.test-support.ts`, excluded from the
  package build) plus the facts particular to that unit. `seed/scenarios.ts` (`seedScenarioUnit`) is the
  test-scenario database with known, asserted problems; the main-process fixture, repository
  tests and the solver benchmark are built on it, and `npm run dev` offers it on the welcome
  screen. **Tests never use the demo as a fixture** — its data should be free to become more
  realistic — and **the scenario data must not change**: test expectations are pinned to it
  (even an extra inactive nurse changes a generated schedule, since the solver sees every nurse
  in roster order). A new scenario is appended from its own `Rng` together with re-pinned tests
  and a re-run `npm run bench:solvers`. The benchmark's scenario row is *not* reproducible run
  to run — ids are random UUIDs, so each seeding solves differently (three seedings gave
  objectives of 76,760–79,497) — so compare its medians and rankings, not exact numbers; the
  fixture-only rows (synthetic-24, small-8) are exact.
- **Demo data must be staffable by construction.** Each demo's contracted hours are sized to
  its floors, the history is staffed by the engine's `canWork`, which mirrors the unit's own rule
  set (rest from shift windows, stretch and all-night limits, days off after a maximum stretch,
  leave by shift date, hire dates), and `canRemove` checks every shift it moves away or calls
  off, and to the *forecast* census the rule engine judges by. Every demo's test runs Generate
  on its draft at the app's default budget and requires every floor filled, and requires fewer
  than 5% of nurse-pay-periods to read "under contract" (paid leave and sick calls are credited).
  A nurse at contract who picks up a call-off still reads "over contract": the rule counts any
  hours past it. The contracted hours are 72h a pay period for full-time 12-hour
  staff (three 12s under a 40h overtime threshold). Changing floors, census or the roster mix
  means re-running the demo tests in `seed/demo/`. The VA demo is a compressed biweekly
  schedule: full-time rows carry a `shortShift` (one D8 a pay period on top of six 12s, 80h),
  which the engine holds hours back for and places in a pass of its own, and its rule set judges
  overtime by pay period. The D8 runs inside the day 12 (`within: 'D12'`), which covers it, and
  the engine lets a new grad onto it only with an experienced RN on the D8 or that day's D12.
  The engine counts hours, not shifts, which for the all-12-hour demos is the same arithmetic
  scaled: their seeded data did not change. A profile's `keptApart` groups (the VA demo has an
  RN pair, a trio of nursing assistants, and five LVNs at most two at a time) are created before
  the history, and `canWork`
  refuses any shift that would put a member on the floor with another once their group applies.
  Members are drawn one per role/position slot, never a charge nurse or new grad, and spread
  across days, nights and the intermittent pool: two full-timers each working seven day tours a
  pay period cannot be separated by splitting fourteen days, and a real ward separates people by
  tour; a group of five is staffable only with a cap above one. The RNG draws for them happen only when a profile has groups, so the other demos'
  data did not change.
