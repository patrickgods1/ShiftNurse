import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isAppUrl, isSafeExternalUrl } from './trusted-origin.js';

const indexHtmlPath =
  '/Applications/ShiftNurse.app/Contents/Resources/app.asar/out/renderer/index.html';
const indexUrl = pathToFileURL(indexHtmlPath).href;

describe('isAppUrl', () => {
  it('trusts the packaged renderer page, including its hash routes', () => {
    expect(isAppUrl(indexUrl, { indexHtmlPath })).toBe(true);
    expect(isAppUrl(`${indexUrl}#/schedule`, { indexHtmlPath })).toBe(true);
  });

  it('does not trust a file a manager drags onto the window', () => {
    // Chromium navigates to a dropped file; the preload would then hand it the whole API.
    expect(isAppUrl('file:///Users/manager/Downloads/roster.html', { indexHtmlPath })).toBe(false);
  });

  it('trusts only the dev server origin when one is running', () => {
    const app = { indexHtmlPath, devServerUrl: 'http://localhost:5173/' };
    expect(isAppUrl('http://localhost:5173/#/roster', app)).toBe(true);
    expect(isAppUrl('http://localhost:5174/', app)).toBe(false);
    expect(isAppUrl(indexUrl, app)).toBe(false);
  });

  it('rejects anything that is not a URL at all', () => {
    expect(isAppUrl('', { indexHtmlPath })).toBe(false);
    expect(isAppUrl('not a url', { indexHtmlPath })).toBe(false);
  });
});

describe('isSafeExternalUrl', () => {
  it('opens web links and email in the system handlers', () => {
    expect(isSafeExternalUrl('https://example.org/policy')).toBe(true);
    expect(isSafeExternalUrl('mailto:charge@example.org')).toBe(true);
  });

  it('refuses local files, network shares and custom protocol handlers', () => {
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeExternalUrl('smb://server/share')).toBe(false);
    expect(isSafeExternalUrl('ms-msdt:/id')).toBe(false);
    expect(isSafeExternalUrl('http://example.org')).toBe(false);
  });
});
