import { describe, expect, it } from 'vitest';
import type { CoverageRequirement } from '../domain/entities.js';
import { addDays, isoDate } from '../domain/time.js';
import {
  assign,
  assignRun,
  CRED_ACLS,
  census,
  coverageAllWeek,
  DAY_8,
  DAY_12,
  makeNurse,
  NIGHT_12,
  nurseCredential,
  resetFixtureCounters,
  scenario,
  TIER_ROUTINE,
  timeOff,
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
    // The card is valid through the 10th, as the grid's credential rule reads it: only the 12th
    // is worked on a lapsed card.
    expect(alerts[0]).toMatchObject({
      severity: 'critical',
      nurseId: 'n1',
      assignmentIds: ['after'],
    });
    expect(alerts[0]!.message).toContain('ACLS');
    expect(alerts[0]!.message).toContain('expires Sat Jan 10');
    expect(alerts[0]!.message).toContain('1 shift after that date');
  });

  it('treats a shift on the expiry date as worked on a valid card, as the grid does', () => {
    resetFixtureCounters();
    const nurse = makeNurse({ id: 'n1', contractedHoursPerPeriod: 36 });
    const s = scenario({
      nurses: [nurse],
      assignments: [assign('n1', DAY_12, '2026-01-10', { id: 'on-expiry' })],
      nurseCredentials: [nurseCredential('n1', CRED_ACLS, { expiresOn: '2026-01-10' as never })],
    });
    const alerts = alertsFor(s).filter((a) => a.kind === 'credential_expiry');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: 'warning', assignmentIds: [] });
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

  it('stays quiet about a credential that outlives the period by more than a month', () => {
    resetFixtureCounters();
    // The period ends Sat 17 Jan; 1 March is 43 days later.
    const s = scenario({
      nurses: [makeNurse({ id: 'n1', contractedHoursPerPeriod: 12 })],
      assignments: [assign('n1', DAY_12, '2026-01-05')],
      nurseCredentials: [nurseCredential('n1', CRED_ACLS, { expiresOn: '2026-03-01' as never })],
    });
    expect(alertsFor(s).filter((a) => a.kind === 'credential_expiry')).toEqual([]);
  });

  it('warns a month ahead about a card that lapses soon after the period, before the next one', () => {
    resetFixtureCounters();
    // The period ends Sat 17 Jan; Fri 30 Jan is 13 days later, inside the 30-day look-ahead, and
    // 16 Feb (30 days later) is its last day. 17 Feb is outside it.
    const s = scenario({
      nurses: [
        makeNurse({ id: 'soon', contractedHoursPerPeriod: 12 }),
        makeNurse({ id: 'edge', contractedHoursPerPeriod: 12 }),
        makeNurse({ id: 'later', contractedHoursPerPeriod: 12 }),
      ],
      assignments: [
        assign('soon', DAY_12, '2026-01-05'),
        assign('edge', DAY_12, '2026-01-06'),
        assign('later', DAY_12, '2026-01-07'),
      ],
      nurseCredentials: [
        nurseCredential('soon', CRED_ACLS, { expiresOn: '2026-01-30' as never }),
        nurseCredential('edge', CRED_ACLS, { expiresOn: '2026-02-16' as never }),
        nurseCredential('later', CRED_ACLS, { expiresOn: '2026-02-17' as never }),
      ],
    });
    const alerts = alertsFor(s).filter((a) => a.kind === 'credential_expiry');
    expect(alerts.map((a) => a.nurseId).sort()).toEqual(['edge', 'soon']);
    const soon = alerts.find((a) => a.nurseId === 'soon')!;
    expect(soon).toMatchObject({ severity: 'warning', assignmentIds: [] });
    expect(soon.message).toContain('expires Fri Jan 30');
    expect(soon.message).toContain('13 days after this period ends');
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

  it('warns of overtime past 80 hours in the pay period, not past 40 in the week', () => {
    resetFixtureCounters();
    // Six 12s and an 8 in the Sun 4 – Sat 17 Jan pay period: 44h then 36h, 80h in all.
    const fortnight = [
      ...['2026-01-04', '2026-01-06', '2026-01-08', '2026-01-12', '2026-01-14', '2026-01-16'].map(
        (d) => assign('n1', DAY_12, d),
      ),
      assign('n1', DAY_8, '2026-01-09'),
    ];
    const nurses = [makeNurse({ id: 'n1', contractedHoursPerPeriod: 80 })];
    const s = scenario({ nurses, assignments: fortnight });
    const payPeriodOvertime = { thresholdHours: 80, payPeriodAnchor: s.unit.payPeriodAnchor };
    const overtime = (sc: typeof s, extra = {}) =>
      alertsFor(sc, extra).filter((a) => a.kind === 'overtime');

    expect(overtime(s, { payPeriodOvertime })).toEqual([]);
    expect(overtime(s)).toHaveLength(1); // weekly: the 44-hour week

    const extra = scenario({
      nurses,
      assignments: [...fortnight, assign('n1', DAY_12, '2026-01-17')],
    });
    const over = overtime(extra, { payPeriodOvertime });
    expect(over).toMatchObject([{ nurseId: 'n1', date: '2026-01-04', hours: 92 }]);
    expect(over[0]!.message).toMatch(/12h overtime in the pay period from Sun Jan 4/);
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
  it('does not flag a nurse back from a paid vacation as drifting under contract', () => {
    resetFixtureCounters();
    const nurse = makeNurse({ id: 'n1', contractedHoursPerPeriod: 72 });
    const s = scenario({
      nurses: [nurse],
      timeOff: [timeOff('n1', '2026-01-04', '2026-01-10', { paidHours: 36 })],
      assignments: [
        assign('n1', DAY_12, '2026-01-11'),
        assign('n1', DAY_12, '2026-01-13'),
        assign('n1', DAY_12, '2026-01-15'),
      ], // 36 worked + 36 paid leave = the 72 contracted
    });
    expect(
      alertsFor(s, { paidLeaveByNurse: s.ctx.paidLeaveByNurse }).filter(
        (a) => a.kind === 'hours_drift',
      ),
    ).toEqual([]);
  });

  it('warns of overtime from paid leave only where the contract counts leave toward it', () => {
    resetFixtureCounters();
    const nurse = makeNurse({ id: 'n1', contractedHoursPerPeriod: 84 });
    const s = scenario({
      nurses: [nurse],
      timeOff: [timeOff('n1', '2026-01-06', '2026-01-06', { paidHours: 12 })],
      assignments: [
        assign('n1', DAY_12, '2026-01-04'),
        assign('n1', DAY_12, '2026-01-07'),
        assign('n1', DAY_12, '2026-01-09'),
      ], // 36 worked + 12 PTO in the week of 4 January
    });
    const overtime = (counts: boolean) =>
      alertsFor(s, {
        paidLeaveByNurse: s.ctx.paidLeaveByNurse,
        paidLeaveCountsTowardOvertime: counts,
      }).filter((a) => a.kind === 'overtime');
    expect(overtime(false)).toEqual([]);
    expect(overtime(true)).toMatchObject([{ nurseId: 'n1', hours: 48 }]);
  });
});

describe('hours drift with a holdover', () => {
  it('does not say a nurse is over her contract because she was held over 2 hours', () => {
    resetFixtureCounters();
    // Six 12s is the 72h she is contracted for; the 2h holdover is overtime, not drift (74h worked
    // would be +2.8%, over this 2% tolerance).
    const nurse = makeNurse({ id: 'n1', contractedHoursPerPeriod: 72 });
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign('n1', DAY_12, '2026-01-05'),
        assign('n1', DAY_12, '2026-01-06'),
        assign('n1', DAY_12, '2026-01-07'),
        assign('n1', DAY_12, '2026-01-12'),
        assign('n1', DAY_12, '2026-01-13'),
        assign('n1', DAY_12, '2026-01-14', { holdoverMinutes: 120, holdoverMandated: true }),
      ],
    });
    expect(
      alertsFor(s, { hoursDriftTolerance: 0.02 }).filter((a) => a.kind === 'hours_drift'),
    ).toEqual([]);
  });

  it('still counts the holdover as overtime in a week of 36 scheduled hours and 6 held over', () => {
    resetFixtureCounters();
    const nurse = makeNurse({ id: 'n1', contractedHoursPerPeriod: 72 });
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign('n1', DAY_12, '2026-01-04'),
        assign('n1', DAY_12, '2026-01-07'),
        assign('n1', DAY_12, '2026-01-09', { holdoverMinutes: 360, holdoverMandated: true }),
      ],
    });
    const alert = alertsFor(s).find((a) => a.kind === 'overtime');
    expect(alert).toMatchObject({ hours: 42, expectedHours: 40 });
  });
});

