/**
 * Electron main process entry: opens the database, exposes the API over IPC, shows the window.
 *
 * Security posture is fixed here and not negotiable per window: `contextIsolation` on,
 * `nodeIntegration` off, `sandbox` on. The renderer is a web page that can only reach data
 * through the preload bridge, which is what makes the IPC contract a real boundary rather
 * than a convention.
 */

import { join } from 'node:path';
import { electronApp, is, optimizer } from '@electron-toolkit/utils';
import { app, BrowserWindow, shell } from 'electron';
import { createApi, createSolverJobs } from './api.js';
import { ensureDailyBackup } from './backups.js';
import { closeAppDatabase, openAppDatabase } from './database.js';
import { registerIpc } from './ipc.js';
import { isSmokeRun, runSmoke } from './smoke.js';
import { disposeCpsatRunner } from './solver-backends.js';

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // `hiddenInset` draws the traffic lights over the page instead of reserving a title bar
    // for them, and their default vertical position drifts across macOS releases. Pinning it
    // is what lets the renderer reserve exactly enough space for the sidebar's own title
    // (see the drag-region spacer in `router.tsx`) instead of guessing at an OS default.
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 16 } } : {}),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.on('ready-to-show', () => win.show());

  // Links in the UI open in the system browser, never inside the app's privileged window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
  return win;
}

// A smoke run must never touch the real user database.
if (isSmokeRun())
  app.setPath('userData', join(app.getPath('temp'), `shiftnurse-smoke-${process.pid}`));

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.shiftnurse.desktop');
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window));

  const db = openAppDatabase();
  const solverJobs = createSolverJobs(db);
  registerIpc(createApi(db, solverJobs));
  // The rolling daily copy. Off the startup path: a slow disk must not delay the window.
  void ensureDailyBackup(db).then(
    (b) => b && console.log(`[backup] daily backup written to ${b.path}`),
    (err) => console.error(`[backup] daily backup failed: ${err}`),
  );
  // Workers must not outlive the database handle they would write into.
  app.on('will-quit', () => {
    solverJobs.dispose();
    disposeCpsatRunner();
  });
  const win = createWindow();
  if (isSmokeRun()) runSmoke(win);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => closeAppDatabase());
