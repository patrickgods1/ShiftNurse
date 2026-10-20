// @vitest-environment jsdom
import type { ComparisonColumn } from '@shared/api.js';
import type { Nurse } from '@shiftnurse/core';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { CompareDialog } from './compare-dialog.js';

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

function column(over: Partial<ComparisonColumn> & { nights?: { min: number; max: number } }) {
  const { nights, ...rest } = over;
  return {
    floorsShort: 0,
    hardViolations: 0,
    softViolations: 0,
    fairnessMean: 80,
    fairnessGini: 0,
    preferencePoints: 0,
    objective: 100,
    shiftsChanged: 0,
    digest: {
      nights: nights ?? { min: 2, max: 3 },
      weekends: { min: 1, max: 1 },
      quickFlips: 0,
      nursesUnderContract: 0,
      againstPreference: 0,
      onDaysAskedOff: 0,
    },
    ...rest,
  } as ComparisonColumn;
}

function renderCompare(draft: ComparisonColumn, candidates: ComparisonColumn[]) {
  bridge.respond('solver', 'compare', { draft, candidates } as never);
  renderWithApp(
    <CompareDialog
      open
      onOpenChange={() => {}}
      periodId="p-1"
      batchId="b-1"
      offset={0}
      nurses={[] as Nurse[]}
      selected={undefined}
      onSelect={() => {}}
      onPreview={() => {}}
    />,
  );
}

/** The cells of the row whose heading starts with `label`, grid column first. */
async function rowCells(label: string): Promise<HTMLElement[]> {
  const heading = await screen.findByText(
    (_, el) => el?.tagName === 'TH' && !!el.textContent?.startsWith(label),
  );
  return [...(heading.closest('tr')?.querySelectorAll('td') ?? [])] as HTMLElement[];
}

describe('comparing options', () => {
  it('marks twelve nurses on two or three nights each fairer than four on six', async () => {
    renderCompare(column({ nights: { min: 2, max: 3 } }), [
      column({ index: 0, nights: { min: 6, max: 6 } }),
    ]);
    const [grid, option] = await rowCells('Nights each');
    expect(grid?.textContent).toContain('(best)');
    expect(option?.textContent).not.toContain('(best)');
  });

  it('marks the lighter weekend load by the heaviest nurse, not the spread', async () => {
    const wk = (min: number, max: number) => ({
      digest: {
        nights: { min: 2, max: 3 },
        weekends: { min, max },
        quickFlips: 0,
        nursesUnderContract: 0,
        againstPreference: 0,
        onDaysAskedOff: 0,
      },
    });
    renderCompare(column(wk(1, 2)), [column({ index: 0, ...wk(3, 3) })]);
    const [grid, option] = await rowCells('Weekends each');
    expect(grid?.textContent).toContain('(best)');
    expect(option?.textContent).not.toContain('(best)');
  });

  it('marks no best when every column ties after rounding', async () => {
    renderCompare(column({ fairnessMean: 70.4 }), [column({ index: 0, fairnessMean: 69.6 })]);
    const cells = await rowCells('Fairness, average');
    expect(cells.map((c) => c.textContent)).toEqual(['70', '70']);
    expect(cells.some((c) => c.textContent?.includes('(best)'))).toBe(false);
  });

  it('says in words why an option ran a different search', async () => {
    const reason = 'runner missing';
    renderCompare(column({}), [
      column({ index: 0, solver: 'sa-lns', fellBackFrom: { solver: 'cp-sat', reason } }),
    ]);
    const note = await screen.findByTestId('compare-fallback');
    expect(note.textContent).toBe('Option 1: Ran Fastest instead of Exhaustive: runner missing.');
  });
});
