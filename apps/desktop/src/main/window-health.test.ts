import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { type HealthDeps, type HealthWindow, watchWindowHealth } from './window-health.js';

function setup(opts: { smoke?: boolean } = {}) {
  const win = new EventEmitter();
  const contents = new EventEmitter();
  const reload = vi.fn();
  const forcefullyCrashRenderer = vi.fn();
  const window = Object.assign(win, {
    webContents: Object.assign(contents, { reload, forcefullyCrashRenderer }),
  }) as unknown as HealthWindow;
  let answer: (n: number) => void = () => {};
  const ask = vi.fn<HealthDeps['ask']>(
    () =>
      new Promise<number>((resolve) => {
        answer = resolve;
      }),
  );
  const quit = vi.fn();
  const log = vi.fn();
  watchWindowHealth(window, { isSmoke: () => opts.smoke ?? false, ask, quit, log });
  return {
    win,
    contents,
    reload,
    forcefullyCrashRenderer,
    ask,
    quit,
    log,
    answer: (n: number) => answer(n),
  };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

describe('window health', () => {
  it('offers to reload a window whose page crashed, and reloads it when asked', async () => {
    const t = setup();
    t.contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 139 });
    expect(t.log).toHaveBeenCalledWith("[main] the window's page stopped: crashed (exit code 139)");
    expect(t.ask.mock.calls[0]![1].message).toBe('The ShiftNurse window stopped working.');
    t.answer(0);
    await flush();
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it('quits through the normal quit path when the manager chooses Quit', async () => {
    const t = setup();
    t.contents.emit('render-process-gone', {}, { reason: 'oom', exitCode: -1 });
    t.answer(1);
    await flush();
    expect(t.quit).toHaveBeenCalledTimes(1);
    expect(t.reload).not.toHaveBeenCalled();
  });

  it('says nothing when the page closed normally', () => {
    const t = setup();
    t.contents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
    expect(t.ask).not.toHaveBeenCalled();
  });

  it('only logs in a smoke run, so the harness reports the crash itself', () => {
    const t = setup({ smoke: true });
    t.contents.emit('render-process-gone', {}, { reason: 'oom', exitCode: -1 });
    expect(t.ask).not.toHaveBeenCalled();
    expect(t.log).toHaveBeenCalledTimes(1);
  });

  it('asks once while the window hangs and withdraws the question when it recovers', () => {
    const t = setup();
    t.win.emit('unresponsive');
    t.win.emit('unresponsive');
    expect(t.ask).toHaveBeenCalledTimes(1);
    const signal = t.ask.mock.calls[0]![1].signal!;
    expect(signal.aborted).toBe(false);
    t.win.emit('responsive');
    expect(signal.aborted).toBe(true);
  });

  it('restarts a hung page when the manager chooses Reload', async () => {
    const t = setup();
    t.win.emit('unresponsive');
    t.answer(1);
    await flush();
    expect(t.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
    expect(t.reload).toHaveBeenCalledTimes(1);
    expect(t.forcefullyCrashRenderer.mock.invocationCallOrder[0]!).toBeLessThan(
      t.reload.mock.invocationCallOrder[0]!,
    );
  });

  it('does not announce a crash it caused itself while reloading a hung page', async () => {
    const t = setup();
    t.win.emit('unresponsive');
    t.forcefullyCrashRenderer.mockImplementation(() =>
      t.contents.emit('render-process-gone', {}, { reason: 'killed', exitCode: 1 }),
    );
    t.answer(1);
    await flush();
    expect(t.ask).toHaveBeenCalledTimes(1);
    expect(t.reload).toHaveBeenCalledTimes(1);
    // Once the page has loaded again, a real crash is announced as usual.
    t.contents.emit('did-finish-load');
    t.contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 139 });
    expect(t.ask).toHaveBeenCalledTimes(2);
  });

  it('asks again when the window hangs a second time after the first question was answered', async () => {
    const t = setup();
    t.win.emit('unresponsive');
    t.answer(0);
    await flush();
    t.win.emit('unresponsive');
    expect(t.ask).toHaveBeenCalledTimes(2);
  });

  it('logs a question that could not be shown instead of leaving it unhandled', async () => {
    const t = setup();
    t.ask.mockRejectedValueOnce(new Error('no window'));
    t.contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await flush();
    expect(t.log).toHaveBeenCalledWith(expect.stringContaining('the crash question failed'));
  });

  it('leaves a recovered page alone when Reload is answered after it came back', async () => {
    const t = setup();
    t.win.emit('unresponsive');
    t.win.emit('responsive');
    t.answer(1);
    await flush();
    expect(t.forcefullyCrashRenderer).not.toHaveBeenCalled();
    expect(t.reload).not.toHaveBeenCalled();
  });
});
