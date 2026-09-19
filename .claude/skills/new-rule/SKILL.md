---
name: new-rule
description: Scaffold a new ShiftNurse scheduling rule end to end — params interface, Rule<P> implementation, ViolationCode, registration in ALL_RULES, and tests. Use when adding a union/contract constraint such as a rest, hours, coverage, safety or equity check to packages/core/src/rules.
---

# Add a scheduling rule

Rules are **data plus a small evaluator** held in a registry, not logic baked into the solver.
One new `Rule` picked up by `ALL_RULES` is automatically used by the solver's feasibility check,
the grid's live validation, the pre-publish compliance report, and day-of replacement eligibility
(see the header of `packages/core/src/rules/types.ts`).

Read `packages/core/src/rules/rest-rules.ts` first — `minRestRule` is the reference shape.

## Step 1 — Decide the rule's identity

- `id` — kebab-case and stable; it is persisted in rule-set configs (e.g. `min-rest-between-shifts`).
- `name` — short title shown in the compliance report.
- `description` — plain language for the manager's Rules screen.
- `category` — one of `'rest' | 'hours' | 'coverage' | 'safety' | 'equity'` (`Rule` in `rules/types.ts`).
- `severity` — `'hard'` (illegal; the solver will not emit it) or `'soft'` (advisory warning the
  manager may knowingly accept). "Legal but unfair" pressure belongs in the objective functions,
  not in a soft rule.
- `scope` — `'nurse'` when the verdict follows from one nurse's own timeline (rest, hours, leave,
  double-booking) or `'shift'` when it follows from who is on one shift (floors, charge, skill
  mix, credentials). The solver checks rules incrementally on a single-nurse or single-shift
  view, so this must be truthful: a `nurse` rule that peeks at other nurses would pass in the
  solver and fail on the grid. See `RuleScope` in `rules/types.ts`.

## Step 2 — Define the params interface

Params are persisted per rule set and edited by the manager, so every field gets a doc comment
saying what it means in contract language and what units it is in.

```ts
export interface MaxNightsPerPeriodParams {
  /** Maximum night shifts a nurse may work in one schedule period. */
  maxNights: number;
  /** Whether on-call standby counts toward the cap. Usually it does not. */
  onCallCountsAsWork: boolean;
}
```

`resolveConfigs()` in `rules/registry.ts` merges stored params **over** the registry defaults, so
**adding a parameter to an existing rule is backward compatible** — rule sets saved before the
param existed fall back to the new default instead of crashing. Removing or renaming a param is
not; treat those as migrations.

## Step 3 — Implement `Rule<P>`

Follow `minRestRule` in `rules/rest-rules.ts`. Put the rule in the file matching its category
(`rest-rules.ts`, `hours-rules.ts`, `coverage-rules.ts`, `availability-rules.ts`) or a new file.

- Iterate `ctx.nurses`; get each nurse's ordered timeline with `schedule.timelineFor(nurse.id)`.
- Filter out on-call standby with `isWorked` from `rules/types.ts` unless params say otherwise.
- Do all time arithmetic through `packages/core/src/domain/time.ts` — `restMinutesBetween`,
  `windowsOverlap`, `minutesToHours`, `dayNumber`, `weekendKey`. Never subtract raw timestamps for
  a duration and never call `new Date()`; the module header explains the DST reasoning.
- Skip violations that lie entirely outside the period: `if (!previous.inPeriod && !current.inPeriod) continue;`
  History cannot be fixed, only flagged when this schedule can act on it.
- Precomputed joins you may need are already on `RuleContext`: `approvedTimeOffByNurse`,
  `nurseCredentials`, `credentialsById`, `holidayDates`, `demand`, `weekendDefinition`.

## Step 4 — Add the `ViolationCode`

Add a new member to the `ViolationCode` union in `packages/core/src/rules/types.ts`. The UI groups
and routes on this code, so it must be a real union member, never a free string.

