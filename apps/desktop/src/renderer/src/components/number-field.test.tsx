// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NumberField, type NumberFieldProps } from './number-field.js';

afterEach(cleanup);

function Harness({
  start,
  spy,
  ...rest
}: {
  start: number | undefined;
  spy: (v: number | undefined) => void;
} & Partial<NumberFieldProps>) {
  const [v, setV] = useState(start);
  return (
    <NumberField
      label="Minimum rest (hours)"
      value={v}
      min={0}
      {...rest}
      onCommit={(next) => {
        spy(next);
        setV(next);
      }}
    />
  );
}

const input = () => screen.getByLabelText('Minimum rest (hours)') as HTMLInputElement;
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });

describe('NumberField', () => {
  it('clearing the field to retype it does not save zero', () => {
    const spy = vi.fn();
    render(<Harness start={10} spy={spy} />);
    type('');
    expect(spy).not.toHaveBeenCalled();
    fireEvent.blur(input());
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('Enter a number.');
    type('11');
    fireEvent.blur(input());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(11);
  });

  it('saves once on blur, not on every keystroke', () => {
    const spy = vi.fn();
    render(<Harness start={10} spy={spy} />);
    fireEvent.focus(input());
    type('1');
    type('12');
    expect(spy).not.toHaveBeenCalled();
    fireEvent.blur(input());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(12);
  });

  it('Enter saves without waiting for the field to lose focus', () => {
    const spy = vi.fn();
    render(<Harness start={10} spy={spy} />);
    fireEvent.focus(input());
    type('8');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(spy).toHaveBeenCalledWith(8);
    expect(input().value).toBe('8');
  });

  it('leaving the field unchanged writes nothing', () => {
    const spy = vi.fn();
    render(<Harness start={10} spy={spy} />);
    fireEvent.focus(input());
    fireEvent.blur(input());
    expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('refuses a value outside the range and says why', () => {
    const spy = vi.fn();
    render(<Harness start={10} spy={spy} max={24} />);
    type('30');
    fireEvent.blur(input());
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('Must be at most 24.');
    expect(input().value).toBe('30');
  });

  it('a value saved elsewhere shows up while the field is idle, but not over the manager’s typing', () => {
    const spy = vi.fn();
    const { rerender } = render(
      <NumberField label="Minimum rest (hours)" value={10} onCommit={spy} />,
    );
    rerender(<NumberField label="Minimum rest (hours)" value={9} onCommit={spy} />);
    expect(input().value).toBe('9');
    fireEvent.focus(input());
    type('7');
    rerender(<NumberField label="Minimum rest (hours)" value={6} onCommit={spy} />);
    expect(input().value).toBe('7');
  });

  it('an optional field can be cleared to mean "not set"', () => {
    const spy = vi.fn();
    render(<Harness start={4} spy={spy} allowBlank />);
    type('');
    fireEvent.blur(input());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(undefined);
  });

  it('change mode saves each valid keystroke but never a half-typed minus sign', () => {
    const spy = vi.fn();
    render(<Harness start={10} spy={spy} commit="change" min={undefined} />);
    type('-');
    expect(spy).not.toHaveBeenCalled();
    type('-3');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(-3);
  });

  it('change mode follows a later save from elsewhere once the manager has left the field', () => {
    const spy = vi.fn();
    const { rerender } = render(
      <NumberField label="Minimum rest (hours)" value={10} onCommit={spy} commit="change" />,
    );
    fireEvent.focus(input());
    type('12');
    fireEvent.blur(input());
    rerender(<NumberField label="Minimum rest (hours)" value={9} onCommit={spy} commit="change" />);
    expect(input().value).toBe('9');
  });
});
