/**
 * Native file pickers, asynchronous and parented to the focused window. The `*Sync` variants
 * block the main process's event loop for as long as the dialog is open: every other IPC call —
 * a validation refresh, a solver status poll — queues behind a manager deciding where to save a
 * file. Keeping Electron's dialog API here also keeps it out of the `api/` domain modules.
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
