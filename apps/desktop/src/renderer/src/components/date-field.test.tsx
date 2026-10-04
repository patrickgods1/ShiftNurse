// @vitest-environment jsdom
import { type IsoDate, isoDate } from '@shiftnurse/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DateField, dateProblem } from './date-field.js';
import { TipProvider } from './field-help.js';

afterEach(cleanup);

const OCT_3 = isoDate('2026-10-03');

describe('DateField', () => {
  it('labels the input and passes a picked date on', () => {
    const onChange = vi.fn();
    render(<DateField label="First day off" value="" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('First day off'), { target: { value: '2026-10-09' } });
    expect(onChange).toHaveBeenCalledWith('2026-10-09');
  });

  it('passes an emptied field on as empty', () => {
    const onChange = vi.fn();
    render(<DateField label="Day" value={OCT_3} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('says so when the date is before the earliest allowed', () => {
    render(<DateField label="Day" value={isoDate('2026-10-01')} min={OCT_3} onChange={() => {}} />);
    expect(screen.getByRole('alert').textContent).toBe('Pick a date on or after Oct 3, 2026');
    expect(screen.getByLabelText('Day').getAttribute('aria-invalid')).toBe('true');
  });

  it('says so when the date is after the latest allowed', () => {
    render(<DateField label="Day" value={isoDate('2026-10-20')} max={OCT_3} onChange={() => {}} />);
    expect(screen.getByRole('alert').textContent).toBe('Pick a date on or before Oct 3, 2026');
  });

  it('shows no complaint for a date inside the range or an empty optional field', () => {
    render(
      <>
        <DateField label="A" value={OCT_3} min={OCT_3} max={OCT_3} onChange={() => {}} />
        <DateField label="B" value="" min={OCT_3} onChange={() => {}} />
      </>,
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the visible hint attached to the input', () => {
    render(
      <DateField label="Day" value="" hint="The first day you are away" onChange={() => {}} />,
    );
    const hint = screen.getByText('The first day you are away');
    expect(screen.getByLabelText('Day').getAttribute('aria-describedby')).toBe(hint.id);
  });
});

describe('DateField attributes', () => {
  it('keeps the ⓘ tip beside the label, never inside it', () => {
    render(
      <TipProvider>
        <DateField label="Day" value="" tip="Why you would change it" onChange={() => {}} />
      </TipProvider>,
    );
    const tip = screen.getByRole('button', { name: 'About Day' });
    expect(tip.closest('label')).toBeNull();
    expect(screen.getByLabelText('Day').tagName).toBe('INPUT');
  });

  it('marks the input required and can be disabled', () => {
    render(<DateField label="Day" value="" required disabled onChange={() => {}} />);
    const input = screen.getByLabelText('Day') as HTMLInputElement;
    expect(input.required).toBe(true);
    expect(input.disabled).toBe(true);
  });

  it('hands min and max to the browser picker', () => {
    render(
      <DateField
        label="Day"
        value=""
        min={OCT_3}
        max={isoDate('2026-10-31')}
        onChange={() => {}}
      />,
    );
    const input = screen.getByLabelText('Day');
    expect(input.getAttribute('min')).toBe('2026-10-03');
    expect(input.getAttribute('max')).toBe('2026-10-31');
  });
});

describe('dateProblem', () => {
  it('rejects a calendar date that does not exist', () => {
    expect(dateProblem('2026-02-30', undefined, undefined)).toBe('Enter a valid date.');
  });

  it('accepts the boundary days themselves', () => {
    const edge: IsoDate = isoDate('2026-10-03');
    expect(dateProblem(edge, edge, edge)).toBeUndefined();
  });
});
