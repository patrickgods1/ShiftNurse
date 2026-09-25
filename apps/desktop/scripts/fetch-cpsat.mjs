/**
 * Fetch the CP-SAT runner (native/cpsat-runner, built by .github/workflows/cpsat-runner.yml) for a
 * platform/arch and unpack it where the app looks for it.
 *
 * The desktop app never compiles C++: CI publishes one bundle per target — the runner plus the
 * OR-Tools shared libraries it loads — as a GitHub release, and this script downloads the one it
 * needs, pinned by release tag *and* SHA-256 so a replaced asset can never slip into a build.
 *
 * Two callers, two destinations, so packaging never clobbers the developer's own copy:
 *
 * - `postinstall` (no args) fetches the *host* bundle into `.cpsat/host`, which `npm run dev`,
 *   `npm run smoke` and the tests use. A failure there only warns: offline, the app still runs
 *   and Generate falls back to SA + LNS, saying so.
 * - `before-pack.mjs` calls `fetchCpsat({ platform, arch, dest: TARGET_DIR })` once per packaging
 *   target; `electron-builder.yml` ships `.cpsat/target` as `resources/cpsat`. A failure there
 *   fails the build — an installer without its runner would silently lose two solvers.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const HOST_DIR = join(DESKTOP_DIR, '.cpsat', 'host');
export const TARGET_DIR = join(DESKTOP_DIR, '.cpsat', 'target');
const CACHE_DIR = join(DESKTOP_DIR, '.cpsat', 'cache');

const REPO = 'patrickgods1/ShiftNurse';
export const RUNNER_TAG = 'cpsat-runner-v2';
/** From the release's SHA256SUMS; update together with RUNNER_TAG. */
const SHA256 = {
  'darwin-arm64': 'd6ba20e3e709979836f9118436934137c9fe68f14f6e29880df3f71c30122b18',
  'darwin-x64': '3ab0f3ad350b193a191a0bb9872cb46c34f5f62d4250f6f3b3201975fbfa6083',
  'win32-x64': '3f8fa2bfb13e96ca185f0376f502a19a2849fcc43436e53063556dbbbc172044',
};

export function runnerFileName(platform = process.platform) {
  return platform === 'win32' ? 'cpsat-runner.exe' : 'cpsat-runner';
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function fetchCpsat({
  platform = process.platform,
  arch = process.arch,
  dest = HOST_DIR,
} = {}) {
  const target = `${platform}-${arch}`;
  const expected = SHA256[target];
  if (!expected) throw new Error(`[fetch-cpsat] no CP-SAT runner is published for ${target}`);
  const asset = `cpsat-runner-${target}.tar.gz`;
  const cached = join(CACHE_DIR, RUNNER_TAG, asset);

  let bytes = existsSync(cached) ? readFileSync(cached) : undefined;
  if (!bytes || sha256(bytes) !== expected) {
    const url = `https://github.com/${REPO}/releases/download/${RUNNER_TAG}/${asset}`;
    console.log(`[fetch-cpsat] downloading ${url}`);
    bytes = await download(url);
    const actual = sha256(bytes);
    if (actual !== expected) {
      throw new Error(`[fetch-cpsat] ${asset} hash mismatch: expected ${expected}, got ${actual}`);
    }
    mkdirSync(dirname(cached), { recursive: true });
    writeFileSync(cached, bytes);
  }

  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  // bsdtar ships with macOS and Windows 10+, and GNU tar with Linux; all read .tar.gz. On
  // Windows, name System32's bsdtar explicitly: Git for Windows puts GNU tar on some PATHs, and
  // GNU tar reads `C:\...` as `host:path` — a remote archive — and fails.
  const result = spawnSync(tarCommand(), ['-xzf', cached, '-C', dest], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`[fetch-cpsat] could not unpack ${cached}`);
  const exe = join(dest, runnerFileName(platform));
  if (!existsSync(exe))
    throw new Error(`[fetch-cpsat] ${asset} has no ${runnerFileName(platform)}`);
  console.log(`[fetch-cpsat] ${target} runner (${RUNNER_TAG}) ready in ${dest}`);
  return exe;
}

/** The tar for the machine doing the extracting (not the build target). */
function tarCommand() {
  if (process.platform !== 'win32') return 'tar';
  const systemTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  return existsSync(systemTar) ? systemTar : 'tar';
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const strict = process.argv.includes('--strict');
  fetchCpsat().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    if (strict) {
      console.error(message);
      process.exit(1);
    }
    console.warn(
      `${message}\n[fetch-cpsat] continuing without the CP-SAT runner: Generate will ` +
        'fall back to SA + LNS until `npm run fetch:cpsat -w @shiftnurse/desktop` succeeds.',
    );
  });
}
