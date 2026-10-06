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
import { app, BrowserWindow, dialog, screen, session, shell } from 'electron';
import type { UpdateInfo } from '../shared/api.js';
import { createApi, createSolverJobs } from './api.js';
import {
  backupBeforeMigrate,
  backupsDir,
  backupsInFlight,
  purgeExpiredBackups,
  recordBackup,
  startDailyBackups,
} from './backups.js';
import { closeAppDatabase, databasePath, openAppDatabase } from './database.js';
import { registerIpc } from './ipc.js';
import { createFileLog, teeConsole } from './log.js';
import { isSmokeRun } from './smoke-flag.js';
import spawnSolverWorker from './solver-worker?nodeWorker';
import { type AppLocation, isAppUrl, isSafeExternalUrl } from './trusted-origin.js';
import { checkForUpdate } from './updates.js';

const APP_LOCATION: AppLocation = {
  indexHtmlPath: join(import.meta.dirname, '../renderer/index.html'),
  devServerUrl: is.dev ? process.env.ELECTRON_RENDERER_URL : undefined,
};

/** `--window-size WxH` on the smoke launcher, to capture the app as a 1366x768 laptop shows it. */
function smokeWindowSize(): { width: number; height: number } | undefined {
  const match = /^(\d{3,5})x(\d{3,5})$/.exec(process.env.SHIFTNURSE_SMOKE_WINDOW_SIZE ?? '');
  return isSmokeRun() && match ? { width: Number(match[1]), height: Number(match[2]) } : undefined;
}

function createWindow(): BrowserWindow {
  const size = smokeWindowSize();
  // Windows and macOS display scaling shrinks the logical screen: a 1366x768 laptop at 150% is
  // 910x512 DIP before the taskbar, 1280x720 at 150% is 853x480. A fixed 1000x640 minimum is
  // larger than those, so the title bar or right edge ended up off-screen and unreachable. Size
  // from the work area instead. A smoke run asks for an exact size and a CI runner's virtual
  // screen may be smaller, so the request is honoured unclamped (minimums stay within it).
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const smoke = isSmokeRun();
  const width = size?.width ?? (smoke ? 1400 : Math.min(1400, workArea.width));
  const height = size?.height ?? (smoke ? 900 : Math.min(900, workArea.height));
  const win = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(840, smoke ? width : workArea.width, width),
    minHeight: Math.min(440, smoke ? height : workArea.height, height),
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

  // A page holding unsaved edits blocks its own unload (the renderer's `beforeunload`). Electron
  // then cancels the close or reload silently, so the question is asked here, where a native
  // dialog can be shown. A smoke run never has anyone to answer it, and always proceeds.
  win.webContents.on('will-prevent-unload', (event) => {
    if (isSmokeRun()) {
      event.preventDefault();
      return;
    }
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Discard changes', 'Keep editing'],
      defaultId: 1,
      cancelId: 1,
      message: 'You have unsaved changes.',
      detail: 'Leave anyway and lose them?',
    });
    if (choice === 0) event.preventDefault();
  });

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

// Everything main prints also goes to userData/logs/main.log: a packaged app has no console.
const logsDir = join(app.getPath('userData'), 'logs');
teeConsole(createFileLog(logsDir));
process.on('uncaughtException', (err) => console.error('[main] uncaught exception:', err));
process.on('unhandledRejection', (err) => console.error('[main] unhandled rejection:', err));

// One copy of the app per user. A second would open the same database with its own solver
// jobs and backup sweep, and a restore in one would replace the file under the other's open
// connection. Launching again (a double-clicked shortcut) brings the running window forward.
const isPrimaryInstance = isSmokeRun() || app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();

let mainWindow: BrowserWindow | undefined;
let update: UpdateInfo | undefined;
/** Shutdown steps, run in order on quit: workers before the database they would write into. */
const onQuit: (() => void)[] = [];

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

// Every window, including the hidden print window: no page may navigate away from the app
// (a file dropped on the grid would otherwise load with the preload bridge attached), and
// links open in the system browser only for schemes that cannot launch a local handler.
app.on('web-contents-created', (_, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url, APP_LOCATION)) event.preventDefault();
  });
  // A redirect or a subframe navigation reaches the page with the same preload bridge, so the
  // one guard above is not enough on its own.
  contents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url, APP_LOCATION)) event.preventDefault();
  });
  contents.on('will-frame-navigate', (event) => {
    if (!isAppUrl(event.url, APP_LOCATION)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
});

/**
 * Generated variations live in memory until one is saved, so quitting throws them away — minutes
 * of solving the manager may not realise they are leaving behind. Ask first. On Windows closing
 * the window quits; on macOS it does not (the variations survive a closed window), so there the
 * question is asked when the app itself quits.
 */
function guardUnsavedVariations(win: BrowserWindow, unsaved: () => number): void {
  let confirmed = false;
  const keep = (): boolean => {
    if (confirmed || isSmokeRun()) return false;
    const count = unsaved();
    if (count === 0) return false;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Quit anyway', 'Keep ShiftNurse open'],
      defaultId: 1,
      cancelId: 1,
      message: `${count} generated schedule${count === 1 ? ' is' : 's are'} not saved.`,
      detail:
        'Generated variations are kept only while ShiftNurse is open. Save the one you want ' +
        'to the draft first, or quit and lose them.',
    });
    if (choice === 0) confirmed = true;
    return choice !== 0;
  };
  if (process.platform === 'darwin') {
    app.on('before-quit', (event) => {
      if (keep()) event.preventDefault();
    });
  } else {
    win.on('close', (event) => {
      if (keep()) event.preventDefault();
    });
  }
}

