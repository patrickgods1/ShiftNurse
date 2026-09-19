import type { Assignment, ShiftType } from '@shiftnurse/core';
import { isoDate } from '@shiftnurse/core';
import { describe, expect, it } from 'vitest';
import { assignmentOptionLabel, buildExchangeProposal } from './exchange-proposal.js';

function shiftType(patch: Partial<ShiftType> = {}): ShiftType {
  return {
    id: 'st_night' as ShiftType['id'],
    unitId: 'unit_1' as ShiftType['unitId'],
    name: 'Night 12',
    abbreviation: 'N12',
    startTime: '19:00',
    durationHours: 12,
    isNight: true,
    isOnCall: false,
    color: '#000000',
    sortOrder: 1,
    active: true,
    ...patch,
  };
}

function assignment(patch: Partial<Assignment> = {}): Assignment {
  return {
    id: 'asg_1' as Assignment['id'],
    periodId: 'per_1' as Assignment['periodId'],
    nurseId: 'nur_1' as Assignment['nurseId'],
    shiftTypeId: 'st_night' as Assignment['shiftTypeId'],
    date: isoDate('2026-01-16'),
    source: 'manual',
    isLocked: false,
    isCharge: false,
    isOvertime: false,
    ...patch,
  };
}

describe('buildExchangeProposal', () => {
  it('builds a giveaway once the requesting nurse, counterparty and offered shift are all picked', () => {
    const proposal = buildExchangeProposal({
      kind: 'giveaway',
      requestingNurseId: 'nur_a',
      counterpartyNurseId: 'nur_b',
      offeredAssignmentId: 'asg_1',
      requestedAssignmentId: '',
    });
    expect(proposal).toEqual({
      kind: 'giveaway',
      requestingNurseId: 'nur_a',
      counterpartyNurseId: 'nur_b',
      offeredAssignmentId: 'asg_1',
    });
  });

  it('withholds a giveaway proposal until every field is picked', () => {
    expect(
      buildExchangeProposal({
        kind: 'giveaway',
        requestingNurseId: 'nur_a',
        counterpartyNurseId: '',
        offeredAssignmentId: 'asg_1',
        requestedAssignmentId: '',
      }),
    ).toBeUndefined();
  });

  it('withholds a trade proposal until the counterparty has picked their own shift back', () => {
    expect(
      buildExchangeProposal({
        kind: 'trade',
        requestingNurseId: 'nur_a',
        counterpartyNurseId: 'nur_b',
        offeredAssignmentId: 'asg_1',
        requestedAssignmentId: '',
      }),
    ).toBeUndefined();
  });

  it('builds a trade once both assignments are picked', () => {
    const proposal = buildExchangeProposal({
      kind: 'trade',
      requestingNurseId: 'nur_a',
      counterpartyNurseId: 'nur_b',
      offeredAssignmentId: 'asg_1',
      requestedAssignmentId: 'asg_2',
    });
    expect(proposal).toEqual({
      kind: 'trade',
      requestingNurseId: 'nur_a',
      counterpartyNurseId: 'nur_b',
      offeredAssignmentId: 'asg_1',
      requestedAssignmentId: 'asg_2',
    });
  });

  it('refuses a nurse trading with themselves', () => {
    expect(
      buildExchangeProposal({
        kind: 'giveaway',
        requestingNurseId: 'nur_a',
        counterpartyNurseId: 'nur_a',
        offeredAssignmentId: 'asg_1',
        requestedAssignmentId: '',
      }),
    ).toBeUndefined();
  });
});

describe('assignmentOptionLabel', () => {
  it('names the weekday, date, shift abbreviation and charge status', () => {
    const shiftTypesById = new Map([['st_night' as ShiftType['id'], shiftType()]]);
    const label = assignmentOptionLabel(assignment({ isCharge: true }), shiftTypesById);
    // 2026-01-16 is a Friday — a fact checked against a calendar, not re-derived from the code.
    expect(label).toBe('Fri, Jan 16 · N12 (charge)');
  });

  it('falls back to the raw shift type id when the shift type is not loaded', () => {
    const label = assignmentOptionLabel(assignment(), new Map());
    expect(label).toBe('Fri, Jan 16 · st_night');
  });
});
