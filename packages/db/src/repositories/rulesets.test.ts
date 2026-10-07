/**
 * Saving rules: a manager may switch off or soften the patient-ratio rule or a rule their state
 * preset switched on, but only with a stated reason — that text is what gets quoted if the
 * decision is challenged. A refusal must come before any insert, or the caller's transaction
 * would hold a rule-set header with no rules.
 */

import {
  DEFAULT_FAIRNESS_WEIGHTS,
  DEFAULT_WEEKEND,
  isoDate,
  type JurisdictionChoices,
  type JurisdictionId,
  type RuleConfig,
} from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { createUnit } from './config.js';
import { getLatestRuleSet, saveRuleSet } from './rulesets.js';
import { applyJurisdiction } from './setup.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;

function mkUnit(jurisdiction?: JurisdictionId, choices?: JurisdictionChoices): string {
  const unitId = createUnit(
    handle.db,
    {
      name: '4 West',
      unitType: 'Medical-Surgical',
      payPeriodDays: 14,
      payPeriodAnchor: isoDate('2026-01-04'),
    },
    ACTOR,
  ).id;
  if (jurisdiction)
    transact(handle.db, (tx) => applyJurisdiction(tx, unitId, jurisdiction, ACTOR, choices));
  return unitId;
}

/** The unit's rules in force, with one rule's config replaced. */
function save(unitId: string, change: RuleConfig, reason?: string) {
  const configs = (getLatestRuleSet(handle.db, unitId)?.configs ?? []).filter(
    (c) => c.ruleId !== change.ruleId,
  );
  return transact(handle.db, (tx) =>
    saveRuleSet(
      tx,
      {
        unitId,
        name: 'Contract rules',
        configs: [...configs, change],
        weekendDefinition: DEFAULT_WEEKEND,
        fairnessWeights: DEFAULT_FAIRNESS_WEIGHTS,
      },
      ACTOR,
      reason === undefined ? undefined : { reason },
    ),
  );
}

beforeEach(() => {
  handle = openTestDatabase();
});

afterEach(() => {
  handle.close();
});

describe('loosening a protected rule', () => {
  it('refuses to switch off the VA overtime protection without a reason, and saves nothing', () => {
    const unitId = mkUnit('US-VA');
    const before = getLatestRuleSet(handle.db, unitId)!.version;
    expect(() =>
      save(unitId, { ruleId: 'no-mandatory-overtime', enabled: false, params: {} }),
    ).toThrow(
      /Switching off or softening No mandatory overtime.*needs a reason.*Federal — VA \(Title 38\) preset/i,
    );
    expect(getLatestRuleSet(handle.db, unitId)!.version).toBe(before);
  });

  it('records the reason when the manager switches the VA overtime protection off', () => {
    const unitId = mkUnit('US-VA');
    const saved = save(
      unitId,
      { ruleId: 'no-mandatory-overtime', enabled: false, params: {} },
      'Emergency staffing order, 2026-10-06',
    );
    const [entry] = auditHistoryFor(handle.db, 'rule_set', saved.id);
    expect(entry!.reason).toBe('Emergency staffing order, 2026-10-06');
  });

  it('needs a reason to make the patient-ratio rule advisory, with no state preset', () => {
    const unitId = mkUnit();
    expect(() =>
      save(unitId, {
        ruleId: 'patient-ratio-compliance',
        enabled: true,
        severityOverride: 'soft',
        params: {},
      }),
    ).toThrow(/needs a reason: it is the patient-ratio rule/);
    expect(getLatestRuleSet(handle.db, unitId)).toBeUndefined();
  });

  it('lets the manager switch off an advisory rule without a reason', () => {
    const unitId = mkUnit('US-VA');
    const saved = save(unitId, { ruleId: 'recovery-after-nights', enabled: false, params: {} });
    const [entry] = auditHistoryFor(handle.db, 'rule_set', saved.id);
    expect(entry!.reason).toBeUndefined();
  });

  it('applies the VA preset without asking for a reason: it only switches rules on', () => {
    const unitId = mkUnit();
    transact(handle.db, (tx) => applyJurisdiction(tx, unitId, 'US-VA', ACTOR));
    const saved = getLatestRuleSet(handle.db, unitId)!;
    expect(saved.version).toBe(1);
    const [entry] = auditHistoryFor(handle.db, 'rule_set', saved.id);
    expect(entry!.reason).toBeUndefined();
  });

  it('needs a reason to make the VA–NNU 11-hour rest advisory on a unit under that agreement', () => {
    const unitId = mkUnit('US-VA');
    expect(() =>
      save(unitId, {
        ruleId: 'min-rest-between-shifts',
        enabled: true,
        severityOverride: 'soft',
        params: { minRestHours: 11 },
      }),
    ).toThrow(/Switching off or softening Minimum rest between shifts needs a reason/);
  });

  it('lets a VA unit under its own agreement make the 11-hour rest advisory without a reason', () => {
    const unitId = mkUnit('US-VA', { ownContract: true });
    const saved = save(unitId, {
      ruleId: 'min-rest-between-shifts',
      enabled: true,
      severityOverride: 'soft',
      params: { minRestHours: 11 },
    });
    const [entry] = auditHistoryFor(handle.db, 'rule_set', saved.id);
    expect(entry!.reason).toBeUndefined();
  });

  it('still needs a reason to drop the Title 38 overtime ban under any agreement', () => {
    const unitId = mkUnit('US-VA', { ownContract: true });
    expect(() =>
      save(unitId, { ruleId: 'no-mandatory-overtime', enabled: false, params: {} }),
    ).toThrow(/No mandatory overtime.*needs a reason/);
  });

  it('refuses to save rules for a unit that does not exist', () => {
    expect(() =>
      save('unit_missing', { ruleId: 'recovery-after-nights', enabled: false, params: {} }),
    ).toThrow('Unit unit_missing not found');
  });
});
