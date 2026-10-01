import { describe, expect, it } from 'vitest';
import { checkForUpdate, compareVersions, newerRelease } from './updates.js';

const RELEASE = {
  tag_name: 'v0.2.0',
  html_url: 'https://github.com/patrickgods1/ShiftNurse/releases/tag/v0.2.0',
  draft: false,
  prerelease: false,
};

describe('telling a manager a fix is out', () => {
  it('orders versions by number, not as text — 0.10.0 is after 0.9.3', () => {
    expect(compareVersions('0.10.0', '0.9.3')).toBeGreaterThan(0);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3', '1.3.0')).toBeLessThan(0);
  });

  it('offers a published release newer than the installed version', () => {
    expect(newerRelease(RELEASE, '0.1.0')).toEqual({ version: '0.2.0', url: RELEASE.html_url });
  });

  it('stays quiet when the installed version is current or ahead', () => {
    expect(newerRelease(RELEASE, '0.2.0')).toBeUndefined();
    expect(newerRelease(RELEASE, '0.3.0')).toBeUndefined();
  });

  it('never offers a draft or a pre-release', () => {
    expect(newerRelease({ ...RELEASE, draft: true }, '0.1.0')).toBeUndefined();
    expect(newerRelease({ ...RELEASE, prerelease: true }, '0.1.0')).toBeUndefined();
  });

  it('only links to the project’s own GitHub releases', () => {
    expect(newerRelease({ ...RELEASE, html_url: 'https://evil.example/x' }, '0.1.0')).toBe(
      undefined,
    );
  });

  it('treats an offline ward PC or a GitHub outage as "nothing to report"', async () => {
    const offline = () => Promise.reject(new Error('getaddrinfo ENOTFOUND api.github.com'));
    await expect(checkForUpdate('0.1.0', offline)).resolves.toBeUndefined();
    const outage = () => Promise.resolve(new Response('oops', { status: 503 }));
    await expect(checkForUpdate('0.1.0', outage)).resolves.toBeUndefined();
  });

  it('reads the latest release from the GitHub API', async () => {
    const fetchLatest = () => Promise.resolve(Response.json(RELEASE));
    await expect(checkForUpdate('0.1.0', fetchLatest)).resolves.toEqual({
      version: '0.2.0',
      url: RELEASE.html_url,
    });
  });
});
