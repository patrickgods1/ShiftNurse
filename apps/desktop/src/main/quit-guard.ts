/**
 * The "you have unsaved generated schedules" question on quit, as a decision with no Electron in
 * it. Generated variations live in memory until one is saved, so quitting throws minutes of
 * solving away. The first version held the window it would parent the dialog to; on macOS the
 * window can be closed while the app lives on, the dialog then returned -1000 without showing,
 * and "anything but Quit anyway" meant keep open: Quit, Dock > Quit and logout were refused with
 * no message. Here only the explicit Keep button keeps the app open, so a dialog that could not
 * be shown can never trap the manager.
 */

export const QUIT_ANYWAY = 0;
export const KEEP_OPEN = 1;

export interface QuitQuestion {
  message: string;
  detail: string;
  buttons: [string, string];
}

export interface QuitGuardDeps {
  unsaved(): number;
  /** Shows the question; returns the pressed button's index (Electron's convention). */
  ask(question: QuitQuestion): number;
  isSmoke(): boolean;
}

export interface QuitGuard {
  /** True only when the manager pressed "Keep ShiftNurse open". */
  shouldKeepOpen(): boolean;
  /** A close or quit this guard let through was cancelled later (an unsaved-form prompt). */
  quitCancelled(): void;
}

export function createQuitGuard(deps: QuitGuardDeps): QuitGuard {
  // Quit passes through here twice (before-quit, then the close it triggers); the manager has
  // answered once. Reset only when something else cancelled the quit, or the next one would not ask.
  let confirmed = false;
  return {
    shouldKeepOpen() {
      if (confirmed || deps.isSmoke()) return false;
      const count = deps.unsaved();
      if (count === 0) return false;
      const choice = deps.ask({
        message: `${count} generated schedule${count === 1 ? ' is' : 's are'} not saved.`,
        detail:
          'Generated variations are kept only while ShiftNurse is open. Save the one you want ' +
          'to the draft first, or quit and lose them.',
        buttons: ['Quit anyway', 'Keep ShiftNurse open'],
      });
      if (choice === KEEP_OPEN) return true;
      confirmed = true;
      return false;
    },
    quitCancelled() {
      confirmed = false;
    },
  };
}