describe('late posting', () => {
  // The period starts Sunday 2026-11-01; with 14 days' notice the schedule is due Sunday 2026-10-18.
  const november = () =>
    scenario({
      nurses: [makeNurse({ id: 'n1', contractedHoursPerPeriod: 36 })],
      startDate: isoDate('2026-11-01'),
      endDate: isoDate('2026-11-14'),
    });
  const late = (publishDate: string, leadDays = 14) =>
    alertsFor(november(), { posting: { leadDays, publishDate: isoDate(publishDate) } }).filter(
      (a) => a.kind === 'late_posting',
    );

  it('says nothing when the schedule goes out on the last day of the notice', () => {
    expect(late('2026-10-18')).toEqual([]);
  });

  it('warns that a schedule posted a day after the notice date is a day late', () => {
    const alerts = late('2026-10-19');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: 'warning', assignmentIds: [] });
    // 19 October to 1 November is 13 days.
    expect(alerts[0]!.message).toBe(
      "Publishing on Mon Oct 19 gives 13 days' notice, 1 day short of the unit's 14-day notice",
    );
  });

  it('counts several days late in the plural', () => {
    expect(late('2026-10-21')[0]!.message).toContain(
      "gives 11 days' notice, 3 days short of the unit's 14-day notice",
    );
  });

  it("says a day's notice, not a days' one, the day before the period starts", () => {
    expect(late('2026-10-31')[0]!.message).toContain("gives 1 day's notice, 13 days short");
  });

  it('does not check a unit with no posting notice', () => {
    expect(alertsFor(november()).filter((a) => a.kind === 'late_posting')).toEqual([]);
  });
});

