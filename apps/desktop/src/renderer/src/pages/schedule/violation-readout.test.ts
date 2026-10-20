import type { EvaluationResult, Violation } from '@shiftnurse/core';
import { describe, expect, it } from 'vitest';
import { violationReadout } from './violation-readout.js';

function resultWith(hard: number, soft: number): EvaluationResult {
  const make = (severity: 'hard' | 'soft', i: number): Violation =>
    ({
      ruleId: `r${i}`,
      code: 'x',
      severity,
      message: 'm',
      nurseIds: [],
      assignmentIds: [],
      dates: [],
    }) as unknown as Violation;
  const hardViolations = Array.from({ length: hard }, (_, i) => make('hard', i));
  const softViolations = Array.from({ length: soft }, (_, i) => make('soft', i));
  return {
    violations: [...hardViolations, ...softViolations],
    hardViolations,
    softViolations,
  } as unknown as EvaluationResult;
}

describe('violationReadout', () => {
  it('never says the schedule is clean while the check is still running', () => {
    const readout = violationReadout('pending', undefined);
    expect(readout.tone).not.toBe('text-success');
    expect(readout.label).toBe('Checking rules…');
  });

  it('says the check failed rather than reporting zero violations', () => {
    const readout = violationReadout('error', undefined);
    expect(readout.tone).toBe('text-danger');
    expect(readout.label).toBe('Could not check rules');
  });

  it('shows green only when a finished check found nothing', () => {
    expect(violationReadout('success', resultWith(0, 0))).toEqual({
      label: '0 hard violations · 0 soft',
      tone: 'text-success',
    });
  });

  it('leads with red when any hard violation is present', () => {
    expect(violationReadout('success', resultWith(1, 0))).toEqual({
      label: '1 hard violation · 0 soft',
      tone: 'text-danger',
    });
  });

  it('says "2 hard violations · 1 soft" for two breaks and a warning', () => {
    expect(violationReadout('success', resultWith(2, 1)).label).toBe('2 hard violations · 1 soft');
  });

  it('warns amber for soft-only schedules', () => {
    expect(violationReadout('success', resultWith(0, 2)).tone).toBe('text-warn');
  });
});