/**
 * Open the database, copying it first when an update is about to migrate it. The copy cannot
 * be audited until the schema is current, so its audit row is written after the migration.
 */
async function openDatabaseWithSafetyCopy() {
  let safetyCopy: Awaited<ReturnType<typeof backupBeforeMigrate>>;
  const db = await openAppDatabase(async (sqlite, status) => {
    safetyCopy = await backupBeforeMigrate(sqlite, status);
    if (safetyCopy)
      console.log(`[backup] copied the database before migrating: ${safetyCopy.path}`);
  });
  if (safetyCopy) recordBackup(db, safetyCopy);
  return db;
}

async function start(): Promise<void> {
  electronApp.setAppUserModelId('com.shiftnurse.desktop');
  // The app needs no camera, microphone, notifications or geolocation; say no to all of it.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window));

  const db = await openDatabaseWithSafetyCopy();
  const solverJobs = createSolverJobs(db, (workerData) => spawnSolverWorker({ workerData }));
  onQuit.push(() => solverJobs.dispose());
  registerIpc(
    createApi(db, solverJobs, {
      update: () => update,
      openLogs: () => void shell.openPath(logsDir),
    }),
    (url) => isAppUrl(url, APP_LOCATION),
  );
  // The rolling daily copy, now and hourly while the app stays open. Off the startup path: a
  // slow disk must not delay the window.
  onQuit.push(startDailyBackups(db, { info: console.log, error: console.error }));
  mainWindow = createWindow();
  guardUnsavedVariations(mainWindow, () => solverJobs.unsavedVariations());
  if (isSmokeRun()) {
    // The harness is large and only a smoke run needs it; a normal launch never loads it.
    const { runSmoke } = await import('./smoke.js');
    runSmoke(mainWindow);
  }
  // Deleted backups wait 30 days in the trash; anything past that goes now. Off the startup
  // path like the daily copy: it is disk I/O and audit writes the first paint need not wait for.
  setImmediate(() => {
    try {
      for (const b of purgeExpiredBackups(db)) console.log(`[backup] purged ${b.fileName}`);
    } catch (err) {
      console.error(`[backup] purging expired backups failed: ${err}`);
    }
  });
  // Ask GitHub once whether a newer release is out; never in development or a smoke run.
  if (app.isPackaged && !isSmokeRun()) {
    void checkForUpdate(app.getVersion()).then((found) => {
      update = found;
      if (found) console.log(`[update] ShiftNurse ${found.version} is available: ${found.url}`);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
}

/**
 * A database that will not open (a failed migration, a file from a newer release, a full or
 * read-only disk) must say so: an unhandled rejection here leaves no window and no message,
 * and on macOS a dock icon with nothing behind it.
 */
function failedToStart(err: unknown): void {
  console.error('[main] startup failed:', err);
  if (isSmokeRun()) {
    app.exit(1);
    return;
  }
  dialog.showErrorBox(
    'ShiftNurse could not start',
    `${err instanceof Error ? err.message : String(err)}\n\n` +
      `Database: ${databasePath()}\nBackups: ${backupsDir()}\nLog: ${join(logsDir, 'main.log')}`,
  );
  app.exit(1);
}

if (isPrimaryInstance) {
  app.whenReady().then(start).catch(failedToStart);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Quitting mid-backup would leave a partial file, so the first will-quit is held until every
// started backup write has settled, then quit again; the second pass goes straight through.
// Bounded, because a stalled copy must not keep a ward PC from quitting: the .partial it leaves
// is removed at next launch.
const QUIT_BACKUP_WAIT_MS = 30_000;
let quitting = false;
app.on('will-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  // One failing step must not strand the app windowless: every step runs, and quit follows.
  for (const step of onQuit) {
    try {
      step();
    } catch (err) {
      console.error('[main] shutdown step failed:', err);
    }
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, QUIT_BACKUP_WAIT_MS);
  });
  void Promise.race([backupsInFlight(), timeout])
    .catch((err) => console.error('[main] waiting for backups failed:', err))
    .finally(() => {
      clearTimeout(timer);
      try {
        closeAppDatabase();
      } catch (err) {
        console.error('[main] closing the database failed:', err);
      } finally {
        app.quit();
      }
    });
});
