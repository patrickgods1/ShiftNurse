import { describe, expect, it } from 'vitest';
import { dayNumber, isoDate } from '../domain/time.js';
import { describeMinute, hoursText, hoursWords } from './format.js';

describe('rule message wording', () => {
  it('prints a whole number of hours without a decimal', () => {
    expect(hoursText(48)).toBe('48h');
  });

  it('rounds hours to one decimal place', () => {
    expect(hoursText(6.25)).toBe('6.3h');
  });

  it('says "1 hour" in the singular and "10 hours" otherwise', () => {
    expect(hoursWords(1)).toBe('1 hour');
    expect(hoursWords(10)).toBe('10 hours');
  });

  it('names a minute on the timeline by weekday, date and clock time', () => {
    expect(describeMinute(dayNumber(isoDate('2026-01-05')) * 1440 + 7 * 60)).toBe(
      'Mon Jan 5 07:00',
    );
  });
});
