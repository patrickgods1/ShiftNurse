// @vitest-environment jsdom
/** The exchange verdict in words, and warnings that repeat must not collide as list keys. */

import type { ExchangeEvaluation } from '@shiftnurse/core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EvaluationPanel, VerdictPill } from './exchange-evaluation.js';
import { coverageDeltaLabel } from './labels.js';

afterEach(cleanup);

const side = {
  nurseId: 'n-1',
  hoursBefore: 36,
  hoursAfter: 36,
  fairnessBefore: 80,
  fairnessAfter: 80,
  dollarsBefore: 0,
  dollarsAfter: 0,
  hardViolations: [],
};

describe('how a resolution changes the shortfall', () => {
  it('says how much shorter or longer a resolution leaves the unit', () => {
    expect(coverageDeltaLabel(-1)).toBe('1 fewer slot short');
    expect(coverageDeltaLabel(-2)).toBe('2 fewer slots short');
    expect(coverageDeltaLabel(1)).toBe('1 more slot short');
    expect(coverageDeltaLabel(0)).toBe('no change');
  });
});

describe('the exchange evaluation', () => {
  it('names the verdict in words', () => {
    render(<VerdictPill verdict="blocked" />);
    expect(screen.getByText('Not allowed')).toBeTruthy();
  });

  it('shows the same warning for both nurses twice', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const evaluation = {
      verdict: 'warn',
      blockers: [],
      warnings: ['Rest under 10 hours', 'Rest under 10 hours'],
      requesting: side,
      counterparty: { ...side, nurseId: 'n-2' },
      fairness: { unitScoreBefore: 80, unitScoreAfter: 80 },
      cost: { dollarsBefore: 0, dollarsAfter: 0, delta: 0 },
    } as unknown as ExchangeEvaluation;
    render(<EvaluationPanel evaluation={evaluation} nursesById={new Map()} />);
    expect(screen.getAllByText('Rest under 10 hours')).toHaveLength(2);
    const duplicateKey = spy.mock.calls.some((c) => c.map(String).join(' ').includes('same key'));
    spy.mockRestore();
    expect(duplicateKey).toBe(false);
  });
});