## Step 5 — Build violations with the helper

Use `violation()` from `rules/types.ts`, and `nurseName(nurse)` for the name.

**The message must name the nurse, the dates, and BOTH the actual and the required value.** This
text is quoted verbatim in union grievances. Put the same numbers in `details` for the UI, and
fill `nurseIds`, `dates` and `assignmentIds` so the grid can badge the right cells.

## Step 6 — Register in `ALL_RULES`

Add the rule to the `ALL_RULES` array in `packages/core/src/rules/registry.ts` and import it at
the top. Ordering is **presentational only**: violations come back in registry order, so the
compliance report reads from "unsafe" down to "unfair" — place a safety rule near the top, an
equity rule near the bottom. `defaultRuleSet()` picks the new rule up automatically.

## Step 7 — Tests

Add a `describe` block to `packages/core/src/rules/rules.test.ts` using `scenario()`, `makeNurse()`
and `assign()` / `assignRun()` from `packages/core/src/testing/fixtures.ts`. The file's `codes()`
and `evaluate()` helpers keep assertions terse. Cover at minimum:

1. **The satisfied case** — `expect(codes(s)).not.toContain('your_code')`.
2. **The violated case** — assert the code fires and `details` carries the right actual/required.
3. **The boundary value** — exactly at the limit must pass (see "accepts exactly five days in a
   row" in `rules.test.ts`). Off-by-one here is the most common rule bug.

Also worth covering when relevant: a violation carried in from the previous period via
`priorAssignments`, and on-call being excluded (`ON_CALL` fixture). Fixture shift types available:
`DAY_12`, `NIGHT_12`, `DAY_8`, `EVENING_8`, `NIGHT_8`, `ON_CALL`; also `coverageAllWeek()`,
`census()`, `timeOff()`, `nurseCredential()`, `credentialRequirement()`.

## Worked skeleton

```ts
// packages/core/src/rules/rest-rules.ts
import { isWorked, nurseName, type Rule, type Violation, violation } from './types.js';

export interface MaxNightsPerPeriodParams {
  /** Maximum night shifts a nurse may work in one schedule period. */
  maxNights: number;
  /** Whether on-call standby counts toward the cap. */
  onCallCountsAsWork: boolean;
}

export const maxNightsPerPeriodRule: Rule<MaxNightsPerPeriodParams> = {
  id: 'max-nights-per-period',
  name: 'Night shifts per period',
  description: 'Caps how many night shifts one nurse may work in a single schedule period.',
  severity: 'soft',
  category: 'rest',
  scope: 'nurse',
  defaultParams: { maxNights: 7, onCallCountsAsWork: false },

  evaluate(schedule, params, ctx): Violation[] {
    const violations: Violation[] = [];
    for (const nurse of ctx.nurses) {
      const nights = schedule
        .timelineFor(nurse.id)
        .filter((v) => v.inPeriod && v.shiftType.isNight)
        .filter((v) => params.onCallCountsAsWork || isWorked(v));
      if (nights.length <= params.maxNights) continue;

      violations.push(
        violation(
          maxNightsPerPeriodRule,
          'soft',
          'too_many_nights_per_period', // add to the ViolationCode union first
          `${nurseName(nurse)} is scheduled ${nights.length} night shifts this period. ` +
            `Maximum is ${params.maxNights}.`,
          {
            nurseIds: [nurse.id],
            dates: nights.map((v) => v.assignment.date),
            assignmentIds: nights.map((v) => v.assignment.id),
            details: { actual: nights.length, maximum: params.maxNights },
          },
        ),
      );
    }
    return violations;
  },
};
```

Then: add `'too_many_nights_per_period'` to `ViolationCode`, add `maxNightsPerPeriodRule` to
`ALL_RULES`, and write the three tests.

## Verify

Run `npm run check` from the repo root (lint + typecheck + vitest). Do not install anything.
