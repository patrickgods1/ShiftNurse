// @vitest-environment jsdom

import { isoDate, type SchedulePeriod } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAdoptLatestRules } from '../../api-schedule.js';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { rulesVersionPill } from './rules-version.js';
import { StatusRow } from './status-row.js';

const period: SchedulePeriod = {
  id: 'period-1',
  unitId: 'unit-1',
  name: 'October',
  startDate: isoDate('2026-10-04'),
  endDate: isoDate('2026-11-14'),
  status: 'draft',
  ruleSetId: 'rs-1',
  ruleSetVersion: 1,
};

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

const pill = (p: SchedulePeriod, latest: number) =>
  rulesVersionPill({
    period: p,
    latest: { version: latest },
    onAdopt: () => {
      void window.shiftnurse.periods.adoptLatestRules(p.id);
    },
    pending: false,
    error: undefined,
  });

function Harness() {
  const adopt = useAdoptLatestRules('unit-1');
  const item = rulesVersionPill({
    period,
    latest: { version: 2 },
    onAdopt: () => adopt.mutate(period.id),
    pending: adopt.isPending,
    error: adopt.error,
  });
  return <StatusRow items={[item!]} />;
}

describe('the rules version pill', () => {
  it('shows why the move failed in the pill detail', async () => {
    bridge.fail('periods', 'adoptLatestRules', new Error('"October" is published; stays pinned.'));
    renderWithApp(<Harness />);
    fireEvent.click(await screen.findByTestId('rules-version'));
    fireEvent.click(screen.getByText('Use the latest rules'));
    expect((await screen.findByRole('alert')).textContent).toContain('stays pinned');
  });

  it('offers the latest rules on a draft made under older ones', async () => {
    bridge.respond('periods', 'adoptLatestRules', { ...period, ruleSetVersion: 2 });
    const item = pill(period, 2);
    expect(item).toBeDefined();
    renderWithApp(<StatusRow items={[item!]} />);
    const el = await screen.findByTestId('rules-version');
    expect(el.textContent).toContain('Rules v1 · latest v2');
    fireEvent.click(el);
    expect(screen.getByText(/This draft uses rules v1/)).toBeTruthy();
    fireEvent.click(screen.getByText('Use the latest rules'));
    await waitFor(() =>
      expect(bridge.callsTo('periods', 'adoptLatestRules')).toEqual([['period-1']]),
    );
  });

  it('shows nothing on a published schedule under older rules', () => {
    expect(pill({ ...period, status: 'published' }, 2)).toBeUndefined();
  });

  it('shows nothing on a draft already on the latest rules', () => {
    expect(pill(period, 1)).toBeUndefined();
  });
});
