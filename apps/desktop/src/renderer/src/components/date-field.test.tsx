// @vitest-environment jsdom
import { type IsoDate, isoDate } from '@shiftnurse/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DateField, dateProblem } from './date-field.js';
import { TipProvider } from './field-help.js';
import { Modal } from './modal.js';

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

  it('shows an error the form passes, tied to the input', () => {
    render(
      <DateField
        label="Seniority date"
        value=""
        onChange={() => {}}
        error="Seniority date is required."
      />,
    );
    const input = screen.getByLabelText('Seniority date');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const described = document.getElementById(input.getAttribute('aria-describedby') ?? '');
    expect(described?.textContent).toBe('Seniority date is required.');
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

describe('commit on blur', () => {
  const JAN_1 = isoDate('2026-01-01');
  const field = (onChange: () => void, value: IsoDate | '' = '') => (
    <DateField
      label="Requests close on"
      value={value}
      min={JAN_1}
      commitOnBlur
      onChange={onChange}
    />
  );
  const input = () => screen.getByLabelText('Requests close on');

  it('typing a date writes once, when the manager leaves the field', () => {
    const onChange = vi.fn();
    render(field(onChange));
    fireEvent.change(input(), { target: { value: '2026-10-14' } });
    fireEvent.change(input(), { target: { value: '2026-10-15' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('2026-10-15');
  });

  it('still saves a valid typed date while the form shows its own error', () => {
    const onChange = vi.fn();
    render(
      <DateField
        label="Requests close on"
        value=""
        commitOnBlur
        error="Date is required."
        onChange={onChange}
      />,
    );
    fireEvent.change(input(), { target: { value: '2026-10-15' } });
    fireEvent.blur(input());
    expect(onChange).toHaveBeenCalledWith('2026-10-15');
  });

  it('a date in the year 202 is not saved and says why', () => {
    const onChange = vi.fn();
    render(field(onChange));
    fireEvent.change(input(), { target: { value: '0202-10-15' } });
    fireEvent.blur(input());
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('Pick a date on or after Jan 1, 2026');
  });

  it('clearing a saved date and leaving writes the clear once', () => {
    const onChange = vi.fn();
    render(field(onChange, isoDate('2026-10-15')));
    fireEvent.change(input(), { target: { value: '' } });
    fireEvent.blur(input());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('Enter writes the date and the box keeps showing it', () => {
    const onChange = vi.fn();
    render(field(onChange));
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: '2026-10-15' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('2026-10-15');
    expect((input() as HTMLInputElement).value).toBe('2026-10-15');
  });

  it('leaving a date untouched writes nothing', () => {
    const onChange = vi.fn();
    render(field(onChange, isoDate('2026-10-15')));
    fireEvent.blur(input());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('puts back the saved date on Escape', () => {
    const onChange = vi.fn();
    render(field(onChange, isoDate('2026-10-15')));
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: '2026-10-20' } });
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect((input() as HTMLInputElement).value).toBe('2026-10-15');
    fireEvent.blur(input());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not clear the saved date when the manager leaves a half-typed one', () => {
    const onChange = vi.fn();
    render(field(onChange, isoDate('2026-10-15')));
    fireEvent.change(input(), { target: { value: '' } });
    // jsdom never sets badInput; Chromium does for a partly typed date.
    Object.defineProperty(input(), 'validity', { value: { badInput: true }, configurable: true });
    fireEvent.blur(input());
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('Enter a valid date.');
  });

  it('Escape on an edited date reverts it and leaves the dialog open', () => {
    const onOpenChange = vi.fn();
    render(
      <Modal open onOpenChange={onOpenChange} title="Window" description="Dates">
        {field(vi.fn(), isoDate('2026-10-15'))}
      </Modal>,
    );
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: '2026-10-20' } });
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect((input() as HTMLInputElement).value).toBe('2026-10-15');
    expect(onOpenChange).not.toHaveBeenCalled();
    // Nothing left to revert, so the next Escape closes the dialog.
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('without commit on blur, every change is passed on as before', () => {
    const onChange = vi.fn();
    render(<DateField label="Day" value="" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '2026-10-14' } });
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '2026-10-15' } });
    expect(onChange).toHaveBeenCalledTimes(2);
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
