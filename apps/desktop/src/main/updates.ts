/**
 * "A new version is available."
 *
 * Builds are unsigned, so they cannot update themselves (macOS refuses to swap in an unsigned
 * bundle). What the app can do is say a release exists: without that, a crash-on-launch fix
 * reaches nobody who has already installed. Once at launch, main asks GitHub for the latest
 * published release and the renderer shows a banner linking to its page; the manager installs
 * it like the first one. Failure of any kind — offline, a proxy, rate limiting — is silence:
 * a hospital network blocking GitHub is not the manager's problem to read about. A release
 * candidate hears about its final release.
 */

import type { UpdateInfo } from '../shared/api.js';

const LATEST_RELEASE = 'https://api.github.com/repos/patrickgods1/ShiftNurse/releases/latest';
const RELEASES_PAGE = 'https://github.com/patrickgods1/ShiftNurse/releases/';
const TIMEOUT_MS = 10_000;

interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

function split(version: string): { numbers: number[]; pre: string[] } {
  const [core = '', ...rest] = version.replace(/^v/, '').split('+')[0]!.split('-');
  return {
    numbers: core
      .split('.')
      .slice(0, 3)
      .map((p) => Number.parseInt(p, 10) || 0),
    pre: rest.length ? rest.join('-').split('.') : [],
  };
}

/** Semver §11: numeric identifiers as numbers, the rest as text, numbers below text. */
function comparePre(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const [x, y] = [a[i]!, b[i]!];
    const [xn, yn] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y);
    } else if (xn !== yn) return xn ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/** Negative, zero or positive as `a` is before, the same as or after `b`. */
export function compareVersions(a: string, b: string): number {
  const [pa, pb] = [split(a), split(b)];
  for (let i = 0; i < 3; i++) {
    const diff = (pa.numbers[i] ?? 0) - (pb.numbers[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // A release candidate comes before the release it is a candidate for.
  if (pa.pre.length === 0 || pb.pre.length === 0) return pb.pre.length - pa.pre.length;
  return comparePre(pa.pre, pb.pre);
}

/** The release, when it is published, newer than `current`, and on the project's own page. */
export function newerRelease(release: GitHubRelease, current: string): UpdateInfo | undefined {
  const { tag_name: tag, html_url: url, draft, prerelease } = release;
  if (typeof tag !== 'string' || typeof url !== 'string') return undefined;
  if (draft === true || prerelease === true) return undefined;
  // The link opens in the system browser; only ever send the manager to the project's page.
  if (!url.startsWith(RELEASES_PAGE)) return undefined;
  if (compareVersions(tag, current) <= 0) return undefined;
  return { version: tag.replace(/^v/, ''), url };
}

export async function checkForUpdate(
  current: string,
  fetchLatest: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<UpdateInfo | undefined> {
  try {
    const response = await fetchLatest(LATEST_RELEASE, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ShiftNurse' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    return newerRelease((await response.json()) as GitHubRelease, current);
  } catch {
    return undefined;
  }
}
