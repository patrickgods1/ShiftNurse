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
- **A profile can carry a state or federal preset and switch on off-by-default rules.**
  `jurisdiction` (the VA demo's `US-VA` with `jurisdictionChoices: { compressedTour: true }`, both
  California demos' `CA` with `{ alternativeWorkweek: true }`) runs `applyJurisdiction` right after
  the rule set is saved and before any period, so every published period snapshots the version in
  force, and the engine re-reads its limits and the unit's ratio staffing (charge nurse off the
  bedside) from it; a profile leaves out the pay rules and rules the preset sets; `rules.enable`
  turns on rules by id, with `rules.params` as their settings. Where `weekend-pattern` is on,
  `canWork` keeps each nurse to its run and per-window limits (counted by `weekendKey`, four
  weekends to a window, and per pay period as the rule judges it), which for two in four comes to
  alternate weekends: each half of every role works its own, the engine holds back hours on weekdays
  for the nurse's coming weekend, lends across halves only to avoid a short shift, and tops a nurse
  up on a legal day when the weekends left them short of hours. Where `no-mandatory-overtime` is on,
  about a third of the full- and part-time staff get standing overtime offers (`overtime_volunteer`)
  covering the history and the draft, and a placement that could be overtime is asked only of them;
  everyone else stays inside the pay period's threshold, so the history has no required overtime.
  All of these draws and branches are gated on the rule being on (the CA preset switches it on for
  both California demos).
- **A profile can seed the federal and HR features too, each behind its own optional field.**
  The VA demo sets `leaveBalances` (VA accrual by role and years of service, the 240-hour
  carry-over; part-time pro rata), `fmla` (three certifications: intermittent, ended, current),
  `preceptorships` (two new-grad orientations of 12 weeks from the hire date, which the field
  sets; `canWork` places an orientee only on a shift, or the one it runs inside, their preceptor
  already works, and the balancing and call-off passes never take a preceptor off a shift an
  orientee is on), `floatUnit` and `annualLeaveBid` (open or closed by the seeding date, never
  awarded: that is the manager's step). The draws for balances, certifications, floats and bids
  come after everything else and only where set; preceptors are chosen by seniority, not drawn,
  so the other demos' data did not change. The sibling unit (`4B Telemetry`) has shift types and
  float members only, and `SeedResult.unitId` stays the demo unit, which the renderer opens
  (`UnitProvider` takes the first unit by name). Two units means queries on a bare table (the
  shift types, say) need a `unit_id` filter. The VA history is staffed on a thin margin: moving a
  hire date by a week can tip a weekend shift short, so re-run the VA test after changing one.
  `holdovers` (the VA demo: four volunteered, on a D8, a D12 and an N12 and, 60 minutes, on a
  72/80 nurse's D12) are placed on published
  history with no random draw, through `recordHoldover`, only where the extra time keeps the
  next rest at the unit's minimum and the pay period within 80 hours, so the held-over minutes
  are the row's only overtime. A holdover names a `scheduleKind` or goes to a standard nurse.
- **The VA demo carries three nurses on the VA's own plans** (`scheduleKind` on a roster row,
  appended last so the other staff's draws come first): two RNs on 72/80 (0.9 FTE, 72 hours a
  pay period, one D12 and one N12) and one on Baylor (1.0, 48 hours, N12). San Francisco ended
  its 72/80 plan in 2023, so they show the model; the unit's full-time 6x12 + 8 stays. `canWork`
  keeps them on plan (12-hour tours only; Baylor on Saturday, Sunday or Friday night, outside the
  weekend caps; a 72/80 nurse at three tours a week), and they are never drawn into a kept-apart
  group. Their paid leave takes the `paid-leave` rule's own whole-tour split (a Baylor nurse's
  weekday leave pays nothing), so a request over two pay periods credits what the rule does. The
  Baylor nurse always volunteers for overtime; a plan nurse is asked past their own hours only to
  cover a call-off, and that tour is marked overtime. Tests that assumed every full-time RN works 80 hours are scoped to standard nurses.
