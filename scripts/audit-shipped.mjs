// Fails when a high or critical advisory affects a package that ships in the app.
// `npm audit --omit=dev` audited only `dependencies`, but electron-vite bundles devDependencies into
// out/, so zod, react, the radix and tanstack packages and drizzle-orm shipped unaudited. Auditing
// the whole tree instead fails on build and test tools (concurrently, vite, electron-builder) that
// never reach a user. So: audit the full tree, then block only on what is in the shipped closure.
//
// "bundled" (scripts/shipped-packages.json) means the app imports it at runtime and electron-vite
// inlines it into out/, so it ships although it is a devDependency. "buildOnly" is everything else
// in apps/desktop devDependencies. tailwindcss is build-only: it generates CSS at build time, and
// the CSS `@import` is not a JS import, so the import cross-check skips it.
//
// The closure follows dependencies, installed optionalDependencies and non-optional peers, resolved
// through package-lock.json the way Node resolves. Optional peers are not followed: drizzle-orm
// declares dozens of optional database drivers, and on 2026-10-13 `gel` (an optional peer, not
// installed) dragged shell-quote into the shipped set for a build that never contained it.
//
// Test hooks: `--audit-json <file>` reads that file instead of running npm; `--config <file>`
// reads a different classification file.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const fail = (message) => {
  console.error(`::error::${message}`);
  process.exit(1);
};

const configPath = flag('--config') ?? join(root, 'scripts', 'shipped-packages.json');
const config = readJson(configPath);
const bundled = config.bundled ?? [];
const buildOnly = config.buildOnly ?? [];
const exceptions = config.exceptions ?? [];
const lock = readJson(join(root, 'package-lock.json'));
const packages = lock.packages ?? {};
const desktop = readJson(join(root, 'apps', 'desktop', 'package.json'));

// Classification self-check.
const devDeps = Object.keys(desktop.devDependencies ?? {});
for (const name of devDeps) {
  const count = Number(bundled.includes(name)) + Number(buildOnly.includes(name));
  if (count !== 1) {
    fail(
      `apps/desktop devDependency "${name}" is not classified in scripts/shipped-packages.json: put it in "bundled" if the app imports it at runtime (electron-vite bundles it into out/), or "buildOnly" if not.`,
    );
  }
}
for (const name of [...bundled, ...buildOnly]) {
  if (!devDeps.includes(name)) {
    fail(`scripts/shipped-packages.json lists "${name}", which apps/desktop no longer depends on`);
  }
}
for (const ex of exceptions) {
  if (typeof ex.reason !== 'string' || ex.reason.trim() === '') {
    fail(`the exception for ${ex.advisory} on ${ex.package} has no reason; say why it is safe.`);
  }
  const real =
    typeof ex.until === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(ex.until) &&
    new Date(`${ex.until}T00:00:00Z`).toISOString().slice(0, 10) === ex.until;
  if (!real) {
    fail(
      `the exception for ${ex.advisory} on ${ex.package} has "until" ${JSON.stringify(ex.until)}; use a real date written YYYY-MM-DD.`,
    );
  }
}

// Import cross-check: a build-only package imported by app code is in fact bundled.
const SKIP_FILE = /\.(test|test-support|run)\.tsx?$|\.test\.tsx$/;
const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return entry === 'test' ? [] : walk(full);
    return /\.tsx?$/.test(entry) && !SKIP_FILE.test(entry) ? [full] : [];
  });
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g;
for (const sub of ['main', 'preload', 'renderer', 'shared']) {
  const dir = join(root, 'apps', 'desktop', 'src', sub);
  for (const file of walk(dir)) {
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
      if (spec.startsWith('.') || spec.startsWith('node:') || spec.includes('?')) continue;
      const parts = spec.split('/');
      const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
      if (buildOnly.includes(name)) {
        fail(
          `${relative(root, file)} imports "${name}", which scripts/shipped-packages.json calls build-only; it is bundled into the app, so move it to "bundled".`,
        );
      }
    }
  }
}

