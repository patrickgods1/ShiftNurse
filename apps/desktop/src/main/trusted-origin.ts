/**
 * Which pages may hold the preload bridge, and which links may leave the app.
 *
 * The preload runs on every page load in the main window, so whatever page is showing gets
 * `window.shiftnurse` — backups, restore, every write. The grid is built on native drag and
 * drop, and a file dropped outside a drop target makes Chromium navigate the window to it;
 * without a navigation guard, a dropped HTML file would be running with the full API. These
 * are pure functions so the policy is testable without Electron; `index.ts` and `ipc.ts`
 * apply them.
 */

import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppLocation {
  /** The built renderer's `index.html` on disk. */
  indexHtmlPath: string;
  /** electron-vite's dev server, when running `npm run dev`. */
  devServerUrl?: string;
  /** Windows path rules; defaults to the host's. A parameter so tests can exercise both. */
  windows?: boolean;
}

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/**
 * The renderer itself: the dev server's origin in dev, else exactly the packaged index.html.
 * Compared as decoded file paths, never URL strings: Chromium and Node disagree on encoding
 * (`RUNNER~1` vs `RUNNER%7E1` in a Windows 8.3 short path) and on drive-letter case, and a
 * string comparison refused every IPC call from the packaged app's own window on Windows.
 */
export function isAppUrl(url: string, app: AppLocation): boolean {
  const parsed = parse(url);
  if (!parsed) return false;
  if (app.devServerUrl !== undefined) {
    const dev = parse(app.devServerUrl);
    return dev !== undefined && parsed.origin === dev.origin;
  }
  if (parsed.protocol !== 'file:') return false;
  const windows = app.windows ?? process.platform === 'win32';
  let path: string;
  try {
    path = fileURLToPath(parsed, { windows });
  } catch {
    return false;
  }
  const paths = windows ? win32 : posix;
  const got = paths.normalize(path);
  const want = paths.normalize(app.indexHtmlPath);
  // NTFS is case-insensitive; the drive letter in particular arrives in either case.
  return windows ? got.toLowerCase() === want.toLowerCase() : got === want;
}

/** `shell.openExternal` hands a URL to the OS, which will launch any registered protocol
 * handler — so only schemes a nurse manager's link could legitimately use get through. */
export function isSafeExternalUrl(url: string): boolean {
  const parsed = parse(url);
  return parsed !== undefined && (parsed.protocol === 'https:' || parsed.protocol === 'mailto:');
}
