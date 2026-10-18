// @vitest-environment jsdom
import { type CensusProposal, isoDate } from '@shiftnurse/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProposeDialog } from './propose-dialog.js';

afterEach(cleanup);

function proposal(date: string): CensusProposal {
  return {
    date: isoDate(date),
    shiftTypeId: 'st-day',
    unitId: 'unit-1',
    projectedCensus: 20,
    acuityMix: {},
    basis: { samples: 4, weekdayAverage: 20, seasonalSamples: 0, seasonalIndex: 1 },
  } as unknown as CensusProposal;
}

describe('proposing a census from history', () => {
  it('keeps a row the manager unticked when the census refetches', () => {
    const proposals = [proposal('2026-10-05'), proposal('2026-10-06')];
    const props = {
      open: true,
      onOpenChange: vi.fn(),
      proposals,
      shiftTypesById: new Map(),
      tierNames: new Map(),
      onAccept: vi.fn(),
      accepting: false,
    };
    const view = render(<ProposeDialog {...props} existing={[]} />);
    expect(screen.getByText('Accept 2 proposals')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    expect(screen.getByText('Accept 1 proposal')).toBeTruthy();

    view.rerender(<ProposeDialog {...props} existing={[]} />);

    expect(screen.getByText('Accept 1 proposal')).toBeTruthy();
    expect((screen.getAllByRole('checkbox')[0] as HTMLInputElement).checked).toBe(false);
  });
});