// Shipped closure, resolved through the lockfile like Node.
const resolveFrom = (location, name) => {
  let base = location;
  for (;;) {
    const key = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    if (packages[key]) return key;
    if (base === '') return undefined;
    const cut = base.lastIndexOf('/node_modules/');
    base = cut >= 0 ? base.slice(0, cut) : '';
  }
};
const shipped = new Set();
const queue = [];
const visit = (key) => {
  if (!key || shipped.has(key)) return;
  shipped.add(key);
  const entry = packages[key];
  queue.push(entry.link && entry.resolved ? entry.resolved : key);
};
const desktopEntry = packages['apps/desktop'];
if (!desktopEntry) fail('package-lock.json has no apps/desktop entry.');
for (const name of [...Object.keys(desktopEntry.dependencies ?? {}), ...bundled]) {
  visit(resolveFrom('apps/desktop', name));
}
while (queue.length > 0) {
  const location = queue.pop();
  const entry = packages[location];
  if (!entry) continue;
  const optionalPeers = entry.peerDependenciesMeta ?? {};
  const names = [
    ...Object.keys(entry.dependencies ?? {}),
    ...Object.keys(entry.optionalDependencies ?? {}),
    ...Object.keys(entry.peerDependencies ?? {}).filter((n) => !optionalPeers[n]?.optional),
  ];
  for (const name of names) visit(resolveFrom(location, name));
}

// Audit.
let audit;
const auditFile = flag('--audit-json');
if (auditFile) {
  try {
    audit = readJson(auditFile);
  } catch {
    fail(
      `npm audit gave no usable answer (${auditFile} is not JSON); the shipped-dependency check could not run.`,
    );
  }
} else {
  const windows = process.platform === 'win32';
  // On Windows npm is a .cmd shim, which only runs through a shell.
  const run = spawnSync(windows ? 'npm.cmd' : 'npm', ['audit', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: windows,
  });
  try {
    audit = JSON.parse(run.stdout);
  } catch {
    audit = undefined;
  }
  if (!audit || typeof audit.vulnerabilities !== 'object' || audit.vulnerabilities === null) {
    fail(
      `npm audit gave no usable answer (${(run.stderr ?? '').slice(0, 200)}); the shipped-dependency check could not run.`,
    );
  }
}

const today = new Date().toISOString().slice(0, 10);
let blocked = false;
for (const [name, vuln] of Object.entries(audit.vulnerabilities)) {
  const nodes = vuln.nodes ?? [];
  const shippedNodes = nodes.filter((n) => shipped.has(n));
  for (const via of vuln.via ?? []) {
    if (typeof via !== 'object' || (via.severity !== 'high' && via.severity !== 'critical'))
      continue;
    const where = (shippedNodes.length > 0 ? shippedNodes : nodes).join(', ');
    if (shippedNodes.length === 0) {
      console.log(
        `::warning::${name} (${where}): ${via.title} ${via.url} — build or test tool only; not shipped.`,
      );
      continue;
    }
    const covering = exceptions.find(
      (ex) => ex.package === name && typeof via.url === 'string' && via.url.endsWith(ex.advisory),
    );
    if (covering && today <= covering.until) continue;
    blocked = true;
    if (covering) {
      console.error(
        `::error::the exception for ${covering.advisory} on ${name} expired on ${covering.until}; update the package or renew the exception with a fresh reason.`,
      );
      continue;
    }
    const version = packages[shippedNodes[0]]?.version ?? 'unknown';
    console.error(
      `::error::${name}@${version} (${where}): ${via.title} ${via.url} — it ships in the app, so this blocks the build. Update it, or add a dated exception with a reason to scripts/shipped-packages.json.`,
    );
  }
}
if (blocked) process.exit(1);
console.log(`shipped dependencies OK (${shipped.size} packages audited as shipped)`);
