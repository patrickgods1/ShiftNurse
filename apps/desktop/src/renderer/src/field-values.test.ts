import { describe, expect, it } from 'vitest';
import {
  numberFieldProblem,
  numberFieldText,
  parseIntegerField,
  parseNumberField,
} from './field-values.js';

describe('number field values', () => {
  it('a cleared field is no value, never zero', () => {
    expect(parseNumberField('')).toBeUndefined();
    expect(parseNumberField('   ')).toBeUndefined();
  });

  it('reads what the manager typed', () => {
    expect(parseNumberField('12')).toBe(12);
    expect(parseNumberField('0')).toBe(0);
    expect(parseNumberField('7.5')).toBe(7.5);
    expect(parseNumberField('-2')).toBe(-2);
    expect(parseNumberField('1e3')).toBe(1000);
  });

  it('rejects text that is not a number', () => {
    expect(parseNumberField('abc')).toBeUndefined();
    expect(parseNumberField('-')).toBeUndefined();
    expect(parseNumberField('1.2.3')).toBeUndefined();
  });

  it('a whole-number field refuses 2.5', () => {
    expect(parseIntegerField('2.5')).toBeUndefined();
    expect(parseIntegerField('3')).toBe(3);
    expect(numberFieldProblem('2.5', { integer: true })).toBe('Enter a whole number.');
  });

  it('says what is wrong in the same words as the Rules screen', () => {
    expect(numberFieldProblem('', {})).toBe('Enter a number.');
    expect(numberFieldProblem('', { allowBlank: true })).toBeUndefined();
    expect(numberFieldProblem('abc', { allowBlank: true })).toBe('Enter a number.');
    expect(numberFieldProblem('-1', { min: 0 })).toBe('Must be at least 0.');
    expect(numberFieldProblem('11', { max: 10 })).toBe('Must be at most 10.');
    expect(numberFieldProblem('10', { min: 0, max: 10 })).toBeUndefined();
  });

  it('shows a stored value as text, and nothing for no value', () => {
    expect(numberFieldText(undefined)).toBe('');
    expect(numberFieldText(null)).toBe('');
    expect(numberFieldText(0)).toBe('0');
  });
});
