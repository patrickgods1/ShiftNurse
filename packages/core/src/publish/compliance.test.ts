import { describe, expect, it } from 'vitest';
import type { CoverageRequirement } from '../domain/entities.js';
import { addDays, isoDate } from '../domain/time.js';
import {
  assign,
  assignRun,
  CRED_ACLS,
  census,
  coverageAllWeek,
  DAY_12,
  makeNurse,
  NIGHT_12,
  nurseCredential,
  resetFixtureCounters,
  scenario,
  TIER_ROUTINE,
} from '../testing/fixtures.js';
import { complianceAlerts } from './compliance.js';

function alertsFor(
  s: ReturnType<typeof scenario>,
  extra: Partial<Parameters<typeof complianceAlerts>[0]> = {},
) {
  return complianceAlerts({
    schedule: s.schedule,
    credentials: s.ctx.credentials,
    nurseCredentials: [...s.ctx.nurseCredentials.values()].flat(),
    demand: s.ctx.demand.all(),
    overtimeThresholdHours: 40,
    workWeekStartsOn: 0,
    hoursDriftTolerance: 0.1,
    payPeriodDays: s.unit.payPeriodDays,
    ...extra,
  });
}

describe('complianceAlerts', () => {
  it('names the shifts a nurse is rostered on after her ACLS lapses mid-period', () => {
    resetFixtureCounters();
    const nurse = makeNurse({ id: 'n1', contractedHoursPerPeriod: 36 });
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign('n1', DAY_12, '2026-01-05', { id: 'before' }),
        assign('n1', DAY_12, '2026-01-10', { id: 'on-expiry' }),
        assign('n1', DAY_12, '2026-01-12', { id: 'after' }),
      ],
      nurseCredentials: [nurseCredential('n1', CRED_ACLS, { expiresOn: '2026-01-10' as never })],
    });
    const alerts = alertsFor(s).filter((a) => a.kind === 'credential_expiry');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: 'critical',
      nurseId: 'n1',
      assignmentIds: ['on-expiry', 'after'],
    });
    expect(alerts[0]!.message).toContain('ACLS');
    expect(alerts[0]!.message).toContain('2026-01-10');
  });

  it('only warns when a credential expires in the period but the nurse has no shifts after it', () => {
    resetFixtureCounters();
    const nurse = makeNurse({ id: 'n1', contractedHoursPerPeriod: 12 });
    const s = scenario({
      nurses: [nurse],
      assignments: [assign('n1', DAY_12, '2026-01-05')],
      nurseCredentials: [nurseCredential('n1', CRED_ACLS, { expiresOn: '2026-01-15' as never })],
    });
    const alerts = alertsFor(s).filter((a) => a.kind === 'credential_expiry');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe('warning');
    expect(alerts[0]!.assignmentIds).toEqual([]);
  });

  it('stays quiet about a credential that outlives the period', () => {
    resetFixtureCounters();
    const s = scenario({
      nurses: [makeNurse({ id: 'n1', contractedHoursPerPeriod: 12 })],
      assignments: [assign('n1', DAY_12, '2026-01-05')],
      nurseCredentials: [nurseCredential('n1', CRED_ACLS, { expiresOn: '2026-03-01' as never })],
    });
    expect(alertsFor(s).filter((a) => a.kind === 'credential_expiry')).toEqual([]);
  });

  it('flags a 72-hour nurse scheduled for 96 hours as drifting over contract, and one at 48 as under', () => {
    resetFixtureCounters();
    const over = makeNurse({ id: 'over', contractedHoursPerPeriod: 72 });
    const under = makeNurse({ id: 'under', contractedHoursPerPeriod: 72 });
    const onTarget = makeNurse({ id: 'ok', contractedHoursPerPeriod: 72 });
    const s = scenario({
      nurses: [over, under, onTarget],
      assignments: [
        // 8 twelves = 96h, spread so no week alone trips overtime maths in this test.
        ...assignRun('over', DAY_12, '2026-01-04', 4),
        ...assignRun('over', DAY_12, '2026-01-11', 4),
        ...assignRun('under', DAY_12, '2026-01-04', 2),
        ...assignRun('under', DAY_12, '2026-01-11', 2),
        ...assignRun('ok', DAY_12, '2026-01-04', 3),
        ...assignRun('ok', DAY_12, '2026-01-11', 3),
      ],
    });
    const drift = alertsFor(s, { overtimeThresholdHours: 60 }).filter(
      (a) => a.kind === 'hours_drift',
    );
    expect(drift.map((a) => [a.nurseId, a.hours, a.expectedHours])).toEqual([
      ['over', 96, 72],
      ['under', 48, 72],
    ]);
    expect(drift[0]!.message).toContain('+33%');
    expect(drift[1]!.message).toContain('-33%');
  });

  it('scales the contract to the schedule length: 72h per pay period is 216h over six weeks', () => {
    resetFixtureCounters();
    const s = scenario({
      startDate: '2026-01-04' as never,
      endDate: '2026-02-14' as never,
      nurses: [makeNurse({ id: 'n1', contractedHoursPerPeriod: 72 })],
      // Three twelves a week for six weeks: exactly on contract, so no drift alert.
      assignments: [0, 1, 2, 3, 4, 5].flatMap((week) =>
        assignRun('n1', DAY_12, addDays(isoDate('2026-01-04'), week * 7), 3),
      ),
    });
    const drift = alertsFor(s, { overtimeThresholdHours: 60 }).filter(
      (a) => a.kind === 'hours_drift',
    );
    expect(drift).toEqual([]);
  });

  it('exempts per-diem nurses from hours drift: they have no contracted floor', () => {
    resetFixtureCounters();
    const s = scenario({
      nurses: [makeNurse({ id: 'pd', employmentType: 'per_diem', contractedHoursPerPeriod: 0 })],
      assignments: assignRun('pd', DAY_12, '2026-01-04', 2),
    });
    expect(alertsFor(s).filter((a) => a.kind === 'hours_drift')).toEqual([]);
  });

  it('reports a 48-hour week as 8 hours of overtime against a 40-hour threshold', () => {
    resetFixtureCounters();
    const s = scenario({
      nurses: [makeNurse({ id: 'n1', contractedHoursPerPeriod: 84 })],
      // Sun 4 Jan – Sat 10 Jan is one work week starting Sunday: four twelves = 48h.
      assignments: [
        ...assignRun('n1', DAY_12, '2026-01-04', 4),
        ...assignRun('n1', DAY_12, '2026-01-11', 3),
      ],
    });
    const ot = alertsFor(s).filter((a) => a.kind === 'overtime');
    expect(ot).toHaveLength(1);
    expect(ot[0]).toMatchObject({ nurseId: 'n1', date: '2026-01-04', hours: 48 });
    expect(ot[0]!.message).toContain('8h');
  });

  it('marks a night staffed exactly at the patient ratio as ratio-risk: one call-off breaches it', () => {
    resetFixtureCounters();
    // Ten routine patients at 1:5 need two RNs by ratio; no coverage floor is set.
    const mix = { [TIER_ROUTINE.id]: 10 };
    const s = scenario({
      startDate: '2026-01-04' as never,
      endDate: '2026-01-05' as never,
      nurses: [makeNurse({ id: 'a' }), makeNurse({ id: 'b' }), makeNurse({ id: 'c' })],
      censusForecasts: [census('2026-01-04', NIGHT_12, mix), census('2026-01-05', NIGHT_12, mix)],
      assignments: [
        assign('a', NIGHT_12, '2026-01-04'),
        assign('b', NIGHT_12, '2026-01-04'),
        // The 5th has slack: three on for a ratio minimum of two.
        assign('a', NIGHT_12, '2026-01-05'),
        assign('b', NIGHT_12, '2026-01-05'),
        assign('c', NIGHT_12, '2026-01-05'),
      ],
    });
    const risk = alertsFor(s).filter((a) => a.kind === 'ratio_risk');
    expect(risk).toHaveLength(1);
    expect(risk[0]).toMatchObject({
      date: '2026-01-04',
      shiftTypeId: NIGHT_12.id,
      severity: 'warning',
    });
    expect(risk[0]!.message).toContain('RN');
    expect(risk[0]!.message).toContain('1:5');
  });

  it('does not call a shift at its coverage floor ratio-risk when no patient ratio binds', () => {
    resetFixtureCounters();
    const floors: CoverageRequirement[] = coverageAllWeek(NIGHT_12, 'RN', 2, 2);
    const s = scenario({
      startDate: '2026-01-04' as never,
      endDate: '2026-01-04' as never,
      nurses: [makeNurse({ id: 'a' }), makeNurse({ id: 'b' })],
      coverageRequirements: floors,
      assignments: [assign('a', NIGHT_12, '2026-01-04'), assign('b', NIGHT_12, '2026-01-04')],
    });
    expect(alertsFor(s).filter((a) => a.kind === 'ratio_risk')).toEqual([]);
  });
});
