import { describe, expect, it, vi } from 'vitest';
import { createQuitGuard, KEEP_OPEN, QUIT_ANYWAY } from './quit-guard.js';

function guard(count: number, answer: number, smoke = false) {
  const ask = vi.fn((_q: unknown) => answer);
  return { ask, guard: createQuitGuard({ unsaved: () => count, ask, isSmoke: () => smoke }) };
}

describe('quit guard', () => {
  it('asks before quitting with two unsaved schedules, and stays open when the manager keeps it', () => {
    const { ask, guard: g } = guard(2, KEEP_OPEN);
    expect(g.shouldKeepOpen()).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]![0]).toMatchObject({
      message: '2 generated schedules are not saved.',
      buttons: ['Quit anyway', 'Keep ShiftNurse open'],
    });
  });

  it('says "is" for a single unsaved schedule', () => {
    const { ask, guard: g } = guard(1, KEEP_OPEN);
    g.shouldKeepOpen();
    expect(ask.mock.calls[0]![0]).toMatchObject({ message: '1 generated schedule is not saved.' });
  });

  it('quits without asking when nothing is unsaved', () => {
    const { ask, guard: g } = guard(0, KEEP_OPEN);
    expect(g.shouldKeepOpen()).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it('lets the manager quit when the question could not be shown', () => {
    const { ask, guard: g } = guard(2, -1000);
    expect(g.shouldKeepOpen()).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('asks again on the next quit after the manager chose to keep ShiftNurse open', () => {
    const { ask, guard: g } = guard(2, KEEP_OPEN);
    expect(g.shouldKeepOpen()).toBe(true);
    expect(g.shouldKeepOpen()).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('asks once per quit, so the second pass after shutdown does not ask again', () => {
    const { ask, guard: g } = guard(2, QUIT_ANYWAY);
    expect(g.shouldKeepOpen()).toBe(false);
    expect(g.shouldKeepOpen()).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('asks again when an unsaved form kept the window open after "Quit anyway"', () => {
    const { ask, guard: g } = guard(2, QUIT_ANYWAY);
    expect(g.shouldKeepOpen()).toBe(false);
    g.quitCancelled();
    g.shouldKeepOpen();
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('never asks in a smoke run', () => {
    const { ask, guard: g } = guard(5, KEEP_OPEN, true);
    expect(g.shouldKeepOpen()).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });
});
