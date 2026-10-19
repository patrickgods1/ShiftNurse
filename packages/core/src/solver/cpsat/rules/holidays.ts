/**
 * The holiday rotation as constraints, for a rule set that makes it hard: a nurse owed a
 * holiday off works no shift on it, and nobody works both halves of a paired holiday. Which
 * holidays a shift works is the unit's attribution (`SolverModel.holidaysWorked`), never the
 * worked window, as the rule judges it. While
 * the rule is soft it is priced instead (`holidayTerms` in `objective.ts`); the facts both read
 * are the model's own (`SolverModel.holidayFacts`), so the two agree on who is owed what.
 */

import { inHolidayRotation, workedInHistory } from '../../../rules/holiday-rotation.js';
import { describe, type EncodeContext, forbidPair } from '../context.js';

export function encodeHolidayRotation(ctx: EncodeContext): void {
  const facts = ctx.model.holidayFacts;
  for (const [n, vars] of ctx.byNurse.entries()) {
    // A Baylor nurse is owed nothing, so the pairs do not bind them either.
    if (vars.length === 0 || !inHolidayRotation(ctx.model.nurses[n]!)) continue;
    const worked = ctx.timeline(n).filter((e) => !e.shiftType.isOnCall);
    // Which holidays each shift works, by the unit's attribution: the rule's and the annealer's.
    const holidaysOf = new Map(
      worked.map((e) => [e, ctx.model.holidaysWorked(e.date, e.shiftType)]),
    );
    const owed = facts.owedOff.get(ctx.model.nurses[n]!.id);
    for (const e of worked) {
      if (e.literal === null || !e.inPeriod) continue;
      if (!holidaysOf.get(e)!.some((d) => owed?.has(d))) continue;
      ctx.b.linear(
        { terms: [[e.literal, 1]], constant: 0 },
        0,
        0,
        `holiday owed off: ${ctx.name(n)} ${describe(e)}`,
      );
    }
    const nurseId = ctx.model.nurses[n]!.id;
    const start = ctx.input.period.startDate;
    for (const { minor, major } of facts.pairs) {
      const onMinor = worked.filter((e) => holidaysOf.get(e)!.includes(minor.date));
      const onMajor = worked.filter((e) => holidaysOf.get(e)!.includes(major.date));
      // A half worked on record (Memorial Day in May) rules out every shift on the other.
      for (const [done, other] of [
        [minor, onMajor],
        [major, onMinor],
      ] as const) {
        if (!workedInHistory(ctx.model.ctx, nurseId, done, start)) continue;
        for (const e of other) {
          if (e.literal === null) continue;
          ctx.b.linear(
            { terms: [[e.literal, 1]], constant: 0 },
            0,
            0,
            `holiday pair: ${ctx.name(n)} ${done.name} ${done.date} on record / ${describe(e)}`,
          );
        }
      }
      for (const a of onMinor) {
        for (const b of onMajor) {
          const label = `holiday pair: ${ctx.name(n)} ${describe(a)} / ${describe(b)}`;
          // By the clock one night can work both halves: it alone is the pair.
          if (a === b) {
            if (a.literal !== null)
              ctx.b.linear({ terms: [[a.literal, 1]], constant: 0 }, 0, 0, label);
            continue;
          }
          forbidPair(ctx, a, b, label);
        }
      }
    }
  }
}
