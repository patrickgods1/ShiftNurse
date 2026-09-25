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

import { pathToFileURL } from 'node:url';

export interface AppLocation {
  /** The built renderer's `index.html` on disk. */
  indexHtmlPath: string;
  /** electron-vite's dev server, when running `npm run dev`. */
  devServerUrl?: string;
}

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** The renderer itself: the dev server's origin in dev, else exactly the packaged index.html. */
export function isAppUrl(url: string, app: AppLocation): boolean {
  const parsed = parse(url);
  if (!parsed) return false;
  if (app.devServerUrl !== undefined) {
    const dev = parse(app.devServerUrl);
    return dev !== undefined && parsed.origin === dev.origin;
  }
  return (
    parsed.protocol === 'file:' && parsed.pathname === pathToFileURL(app.indexHtmlPath).pathname
  );
}

/** `shell.openExternal` hands a URL to the OS, which will launch any registered protocol
 * handler — so only schemes a nurse manager's link could legitimately use get through. */
export function isSafeExternalUrl(url: string): boolean {
  const parsed = parse(url);
  return parsed !== undefined && (parsed.protocol === 'https:' || parsed.protocol === 'mailto:');
}