describe('per-diem commitment', () => {
  const commitment = (weekend: number, holiday = 0) => ({
    weekendShiftsPer4Weeks: weekend,
    holidayShiftsPerYear: holiday,
  });
  const perDiem = (id: string) => makeNurse({ id, employmentType: 'per_diem', fte: 0 });
  const commitmentAlerts = (
    s: ReturnType<typeof scenario>,
    extra: Partial<Parameters<typeof complianceAlerts>[0]>,
  ) => alertsFor(s, extra).filter((a) => a.kind === 'per_diem_commitment');

  // 2026-01-04 is a Sunday: the 4-week period holds Sat 10, Sun 11, Sat 17, Sun 18, ...
  const fourWeeks = (nurses: ReturnType<typeof makeNurse>[], assignments: never[] | unknown[]) =>
    scenario({
      nurses,
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-31'),
      assignments: assignments as never,
    });

  it('flags a per-diem nurse with one weekend shift in a four-week schedule when the contract asks for two', () => {
    resetFixtureCounters();
    const s = fourWeeks(
      [perDiem('pd')],
      [
        assign('pd', DAY_12, '2026-01-07', { id: 'wed' }),
        assign('pd', DAY_12, '2026-01-10', { id: 'sat' }),
      ],
    );
    const alerts = commitmentAlerts(s, { perDiemCommitment: commitment(2) });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: 'warning',
      nurseId: 'pd',
      assignmentIds: ['sat'],
    });
    expect(alerts[0]!.hours).toBeUndefined();
    expect(alerts[0]!.message).toContain('1 weekend shift');
    expect(alerts[0]!.message).toContain('2');
  });

  it('is satisfied by two weekend shifts in four weeks', () => {
    resetFixtureCounters();
    const s = fourWeeks(
      [perDiem('pd')],
      [assign('pd', DAY_12, '2026-01-10'), assign('pd', DAY_12, '2026-01-18')],
    );
    expect(commitmentAlerts(s, { perDiemCommitment: commitment(2) })).toEqual([]);
  });

  it('asks three weekend shifts of a six-week schedule', () => {
    resetFixtureCounters();
    const six = (dates: string[]) =>
      scenario({
        nurses: [perDiem('pd')],
        startDate: isoDate('2026-01-04'),
        endDate: isoDate('2026-02-14'),
        assignments: dates.map((d) => assign('pd', DAY_12, d)),
      });
    // 2 per 4 weeks over 42 days is 3.
    expect(
      commitmentAlerts(six(['2026-01-10', '2026-01-18']), { perDiemCommitment: commitment(2) }),
    ).toHaveLength(1);
    expect(
      commitmentAlerts(six(['2026-01-10', '2026-01-18', '2026-01-24']), {
        perDiemCommitment: commitment(2),
      }),
    ).toEqual([]);
  });

  it('asks one weekend shift of a two-week schedule', () => {
    resetFixtureCounters();
    const s = scenario({
      nurses: [perDiem('pd')],
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
      assignments: [assign('pd', DAY_12, '2026-01-10')],
    });
    expect(commitmentAlerts(s, { perDiemCommitment: commitment(2) })).toEqual([]);
  });

  it('does not count standby toward the weekend commitment', () => {
    resetFixtureCounters();
    const onCall = { ...DAY_12, id: 'st-oc', isOnCall: true };
    const s = scenario({
      nurses: [perDiem('pd')],
      shiftTypes: [DAY_12, onCall],
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
      assignments: [assign('pd', onCall, '2026-01-10')],
    });
    expect(commitmentAlerts(s, { perDiemCommitment: commitment(2) })).toHaveLength(1);
  });

  it('does not check full-time staff', () => {
    resetFixtureCounters();
    const s = fourWeeks([makeNurse({ id: 'ft', contractedHoursPerPeriod: 36 })], []);
    expect(commitmentAlerts(s, { perDiemCommitment: commitment(2, 1) })).toEqual([]);
  });

  it('checks nothing when the unit has no commitment', () => {
    resetFixtureCounters();
    const s = fourWeeks([perDiem('pd')], []);
    expect(commitmentAlerts(s, {})).toEqual([]);
  });

  describe('holidays', () => {
    const holidays = [
      { id: 'h-jul4', unitId: 'unit-1', date: isoDate('2026-07-04'), name: 'Independence Day' },
      { id: 'h-xmas', unitId: 'unit-1', date: isoDate('2026-12-25'), name: 'Christmas Day' },
    ].map((h) => ({ ...h, isMajor: true, pairedHolidayId: null }));
    const worked = (...entries: [string, string[]][]) =>
      new Map(entries.map(([id, nurses]) => [id, new Set(nurses)]));
    // Sun 6 Dec to Sat 26 Dec holds Christmas, the last holiday of 2026.
    const december = (nurses: ReturnType<typeof makeNurse>[], assignments: unknown[] = []) =>
      scenario({
        nurses,
        holidays,
        startDate: isoDate('2026-12-06'),
        endDate: isoDate('2026-12-26'),
        assignments: assignments as never,
      });

    it("judges the holiday commitment in the period holding the year's last holiday", () => {
      resetFixtureCounters();
      const s = december([perDiem('worked-july'), perDiem('none')]);
      const alerts = commitmentAlerts(s, {
        perDiemCommitment: commitment(0, 1),
        holidays,
        holidayWorkedBy: worked(['h-jul4', ['worked-july']]),
      });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ severity: 'warning', nurseId: 'none', assignmentIds: [] });
      expect(alerts[0]!.message).toContain('2026');
    });

    it('counts a Christmas shift in this period toward the year', () => {
      resetFixtureCounters();
      const s = december([perDiem('xmas')], [assign('xmas', DAY_12, '2026-12-25')]);
      expect(commitmentAlerts(s, { perDiemCommitment: commitment(0, 1), holidays })).toEqual([]);
    });

    it('asks two holidays when the contract says two, counting history and this period', () => {
      resetFixtureCounters();
      const s = december([perDiem('both'), perDiem('one')], [assign('both', DAY_12, '2026-12-25')]);
      const alerts = commitmentAlerts(s, {
        perDiemCommitment: commitment(0, 2),
        holidays,
        holidayWorkedBy: worked(['h-jul4', ['both', 'one']]),
      });
      expect(alerts.map((a) => a.nurseId)).toEqual(['one']);
    });

    it("leaves the holiday commitment alone in a period without the year's last holiday", () => {
      resetFixtureCounters();
      const s = scenario({
        nurses: [perDiem('none')],
        holidays,
        startDate: isoDate('2026-06-28'),
        endDate: isoDate('2026-07-18'),
      });
      expect(commitmentAlerts(s, { perDiemCommitment: commitment(0, 1), holidays })).toEqual([]);
    });
  });
});

