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
import { app, BrowserWindow, session, shell } from 'electron';
import { createApi, createSolverJobs } from './api.js';
import { ensureDailyBackup } from './backups.js';
import { closeAppDatabase, openAppDatabase } from './database.js';
import { registerIpc } from './ipc.js';
import { isSmokeRun, runSmoke } from './smoke.js';
import { type AppLocation, isAppUrl, isSafeExternalUrl } from './trusted-origin.js';

const APP_LOCATION: AppLocation = {
  indexHtmlPath: join(import.meta.dirname, '../renderer/index.html'),
  devServerUrl: is.dev ? process.env.ELECTRON_RENDERER_URL : undefined,
};

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

  if (APP_LOCATION.devServerUrl !== undefined) {
    void win.loadURL(APP_LOCATION.devServerUrl);
  } else {
    void win.loadFile(APP_LOCATION.indexHtmlPath);
  }
  return win;
}

// A smoke run must never touch the real user database.
if (isSmokeRun())
  app.setPath('userData', join(app.getPath('temp'), `shiftnurse-smoke-${process.pid}`));

// Every window, including the hidden print window: no page may navigate away from the app
// (a file dropped on the grid would otherwise load with the preload bridge attached), and
// links open in the system browser only for schemes that cannot launch a local handler.
app.on('web-contents-created', (_, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url, APP_LOCATION)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
});

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.shiftnurse.desktop');
  // The app needs no camera, microphone, notifications or geolocation; say no to all of it.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window));

  const db = openAppDatabase();
  const solverJobs = createSolverJobs(db);
  registerIpc(createApi(db, solverJobs), (url) => isAppUrl(url, APP_LOCATION));
  // The rolling daily copy. Off the startup path: a slow disk must not delay the window.
  void ensureDailyBackup(db).then(
    (b) => b && console.log(`[backup] daily backup written to ${b.path}`),
    (err) => console.error(`[backup] daily backup failed: ${err}`),
  );
  // Workers must not outlive the database handle they would write into.
  app.on('will-quit', () => solverJobs.dispose());
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
