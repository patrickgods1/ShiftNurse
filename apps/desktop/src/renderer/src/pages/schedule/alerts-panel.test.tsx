// @vitest-environment jsdom
/** Compliance alerts: what needs action is open, routine ratio slack is folded away. */

import { type ComplianceAlert, isoDate } from '@shiftnurse/core';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { useAlertsPill } from './alerts-panel.js';
import { StatusRow } from './status-row.js';

function Harness({ alerts }: { alerts: readonly ComplianceAlert[] }) {
  const pill = useAlertsPill({ periodId: 'p1', preview: { alerts, label: 'Variation 1' } });
  return <StatusRow items={pill ? [pill] : []} />;
}

const credential: ComplianceAlert = {
  kind: 'credential_expiry',
  severity: 'critical',
  message: 'Ana Reyes BLS expires Oct 12',
  nurseId: 'n1',
  date: isoDate('2026-10-12'),
  assignmentIds: ['a1'],
};
const ratio = (day: string): ComplianceAlert => ({
  kind: 'ratio_risk',
  severity: 'warning',
  message: `Day shift on ${day} is staffed exactly at the ratio`,
  date: isoDate(`2026-10-${day}`),
  assignmentIds: [],
});

let bridge: ReturnType<typeof installFakeBridge>;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('compliance alerts', () => {
  it('opens credential alerts and folds the routine ratio slack', async () => {
    renderWithApp(<Harness alerts={[credential, ratio('05'), ratio('06'), ratio('07')]} />);

    const pill = await screen.findByTestId('alerts-panel');
    expect(pill.textContent).toContain('1 to act on before publishing');
    fireEvent.click(pill);

    expect(screen.getByText('1 credentials expiring · 3 no slack on the ratio')).toBeTruthy();
    expect(screen.getByText('Credentials expiring (1)')).toBeTruthy();
    expect(screen.getByText('No slack on the ratio (3)')).toBeTruthy();
    // Credentials are listed; the three ratio lines wait behind the toggle.
    expect(screen.getByText('Ana Reyes BLS expires Oct 12')).toBeTruthy();
    expect(screen.queryByText(/is staffed exactly at the ratio/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show each shift' }));

    expect(screen.getAllByText(/is staffed exactly at the ratio/)).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Fold' })).toBeTruthy();
  });

  it('shows a lone in-lieu holiday as a quiet note, not a warning', async () => {
    renderWithApp(
      <Harness
        alerts={[
          {
            kind: 'in_lieu_holiday',
            severity: 'information',
            message: 'Ada Lovelace’s in-lieu day for Epiphany is Thu Jan 8',
            nurseId: 'n1',
            date: isoDate('2026-01-08'),
            assignmentIds: ['a1'],
          },
        ]}
      />,
    );

    const pill = await screen.findByTestId('alerts-panel');
    expect(pill.textContent).toContain('1 alert');
    expect(pill.className).toContain('text-text-muted');
    expect(pill.className).not.toContain('text-warn');
    fireEvent.click(pill);
    expect(screen.getByText('In-lieu holidays (1)')).toBeTruthy();
  });
});