describe('weekends off per year', () => {
  // 2026-01-04 is a Sunday: the period holds Sat 10, Sat 17 and Sat 24 (and Sat 31).
  const month = (assignments: unknown[]) =>
    scenario({
      nurses: [makeNurse({ id: 'n1', firstName: 'Ana', lastName: 'Cruz' })],
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-31'),
      assignments: assignments as never,
    });
  const history = (periodStart: string, weekendsWorked: number, id = periodStart) => ({
    id,
    nurseId: 'n1',
    periodId: `p-${id}`,
    periodStart: isoDate(periodStart),
    nightShifts: 0,
    weekendsWorked,
    holidaysWorked: 0,
    onCallShifts: 0,
    undesirableShifts: 0,
    requestsApproved: 0,
    requestsDenied: 0,
    callOutsCovered: 0,
    totalHours: 0,
    overtimeHours: 0,
    preferenceHitRate: 1,
  });
  const yearAlerts = (
    s: ReturnType<typeof scenario>,
    ledger: ReturnType<typeof history>[],
    minimum = 26,
  ) =>
    alertsFor(s, { weekendsOffPerYear: { minimum, ledger } }).filter(
      (a) => a.kind === 'weekends_off_per_year',
    );
  // 24 worked over the year before, in two periods inside the 364-day window.
  const lastYear = [history('2025-10-05', 14), history('2025-07-06', 10)];

  it('leaves a nurse alone when 24 weekends before and 2 now still leave the 26 promised', () => {
    resetFixtureCounters();
    const s = month([assign('n1', DAY_12, '2026-01-10'), assign('n1', DAY_12, '2026-01-17')]);
    expect(yearAlerts(s, lastYear)).toEqual([]);
  });

  it('warns when a third weekend this period makes the 27th worked, leaving 25 off', () => {
    resetFixtureCounters();
    const s = month([
      assign('n1', DAY_12, '2026-01-10', { id: 'sat10' }),
      assign('n1', DAY_12, '2026-01-17', { id: 'sat17' }),
      assign('n1', DAY_12, '2026-01-24', { id: 'sat24' }),
    ]);
    const alerts = yearAlerts(s, lastYear);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: 'warning', nurseId: 'n1' });
    expect([...alerts[0]!.assignmentIds].sort()).toEqual(['sat10', 'sat17', 'sat24']);
    expect(alerts[0]!.hours).toBeUndefined();
    expect(alerts[0]!.message).toBe(
      'Ana Cruz would have worked 27 weekends in the year to Sat Jan 31, 2026, leaving 25 weekends off against the 26 the unit promises',
    );
  });

  it('ignores a period that began a year or more before this one', () => {
    resetFixtureCounters();
    const s = month([
      assign('n1', DAY_12, '2026-01-10'),
      assign('n1', DAY_12, '2026-01-17'),
      assign('n1', DAY_12, '2026-01-24'),
    ]);
    // 2025-01-04 is 365 days before the period; 2025-01-05 is 364 and still counts.
    expect(yearAlerts(s, [history('2025-10-05', 14), history('2025-01-04', 10)])).toEqual([]);
    expect(yearAlerts(s, [history('2025-10-05', 14), history('2025-01-05', 10)])).toHaveLength(1);
  });

  it('still warns a nurse with no weekends this period when history alone breaks the promise', () => {
    resetFixtureCounters();
    const s = month([assign('n1', DAY_12, '2026-01-07')]);
    expect(yearAlerts(s, [history('2025-10-05', 27)])).toHaveLength(1);
  });

  it('checks nothing when the unit makes no promise', () => {
    resetFixtureCounters();
    const s = month([assign('n1', DAY_12, '2026-01-10')]);
    expect(alertsFor(s).filter((a) => a.kind === 'weekends_off_per_year')).toEqual([]);
  });
});
