// @vitest-environment jsdom

import type { PeriodCostReport } from '@shared/api.js';
import type { EvaluationResult, Violation } from '@shiftnurse/core';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { costPill } from './cost-summary.js';
import { StatusRow } from './status-row.js';
import { violationPill } from './violation-summary.js';

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respondDefault([]);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('the cost pill', () => {
  it('says how many shifts are unpriced in the headline, not only in the detail', () => {
    // Only the fields the pill reads; the rest of a cost report is irrelevant here.
    const report = {
      cost: {
        totals: { total: 431911, hours: 5000 },
        overtime: { totalHours: 0, totalPremium: 0, nursesWithOvertime: 0 },
        unpricedAssignments: 3,
      },
      variance: undefined,
    } as unknown as PeriodCostReport;
    const pill = costPill({ report, previewLabel: undefined });
    expect(pill?.label).toContain('$431,911');
    expect(pill?.label).toContain('3 unpriced');
    expect(pill?.tone).toBe('danger');
  });
});

describe('the violation pill', () => {
  const soft: Violation = {
    ruleId: 'recovery-after-nights',
    ruleName: 'Days off after nights',
    severity: 'soft',
    code: 'recovery_after_nights',
    message: 'Ana works a day shift the morning after a night.',
    nurseIds: [],
    dates: [],
    assignmentIds: [],
  } as unknown as Violation;
  const result: EvaluationResult = {
    violations: [soft],
    hardViolations: [],
    softViolations: [soft],
    feasible: true,
  };

  it('keeps the option tag inside the pill and still links to the rule when opened', async () => {
    renderWithApp(
      <StatusRow
        items={[violationPill({ status: 'success', result, previewLabel: 'Option 2' })]}
      />,
    );
    const pill = await screen.findByTestId('violation-summary');
    expect(pill.querySelector('[data-testid="preview-scope"]')?.textContent).toBe('Option 2');
    fireEvent.click(pill);
    expect(screen.getByText(/morning after a night/)).toBeTruthy();
    expect(screen.getByText('Change this rule')).toBeTruthy();
  });
});
