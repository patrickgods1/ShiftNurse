/**
 * Native file pickers, asynchronous. The `*Sync` variants block the main process's event loop
 * for as long as the dialog is open: every other IPC call — a validation refresh, a solver status
 * poll — queues behind a manager deciding where to save a file.
 */

import { type BrowserWindow, dialog } from 'electron';

export async function openFile(
  win: BrowserWindow | null,
  options: Electron.OpenDialogOptions,
): Promise<string | undefined> {
  const { canceled, filePaths } = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  return canceled ? undefined : filePaths[0];
}

export async function saveFile(
  win: BrowserWindow | null,
  options: Electron.SaveDialogOptions,
): Promise<string | undefined> {
  const { canceled, filePath } = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options);
  return canceled || !filePath ? undefined : filePath;
}
