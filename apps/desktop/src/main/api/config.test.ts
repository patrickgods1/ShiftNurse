/**
 * The unit's configuration through the IPC handlers. Each write must land with its audit row in
 * one transaction, and a refusal must reach the manager in words with nothing half-saved — a
 * rule set above all, since a header with no rule configs would read as "latest" and judge a
 * schedule by nothing.
 */

import { isoDate } from '@shiftnurse/core';
import { auditHistoryFor, recentAudit } from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configApi } from './config.js';
import { type Fixture, openFixture } from './test-fixture.js';

let f: Fixture;

beforeEach(() => {
  f = openFixture();
});

afterEach(() => {
  f.handle.close();
});

const api = () => configApi(f.handle.db);
const auditsOf = (type: string, id: string) => auditHistoryFor(f.handle.db, type, id);
const unitId = () => f.seeded.unitId;

describe('the unit and its shift types', () => {
  it('renames the unit and keeps the old name in the audit row', () => {
    const before = api().units.list()[0]!;
    api().units.update(before.id, { name: '4 West' });
    expect(api().units.list()[0]!.name).toBe('4 West');
    const [entry] = auditsOf('unit', before.id);
    expect(entry!.before).toMatchObject({ name: before.name });
    expect(entry!.after).toMatchObject({ name: '4 West' });
  });

  it('refuses a unit with a blank name in words and leaves the name alone', () => {
    const before = api().units.list()[0]!;
    expect(() => api().units.update(before.id, { name: '  ' })).toThrow(/needs a name/i);
    expect(api().units.list()[0]!.name).toBe(before.name);
  });

  it('adds a mid shift, retires it, and audits both', () => {
    const mid = api().shiftTypes.create({
      unitId: unitId(),
      name: 'Mid 10',
      abbreviation: 'M10',
      startTime: '10:00',
      durationHours: 10,
      isNight: false,
      isOnCall: false,
      color: '#aabbcc',
      sortOrder: 9,
      active: true,
    });
    expect(
      api()
        .shiftTypes.list(unitId())
        .map((s) => s.id),
    ).toContain(mid.id);
    api().shiftTypes.update(mid.id, { name: 'Mid ten' });
    expect(api().shiftTypes.deactivate(mid.id).active).toBe(false);
    expect(auditsOf('shift_type', mid.id).map((a) => a.action)).toEqual([
      'delete',
      'update',
      'create',
    ]);
  });

  it('says so when retiring a shift type that is not there', () => {
    expect(() => api().shiftTypes.deactivate('missing')).toThrow(/not found/i);
  });
});

describe('coverage floors', () => {
  it('sets a one-day override, then removes it', () => {
    const date = isoDate('2026-10-01');
    const floor = api().coverage.upsert({
      unitId: unitId(),
      shiftTypeId: f.day.id,
      weekday: null,
      date,
      role: 'RN',
      minCount: 4,
      targetCount: 5,
    });
    expect(
      api()
        .coverage.list(unitId())
        .find((c) => c.id === floor.id)?.minCount,
    ).toBe(4);
    api().coverage.delete(floor.id);
    expect(
      api()
        .coverage.list(unitId())
        .some((c) => c.id === floor.id),
    ).toBe(false);
    expect(auditsOf('coverage_requirement', floor.id).map((a) => a.action)).toEqual([
      'delete',
      'create',
    ]);
  });

  it('says so when deleting a floor that does not exist', () => {
    expect(() => api().coverage.delete('gone')).toThrow(/not found/i);
  });
});

describe('holidays', () => {
  const christmas = () => ({
    unitId: unitId(),
    date: isoDate('2026-07-14'),
    name: 'Unit Day',
    isMajor: true,
  });

  it('adds a holiday, records who worked it by hand, then goes back to the schedules', () => {
    const h = api().holidays.create(christmas());
    expect(
      api()
        .holidays.list(unitId())
        .map((x) => x.id),
    ).toContain(h.id);

    const ann = f.rns[0]!;
    const recorded = api().holidays.recordWork(h.id, [ann.id, ann.id]);
    expect(recorded.recorded).toBe(true);
    expect(recorded.nurseIds).toEqual([ann.id]);
    expect(api().holidays.work(h.id).nurseIds).toEqual([ann.id]);

    expect(api().holidays.clearWork(h.id).recorded).toBe(false);
    expect(auditsOf('holiday_work', h.id).map((a) => a.action)).toEqual(['update', 'update']);
  });

  it('renames a holiday and deletes it with the audit trail intact', () => {
    const h = api().holidays.create(christmas());
    expect(api().holidays.update(h.id, { name: 'Unit Day Observed' }).name).toBe(
      'Unit Day Observed',
    );
    api().holidays.delete(h.id);
    expect(
      api()
        .holidays.list(unitId())
        .some((x) => x.id === h.id),
    ).toBe(false);
    expect(auditsOf('holiday', h.id).map((a) => a.action)).toEqual(['delete', 'update', 'create']);
  });

  it('refuses a holiday with a blank name', () => {
    const h = api().holidays.create(christmas());
    expect(() => api().holidays.update(h.id, { name: '' })).toThrow(/needs a name/i);
    expect(
      api()
        .holidays.list(unitId())
        .find((x) => x.id === h.id)?.name,
    ).toBe('Unit Day');
  });

  it('adds next year’s holidays from the plan the manager approved, in one step', () => {
    const plan = api().holidays.planYear(unitId(), 2031);
    expect(plan.holidays.length).toBeGreaterThan(0);
    const before = api().holidays.list(unitId()).length;
    const added = api().holidays.addYear(unitId(), {
      holidays: plan.holidays,
      repairs: plan.repairs,
    });
    expect(added).toHaveLength(plan.holidays.length);
    expect(api().holidays.list(unitId())).toHaveLength(before + plan.holidays.length);
    expect(added.every((h) => h.date.startsWith('2031-'))).toBe(true);
  });
});

