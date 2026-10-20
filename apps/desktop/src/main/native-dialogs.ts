/**
 * Native file pickers, asynchronous and parented to the focused window. The `*Sync` variants
 * block the main process's event loop for as long as the dialog is open: every other IPC call —
 * a validation refresh, a solver status poll — queues behind a manager deciding where to save a
 * file. Keeping Electron's dialog API here also keeps it out of the `api/` domain modules.
 * `askSync` is the one blocking exception: before-quit and close need their answer before the
 * event returns, and nothing else can be waiting on the manager at that point.
 */

import { BrowserWindow, dialog } from 'electron';

export async function openFile(options: Electron.OpenDialogOptions): Promise<string | undefined> {
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  return canceled ? undefined : filePaths[0];
}

export async function saveFile(options: Electron.SaveDialogOptions): Promise<string | undefined> {
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePath } = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options);
  return canceled || !filePath ? undefined : filePath;
}

/**
 * A blocking question, parented to the window the manager is looking at, found when it is asked.
 * Only for the few decisions Electron needs synchronously (before-quit, close).
 */
export function askSync(options: Electron.MessageBoxSyncOptions): number {
  // isVisible skips the hidden PDF window; a window held from earlier may be destroyed by now.
  const parent =
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible());
  return parent ? dialog.showMessageBoxSync(parent, options) : dialog.showMessageBoxSync(options);
}

/**
 * A non-blocking question parented to `win`, or to nothing when it is already gone (a destroyed
 * parent makes Electron return without showing the box). Aborting `signal` answers `cancelId`.
 * `signal` in options closes the box, except a parentless box on macOS.
 */
export async function ask(
  win: BrowserWindow,
  options: Electron.MessageBoxOptions,
): Promise<number> {
  const { response } = win.isDestroyed()
    ? await dialog.showMessageBox(options)
    : await dialog.showMessageBox(win, options);
  return response;
}
