import { describe, expect, it } from 'vitest';
import { checkForUpdate, compareVersions, newerRelease, updateCheckSkipReason } from './updates.js';

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

  it('tells someone on a release candidate that the final release is out', () => {
    const final = {
      ...RELEASE,
      tag_name: 'v1.0.0',
      html_url: 'https://github.com/patrickgods1/ShiftNurse/releases/tag/v1.0.0',
    };
    expect(newerRelease(final, '1.0.0-rc.1')).toEqual({ version: '1.0.0', url: final.html_url });
  });

  it('orders release candidates by number, not as text', () => {
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta.1', '1.0.0-rc.1')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0+build.5')).toBe(0);
  });

  it('does not offer a release candidate to someone on the final release', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
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

describe('when the launch update check runs', () => {
  const installed = { isPackaged: true, smoke: false, env: {}, macDisableUpdateCheck: false };

  it('checks in an installed copy by default', () => {
    expect(updateCheckSkipReason(installed)).toBeUndefined();
  });

  it('lets IT turn the check off with SHIFTNURSE_UPDATE_CHECK=off', () => {
    for (const value of ['off', ' OFF ', '0', 'false', 'no']) {
      expect(updateCheckSkipReason({ ...installed, env: { SHIFTNURSE_UPDATE_CHECK: value } })).toBe(
        'environment',
      );
    }
  });

  it('keeps checking when the variable says anything else', () => {
    for (const value of ['on', '1', '']) {
      expect(
        updateCheckSkipReason({ ...installed, env: { SHIFTNURSE_UPDATE_CHECK: value } }),
      ).toBeUndefined();
    }
  });

  it('honours the DisableUpdateCheck managed preference on a Mac', () => {
    expect(updateCheckSkipReason({ ...installed, macDisableUpdateCheck: true })).toBe(
      'managed-preference',
    );
  });

  it('never checks in development or a smoke run', () => {
    expect(updateCheckSkipReason({ ...installed, isPackaged: false })).toBe('development');
    expect(
      updateCheckSkipReason({
        ...installed,
        smoke: true,
        env: { SHIFTNURSE_UPDATE_CHECK: 'off' },
      }),
    ).toBe('smoke');
  });
});