describe('acuity tiers, ratios and the HPPD target', () => {
  it('creates, changes and deletes a tier, auditing each', () => {
    const tier = api().acuity.createTier({
      unitId: unitId(),
      name: 'Tier 9',
      level: 9,
      careHoursPerPatientDay: 9,
    });
    expect(
      api()
        .acuity.tiers(unitId())
        .map((t) => t.id),
    ).toContain(tier.id);
    expect(
      api().acuity.updateTier(tier.id, { careHoursPerPatientDay: 10 }).careHoursPerPatientDay,
    ).toBe(10);
    api().acuity.deleteTier(tier.id);
    expect(
      api()
        .acuity.tiers(unitId())
        .some((t) => t.id === tier.id),
    ).toBe(false);
    expect(auditsOf('acuity_tier', tier.id).map((a) => a.action)).toEqual([
      'delete',
      'update',
      'create',
    ]);
  });

  it('says so when deleting a tier that does not exist', () => {
    expect(() => api().acuity.deleteTier('none')).toThrow(/not found/i);
  });

  it('adds a ratio, tightens it, and deactivates it rather than deleting it', () => {
    const rule = api().acuity.createRatioRule({
      unitId: unitId(),
      role: 'RN',
      acuityTierId: null,
      maxPatientsPerNurse: 6,
      active: true,
    });
    expect(
      api().acuity.updateRatioRule(rule.id, { maxPatientsPerNurse: 5 }).maxPatientsPerNurse,
    ).toBe(5);
    expect(api().acuity.deactivateRatioRule(rule.id).active).toBe(false);
    expect(
      api()
        .acuity.ratioRules(unitId())
        .find((r) => r.id === rule.id)?.active,
    ).toBe(false);
    expect(auditsOf('ratio_rule', rule.id)).toHaveLength(3);
  });

  it('sets the HPPD target and then changes it', () => {
    api().acuity.setHppd(unitId(), 7.5);
    expect(api().acuity.hppd(unitId())?.targetHours).toBe(7.5);
    api().acuity.setHppd(unitId(), 8);
    expect(api().acuity.hppd(unitId())?.targetHours).toBe(8);
    const id = api().acuity.hppd(unitId())!.id;
    // The seeded target's own create is at the bottom; the two edits above sit on top of it.
    expect(
      auditsOf('hppd_target', id)
        .map((a) => a.action)
        .slice(0, 2),
    ).toEqual(['update', 'update']);
  });
});

describe('the rule set', () => {
  it('saves a new version with its configs and leaves the old version alone', () => {
    const latest = api().rules.getLatest(unitId());
    const saved = api().rules.save(
      unitId(),
      'Spring contract',
      latest.configs,
      latest.weekendDefinition,
      latest.fairnessWeights,
    );
    expect(saved.id).not.toBe(latest.id);
    expect(saved.version).toBeGreaterThan(latest.version);
    expect(saved.name).toBe('Spring contract');
    expect(saved.configs).toHaveLength(latest.configs.length);
    expect(api().rules.getLatest(unitId()).id).toBe(saved.id);
    expect(auditsOf('rule_set', saved.id)[0]!.action).toBe('create');
  });

  it('saves nothing when a config fails after the header is written', () => {
    const latest = api().rules.getLatest(unitId());
    const first = latest.configs[0]!;
    const audits = recentAudit(f.handle.db, 1000).length;
    // The same rule twice breaks the (rule set, rule) key midway through the save.
    expect(() =>
      api().rules.save(
        unitId(),
        'Doubled',
        [first, first],
        latest.weekendDefinition,
        latest.fairnessWeights,
      ),
    ).toThrow();
    expect(api().rules.getLatest(unitId()).id).toBe(latest.id);
    expect(recentAudit(f.handle.db, 1000)).toHaveLength(audits);
  });
});

describe('solver settings', () => {
  it('saves the chosen solver without leaking the row id, and audits it', () => {
    const saved = api().solverSettings.save(unitId(), { solverId: 'sa-lns', maxIterations: 5000 });
    expect(saved).toEqual({ solverId: 'sa-lns', maxIterations: 5000 });
    expect(api().solverSettings.get(unitId())).toMatchObject({ solverId: 'sa-lns' });
    expect(recentAudit(f.handle.db, 1)[0]).toMatchObject({ entityType: 'solver_settings' });
  });

  it('refuses a solver that does not exist and an iteration budget of zero', () => {
    expect(() => api().solverSettings.save(unitId(), { solverId: 'quantum' as never })).toThrow(
      /unknown solver/i,
    );
    expect(() =>
      api().solverSettings.save(unitId(), { solverId: 'hybrid', maxIterations: 0 }),
    ).toThrow(/positive whole number/i);
  });
});
