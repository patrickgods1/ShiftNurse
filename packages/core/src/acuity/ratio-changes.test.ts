import { describe, expect, it } from 'vitest';

import type { RatioRule } from '../domain/entities.js';
import { describeRatioChanges, protectedRatioChanges, ratioRuleSubject } from './ratio-changes.js';

const BASE: RatioRule = {
  id: 'r1',
  unitId: 'u1',
  role: 'RN',
  acuityTierId: 'high',
  maxPatientsPerNurse: 4,
  citation: 'CA Title 22 §70217',
  active: true,
};

const LICENSED: RatioRule = { ...BASE, role: 'licensed', minRnShare: 0.5 };

function without(rule: RatioRule, key: 'citation' | 'minRnShare'): RatioRule {
  const { [key]: _dropped, ...rest } = rule;
  return rest;
}

describe('which ratio edits need a reason', () => {
  it('needs a reason to raise a 1:4 ceiling to 1:6', () => {
    expect(protectedRatioChanges(BASE, { ...BASE, maxPatientsPerNurse: 6 })).toEqual(['raised']);
  });

  it('needs none to lower a 1:4 ceiling to 1:3', () => {
    expect(protectedRatioChanges(BASE, { ...BASE, maxPatientsPerNurse: 3 })).toEqual([]);
  });

  it('needs a reason to cut a licensed rule’s RN share from half to a third', () => {
    expect(protectedRatioChanges(LICENSED, { ...LICENSED, minRnShare: 0.333 })).toEqual([
      'rn-share-lowered',
    ]);
    expect(protectedRatioChanges(LICENSED, without(LICENSED, 'minRnShare'))).toEqual([
      'rn-share-lowered',
    ]);
  });

  it('needs none to raise the RN share', () => {
    expect(protectedRatioChanges(LICENSED, { ...LICENSED, minRnShare: 0.6 })).toEqual([]);
    const noShare = without(LICENSED, 'minRnShare');
    expect(protectedRatioChanges(noShare, { ...noShare, minRnShare: 0.5 })).toEqual([]);
  });

  it('needs a reason to move the ceiling to another role or tier', () => {
    expect(protectedRatioChanges(BASE, { ...BASE, role: 'licensed' })).toEqual(['role']);
    expect(protectedRatioChanges(BASE, { ...BASE, acuityTierId: null })).toEqual(['tier']);
  });

  it('needs a reason to rewrite or remove the citation, not to add one', () => {
    expect(protectedRatioChanges(BASE, { ...BASE, citation: 'Local 1199 Art. 12' })).toEqual([
      're-cited',
    ]);
    expect(protectedRatioChanges(BASE, without(BASE, 'citation'))).toEqual(['re-cited']);
    expect(protectedRatioChanges(without(BASE, 'citation'), BASE)).toEqual([]);
  });

  it('needs a reason to deactivate a ceiling, not to reactivate one', () => {
    const inactive = { ...BASE, active: false };
    expect(protectedRatioChanges(BASE, inactive)).toEqual(['deactivated']);
    expect(protectedRatioChanges(inactive, BASE)).toEqual([]);
  });

  it('lists several changes in a fixed order', () => {
    const after = { ...without(BASE, 'citation'), maxPatientsPerNurse: 6, active: false };
    expect(protectedRatioChanges(BASE, after)).toEqual(['raised', 're-cited', 'deactivated']);
  });

  it('describes a raised, uncited ceiling in a manager’s words', () => {
    const after = { ...without(BASE, 'citation'), maxPatientsPerNurse: 6 };
    expect(describeRatioChanges(BASE, after, ['raised', 're-cited'], { high: 'High' })).toBe(
      'Changing the RN ratio on High (ceiling 1:4 → 1:6, citation removed)',
    );
  });

  it('describes a licensed rule moved to every tier with its RN share cut', () => {
    const after = { ...LICENSED, acuityTierId: null, minRnShare: 0.333, citation: 'MOU 2026-3' };
    expect(
      describeRatioChanges(LICENSED, after, ['rn-share-lowered', 'tier', 're-cited'], {
        high: 'High',
      }),
    ).toBe(
      'Changing the licensed-nurse ratio on High (RN share 50% → 33%, tier High → every tier, citation changed)',
    );
  });

  it('describes a rule for every tier switched to LPNs and retired', () => {
    const before = { ...BASE, acuityTierId: null };
    const after = { ...before, role: 'LPN' as const, active: false };
    expect(describeRatioChanges(before, after, ['role', 'deactivated'], {})).toBe(
      'Changing the RN ratio on every tier (role RN → LPN, deactivated)',
    );
  });

  it('says none when an RN share is cleared', () => {
    expect(
      describeRatioChanges(LICENSED, without(LICENSED, 'minRnShare'), ['rn-share-lowered'], {
        high: 'High',
      }),
    ).toBe('Changing the licensed-nurse ratio on High (RN share 50% → none)');
  });

  describe('a ceiling that binds one tour', () => {
    const CNA: RatioRule = { ...BASE, role: 'CNA', acuityTierId: null, maxPatientsPerNurse: 11 };
    const NIGHT: RatioRule = { ...CNA, tour: 'night' };

    it('needs a reason to move a ceiling onto night shifts only, or off them, or onto days', () => {
      expect(protectedRatioChanges(CNA, NIGHT)).toEqual(['tour']);
      expect(protectedRatioChanges(NIGHT, CNA)).toEqual(['tour']);
      expect(protectedRatioChanges({ ...CNA, tour: 'day' }, NIGHT)).toEqual(['tour']);
    });

    it('lists a tour change after a tier change', () => {
      expect(protectedRatioChanges(BASE, { ...BASE, acuityTierId: null, tour: 'night' })).toEqual([
        'tier',
        'tour',
      ]);
    });

    it('says which shifts the ceiling moved between', () => {
      expect(describeRatioChanges(CNA, NIGHT, ['tour'], {})).toBe(
        'Changing the CNA ratio on every tier (tour every shift → night shifts)',
      );
      expect(describeRatioChanges(NIGHT, CNA, ['tour'], {})).toBe(
        'Changing the CNA ratio on every tier on night shifts (tour night shifts → every shift)',
      );
      expect(
        describeRatioChanges({ ...CNA, tour: 'day' }, { ...CNA, tour: 'evening' }, ['tour'], {}),
      ).toBe(
        'Changing the CNA ratio on every tier on day shifts (tour day shifts → evening shifts)',
      );
    });

    it('names the tour in the rule’s subject', () => {
      expect(ratioRuleSubject(NIGHT, {})).toBe('CNA ratio on every tier on night shifts');
      expect(ratioRuleSubject(CNA, {})).toBe('CNA ratio on every tier');
    });
  });
});
