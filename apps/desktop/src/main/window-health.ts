/**
 * What the manager sees when the window's page dies or hangs. A renderer that runs out of memory
 * on a large grid used to leave a blank window, no log line and no way back but quitting. The
 * decisions live here, with Electron injected, so they can be tested; `index.ts` supplies the
 * real window and dialog. Nothing here reads page content: the log line and the dialogs carry
 * the crash reason and exit code only, because a page can hold nurse names.
 */

export interface HealthWindow {
  on(event: 'unresponsive' | 'responsive', listener: () => void): unknown;
  webContents: {
    on(
      event: 'render-process-gone',
      listener: (e: unknown, details: { reason: string; exitCode: number }) => void,
    ): unknown;
    on(event: 'did-finish-load' | 'did-fail-load', listener: () => void): unknown;
    reload(): void;
    forcefullyCrashRenderer(): void;
  };
}

export interface HealthDeps {
  isSmoke(): boolean;
  /** Resolves with the pressed button's index; aborting the signal answers cancelId. */
  ask(
    win: HealthWindow,
    options: {
      message: string;
      detail: string;
      buttons: string[];
      defaultId: number;
      cancelId: number;
      signal?: AbortSignal;
    },
  ): Promise<number>;
  quit(): void;
  log(message: string): void;
}

export function watchWindowHealth(win: HealthWindow, deps: HealthDeps): void {
  let hangQuestion: AbortController | undefined;
  // Forcing a hung page to crash fires render-process-gone, which would ask "stopped working"
  // of a window that is already reloading. Cleared when the reloaded page settles.
  let recovering = false;
  const settled = () => {
    recovering = false;
  };
  win.webContents.on('did-finish-load', settled);
  win.webContents.on('did-fail-load', settled);

  win.webContents.on('render-process-gone', (_e, { reason, exitCode }) => {
    deps.log(`[main] the window's page stopped: ${reason} (exit code ${exitCode})`);
    // The smoke harness reports a crash itself and nobody is there to answer.
    if (reason === 'clean-exit' || deps.isSmoke() || recovering) return;
    void (async () => {
      try {
        const choice = await deps.ask(win, {
          message: 'The ShiftNurse window stopped working.',
          detail:
            'Everything you saved is safe, and generated schedules you have not saved are still kept. Reload the window to carry on.',
          buttons: ['Reload', 'Quit ShiftNurse'],
          defaultId: 0,
          cancelId: 0,
        });
        if (choice === 1) deps.quit();
        else win.webContents.reload();
      } catch (err) {
        deps.log(`[main] the crash question failed: ${err}`);
      }
    })();
  });

  win.on('unresponsive', () => {
    deps.log('[main] the window stopped responding');
    if (deps.isSmoke() || hangQuestion) return;
    const question = new AbortController();
    hangQuestion = question;
    void (async () => {
      try {
        const choice = await deps.ask(win, {
          message: 'ShiftNurse is not responding.',
          detail:
            'It may be busy with a large schedule. Wait, or reload the window — edits on the page that are not saved will be lost.',
          buttons: ['Wait', 'Reload'],
          defaultId: 0,
          cancelId: 0,
          signal: question.signal,
        });
        // An answer that raced the page recovering (or a box that ignored the abort) must not
        // crash a working page and lose its unsaved edits.
        if (choice === 1 && !question.signal.aborted) {
          // Electron's documented recovery for a renderer stuck in a loop.
          recovering = true;
          win.webContents.forcefullyCrashRenderer();
          win.webContents.reload();
        }
      } catch (err) {
        deps.log(`[main] the hang question failed: ${err}`);
      } finally {
        if (hangQuestion === question) hangQuestion = undefined;
      }
    })();
  });

  win.on('responsive', () => {
    if (!hangQuestion) return;
    deps.log('[main] the window is responding again');
    hangQuestion.abort();
  });
}
