/**
 * The headline text and colour for the violation summary. A separate module so it can be
 * tested without a DOM: the first version defaulted missing counts to 0 and so painted a green
 * "0 hard · 0 soft" while validation was still loading or had failed — the one wrong answer a
 * staffing screen must never give.
 */

import type { EvaluationResult } from '@shiftnurse/core';

export type ValidationStatus = 'pending' | 'error' | 'success';

export interface ViolationReadout {
  label: string;
  tone: 'text-success' | 'text-warn' | 'text-danger' | 'text-text-muted';
}

export function violationReadout(
  status: ValidationStatus,
  result: EvaluationResult | undefined,
): ViolationReadout {
  if (status === 'error') return { label: 'Could not check rules', tone: 'text-danger' };
  if (!result) return { label: 'Checking rules…', tone: 'text-text-muted' };
  const hard = result.hardViolations.length;
  const soft = result.softViolations.length;
  return {
    label: `${hard} hard · ${soft} soft violation${hard + soft === 1 ? '' : 's'}`,
    tone: hard > 0 ? 'text-danger' : soft > 0 ? 'text-warn' : 'text-success',
  };
}
