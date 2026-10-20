// @vitest-environment jsdom
import { type AcuityTier, type CensusForecast, isoDate } from '@shiftnurse/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CensusCell } from './census-cell.js';

afterEach(cleanup);

const tiers: AcuityTier[] = [
  { id: 't1', unitId: 'u', name: 'Routine', level: 1, careHoursPerPatientDay: 4 },
  { id: 't2', unitId: 'u', name: 'High', level: 2, careHoursPerPatientDay: 8 },
];

function open(isPast = false) {
  const onSaveForecast = vi.fn();
  render(
    <CensusCell
      date={isoDate('2026-10-05')}
      shiftTypeId="st-day"
      existing={undefined}
      tiers={tiers}
      isPast={isPast}
      onSaveForecast={onSaveForecast}
      onSaveActual={vi.fn()}
      saving={false}
    />,
  );
  fireEvent.click(screen.getByTestId('census-cell-2026-10-05-st-day'));
  return onSaveForecast;
}

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('the census cell editor', () => {
  it('names the tier in the message, not its id', () => {
    open();
    type('Projected census', '3');
    type('Routine', '1.5');
    expect(screen.getByText('Enter a whole number.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('t1');

    type('Routine', '2');
    type('High', '2');
    expect(screen.getByText('Acuity mix adds up to 4 patients but the census is 3')).toBeTruthy();
    expect(document.body.textContent).not.toContain('t2');
  });

  it('lets the manager clear the census and type a new one', () => {
    open();
    type('Projected census', '3');
    type('Projected census', '');
    expect((screen.getByLabelText('Projected census') as HTMLInputElement).value).toBe('');
    expect(screen.getByText('Enter a number.')).toBeTruthy();
    expect((screen.getByText('Save forecast') as HTMLButtonElement).disabled).toBe(true);

    type('Projected census', '2');
    type('Routine', '1');
    type('High', '1');
    const save = screen.getByText('Save forecast') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
  });

  it('counts a blank tier as none when adding up the mix', () => {
    const onSave = open();
    type('Projected census', '2');
    type('Routine', '2');
    type('High', '');
    fireEvent.click(screen.getByText('Save forecast'));
    expect(onSave).toHaveBeenCalledWith(2, { t1: 2, t2: 0 });
  });

  it('says why an actual cannot be recorded before a forecast', () => {
    open(true);
    expect(screen.getByText(/Enter the forecast for this shift first/)).toBeTruthy();
  });

  it('keeps what the manager typed when the census refetches behind the open editor', () => {
    const row = (): CensusForecast =>
      ({
        id: 'c1',
        unitId: 'u',
        date: isoDate('2026-10-05'),
        shiftTypeId: 'st-day',
        projectedCensus: 3,
        acuityMix: { t1: 3, t2: 0 },
        source: 'manual',
      }) as CensusForecast;
    const cell = (existing: CensusForecast) => (
      <CensusCell
        date={isoDate('2026-10-05')}
        shiftTypeId="st-day"
        existing={existing}
        tiers={tiers}
        isPast={false}
        onSaveForecast={vi.fn()}
        onSaveActual={vi.fn()}
        saving={false}
      />
    );
    const view = render(cell(row()));
    fireEvent.click(screen.getByTestId('census-cell-2026-10-05-st-day'));
    type('Projected census', '7');

    view.rerender(cell(row()));

    expect((screen.getByLabelText('Projected census') as HTMLInputElement).value).toBe('7');
  });
});
