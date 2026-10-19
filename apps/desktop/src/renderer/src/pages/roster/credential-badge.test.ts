import { addDays, today } from '@shiftnurse/core';
import { describe, expect, it } from 'vitest';
import { standingOf } from './credential-badge.js';

describe('how a credential stands', () => {
  it('counts the expiry day itself as still valid, and the day after as lapsed', () => {
    // Hand: a card that expires today is valid until midnight, so it is only "soon".
    expect(standingOf(addDays(today(), 0))).toBe('soon');
    expect(standingOf(addDays(today(), -1))).toBe('lapsed');
  });

  it('marks thirty days out as soon and thirty-one as fine', () => {
    expect(standingOf(addDays(today(), 30))).toBe('soon');
    expect(standingOf(addDays(today(), 31))).toBeUndefined();
    expect(standingOf(undefined)).toBeUndefined();
  });
});
