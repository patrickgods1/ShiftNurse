// @vitest-environment jsdom
/** The expanded fairness row names the dates behind the counts and links to the grid. */

import type { NurseFairnessScore } from '@shiftnurse/core';
import { isoDate } from '@shiftnurse/core';
import { makeNurse, resetFixtureCounters } from '@shiftnurse/core/testing';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { NurseFairnessTable } from './nurse-table.js';

function scoreFor(
  nurseId: string,
  weekends: string[],
  nights: string[] = [],
  holidays: string[] = [],
  score = 70,
): NurseFairnessScore {
  return {
    nurseId,
    score,
    components: [],
    seniorityMultiplier: 1,
    burdenIndex: 1.8,
    comparable: true,
    occurrences: {
      nights: nights.map(isoDate),
      weekends: weekends.map(isoDate),
      holidays: holidays.map(isoDate),
    },
  };
}

let bridge: ReturnType<typeof installFakeBridge>;
beforeEach(() => {
  resetFixtureCounters();
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('fairness breakdown', () => {
  it('lists the dates Ana worked, compares with the unit and links to her shifts', async () => {
    const ana = makeNurse({ firstName: 'Ana', lastName: 'Reyes', contractedHoursPerPeriod: 72 });
    const ben = makeNurse({ firstName: 'Ben', lastName: 'Cole', contractedHoursPerPeriod: 72 });
    const scores = [
      scoreFor(
        ana.id,
        ['2026-10-03', '2026-10-04', '2026-10-10', '2026-10-11'],
        ['2026-10-02', '2026-10-03'],
        ['2026-10-05'],
      ),
      scoreFor(ben.id, ['2026-10-17', '2026-10-18']),
    ];
    renderWithApp(<NurseFairnessTable scores={scores} nurses={[ana, ben]} trend={[]} />);

    fireEvent.click(await screen.findByRole('button', { name: /Ana/ }));

    expect(screen.getByText('Nights: Fri, Oct 2, Sat, Oct 3')).toBeTruthy();
    expect(
      screen.getByText('Weekends: Sat, Oct 3, Sun, Oct 4, Sat, Oct 10, Sun, Oct 11'),
    ).toBeTruthy();
    expect(screen.getByText('Holidays: Mon, Oct 5')).toBeTruthy();
    // Unit mean is (4 + 2) / 2 = 3; Ana has one more.
    expect(screen.getByText('1 more weekend day than the unit average of 3.')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Show on schedule' });
    expect(link.getAttribute('href')).toContain(`nurse=${ana.id}`);
  });

  async function expandAna(anaWeekends: string[], benWeekends: string[]) {
    const ana = makeNurse({ firstName: 'Ana', lastName: 'Reyes', contractedHoursPerPeriod: 72 });
    const ben = makeNurse({ firstName: 'Ben', lastName: 'Cole', contractedHoursPerPeriod: 72 });
    renderWithApp(
      <NurseFairnessTable
        scores={[scoreFor(ana.id, anaWeekends), scoreFor(ben.id, benWeekends)]}
        nurses={[ana, ben]}
        trend={[]}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Ana/ }));
  }

  it('leaves out the Holidays line for a nurse who worked none', async () => {
    await expandAna(['2026-10-03'], ['2026-10-03']);
    expect(screen.queryByText(/^Holidays:/)).toBeNull();
    expect(screen.getByText(/^Weekends:/)).toBeTruthy();
  });

  it('says a nurse is level with the unit when she has the average', async () => {
    await expandAna(['2026-10-03', '2026-10-04'], ['2026-10-10', '2026-10-11']);
    expect(screen.getByText('2 weekend days, the same as the unit average of 2.')).toBeTruthy();
  });

  it('says fewer weekend days when she is under the unit average', async () => {
    await expandAna(['2026-10-03'], ['2026-10-10', '2026-10-11', '2026-10-17', '2026-10-18']);
    // Mean (1 + 4) / 2 = 2.5; Ana is 1.5 under.
    expect(screen.getByText('1.5 fewer weekend days than the unit average of 2.5.')).toBeTruthy();
  });

  it('lists per-diem staff when nobody scored has a contracted share', async () => {
    const ana = makeNurse({ firstName: 'Ana', lastName: 'Reyes', contractedHoursPerPeriod: 0 });
    const ben = makeNurse({ firstName: 'Ben', lastName: 'Cole', contractedHoursPerPeriod: 0 });
    const scores = [scoreFor(ana.id, []), scoreFor(ben.id, [])];
    renderWithApp(<NurseFairnessTable scores={scores} nurses={[ana, ben]} trend={[]} />);

    expect(await screen.findByText(/Nobody scored here has a contracted share/)).toBeTruthy();
    expect(screen.getByText(/Ana/)).toBeTruthy();
    expect(screen.getByText(/Ben/)).toBeTruthy();
    expect(screen.queryByText('No nurses scored for this period.')).toBeNull();
  });

  it('puts the lowest-scoring nurse with a contract first', async () => {
    const [ana, ben, cy] = ['Ana', 'Ben', 'Cy'].map((firstName) =>
      makeNurse({ firstName, lastName: 'Test', contractedHoursPerPeriod: 72 }),
    );
    const scores = [
      scoreFor(ana!.id, [], [], [], 80),
      scoreFor(ben!.id, [], [], [], 55),
      scoreFor(cy!.id, [], [], [], 70),
    ];
    renderWithApp(<NurseFairnessTable scores={scores} nurses={[ana!, ben!, cy!]} trend={[]} />);

    const rows = await screen.findAllByTestId('fairness-row');
    expect(rows.map((r) => within(r).getByRole('button').textContent)).toEqual([
      expect.stringContaining('Ben'),
      expect.stringContaining('Cy'),
      expect.stringContaining('Ana'),
    ]);
  });

  it('folds per-diem staff into their own list instead of heading the table', async () => {
    const ana = makeNurse({ firstName: 'Ana', lastName: 'Reyes', contractedHoursPerPeriod: 72 });
    const dee = makeNurse({ firstName: 'Dee', lastName: 'Park', contractedHoursPerPeriod: 0 });
    const scores = [scoreFor(ana.id, [], [], [], 90), scoreFor(dee.id, [], [], [], 20)];
    renderWithApp(<NurseFairnessTable scores={scores} nurses={[ana, dee]} trend={[]} />);

    const main = await screen.findByTestId('fairness-table');
    const mainRows = within(main).getAllByTestId('fairness-row');
    expect(mainRows).toHaveLength(1);
    expect(mainRows[0]!.textContent).toContain('Ana');
    expect(within(main).queryByText(/Dee/)).toBeNull();

    const summary = screen.getByText(/^Per-diem and agency staff \(1\)/);
    const folded = summary.closest('details')!;
    expect(within(folded).getByText(/Dee/)).toBeTruthy();
  });
});
