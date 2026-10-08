# apps/desktop

> Loaded automatically when Claude works on files under this folder. Cross-cutting rules live in the root `CLAUDE.md`. Before touching `main/solver-*.ts`, `ortools-solvers.ts` or `cpsat-*.ts`, read `packages/core/src/solver/CLAUDE.md`.

## What is here

- `apps/desktop` (M3, complete): electron-vite. `src/shared/api.ts` is the IPC contract
  (`ShiftNurseApi`, `API_CHANNELS`); `src/main/` opens the DB in `userData` (migrations only;
  first-run setup decides what goes in it), implements the contract in `api.ts` (the wiring table) over the domain
  modules in `api/` (`context` holds the shared loaders and `scheduleViewFor`; `schedule` holds
  `editSchedule`), registers it in `ipc.ts`;
  `src/preload/` builds `window.shiftnurse` from the same channel table; `src/renderer/` is
  React 18 + TanStack Router (hash history, code-based routes) + TanStack Query + Tailwind v4
  tokens. Dashboard, Roster (CRUD, credentials, preferences, CSV import/export via native
  dialogs in main), Settings (shift types, coverage floors, acuity tiers/ratios/HPPD,
  holidays) and Demand (census grid, forecaster proposals, derived demand with binding
  constraint, back-test) and Schedule (M6: nurses × days grid, native HTML5 drag-and-drop,
  lock/charge/OT popover, live violation badges from `schedule.validate`, Settings > Rules
  versioned editor incl. fairness weights) and Fairness (M7: unit distribution, per-nurse
  breakdown with trend sparklines, history CSV import) and Cost (M8: Settings > Pay editor for
  rates/differentials/OT rules, budget-vs-actual + overtime concentration on the Dashboard, a
  running cost strip on the Schedule page) and Generate (M9: `main/solver-worker.ts` runs core's
  `solve` in a worker thread; `main/solver-jobs.ts` runs a *batch* of 1–10 variations (seeds
  `seedFor(period) + k`, parallelism and time estimate from `main/solver-plan.ts`) and keeps each
  finished report in memory as a candidate — nothing reaches the draft until `solver.save`;
  `main/api/solver.ts` previews a candidate through the grid's own `validateView`/`costReportForView`
  and compares every candidate with the draft via core's `scoreAssignments`; the renderer's
  `useCurrentBatch` in `api-solver.ts` drives `schedule/generate-dialog.tsx`,
  `candidates-bar.tsx` (page, preview, save) and `compare-dialog.tsx`)
  and Requests (M10: `core/conflicts` — `detectConflicts`, `generateResolutions`,
  `analyseConflicts`, `selectAutoResolutions`, `timeOffImpact` over the same `SolveInput` the
  solver uses; `db/repositories/conflicts.ts` holds the per-unit auto-resolve policy and
  `applyResolution`, which audits before it writes; the Requests page has the queue, entry
  dialog, overlap heatmap, decide-with-impact dialog and ranked resolution cards, and Settings >
  Conflicts holds the auto-resolve policy, off by default) and Exchanges (M11: Requests ›
  Exchanges — proposal dialog with live verdict, decide dialog; `exchange.approve` re-evaluates
  in main and requires an override reason on `warn`) and Publish (M12: `main/api/schedule.ts`
  `editSchedule` wraps every grid mutation and logs reasoned edits on a published period;
  `main/backups.ts` (publish/daily/manual/restore; a deleted backup waits 30 days in a trash —
  `backup-files.ts` on disk, `backup-trash.ts` its audit rows, both Electron-free and tested), `main/output.ts` + `print-html.ts` +
  `xlsx.ts` for PDF/CSV/xlsx; Schedule › Publish dialog, change log, Export menu, reason dialog
  on published-period edits; Settings › Backups) and Today (M13: `core/dayof/` — `findReplacements`
  ranks same-role nurses simulated on the conflicts engine, `checkStaffing`/`shiftsAround` for the
  live census re-check; `dayOf` IPC in `main/api/dayof.ts`, `backfill` goes through `editSchedule` as
  `'backfill'`; `pages/today.tsx` + `api-dayof.ts`) are real.
  Renderer hooks: `api.ts` (roster), `api-config.ts` (configuration + rules), `api-demand.ts`
  (census/demand), `api-schedule.ts` (grid mutations + validation), `api-fairness.ts`
  (report/trend/import), `api-cost.ts` (pay config, cost report, budget).
- Packaging (M14, complete): `apps/desktop/electron-builder.yml` + `scripts/{before-pack,dist}.mjs`
  produce mac dmgs (x64 + arm64) and a Windows NSIS installer. Both are verified: the mac build
  via `smoke:packaged`, the Windows installer by installing and launching it on native Windows
  (and by the packaged smoke on `windows-2022` in CI).
- **First-run setup** (complete): an empty database opens on a welcome screen — demo, manual
  or assisted. `core/setup/` holds `state.ts` (`SETUP_STEPS`, `setupPhase`, the `SetupPreset`
  union), `presets.ts` (shift patterns, acuity presets by unit type, `coverageQuickFill`) and
  `holidays.ts` (`usFederalHolidays`); `db/repositories/setup.ts` persists the single-row
  `setup_state` (migration 0008) and applies presets through the ordinary audited creates;
  `main/api/setup.ts` is the `setup` IPC resource, and Start over is `resetDatabase` in
  `main/backups.ts`. Renderer: `setup/setup-gate.tsx` (in `RootLayout`), `welcome.tsx`,
  `assisted.tsx` + `assisted-steps.tsx` (each step embeds the real Settings editor), `steps.ts`;
  Settings › Unit (`pages/settings/unit.tsx`). The assisted guide has 12 steps, starting with
  "State and contract law"; `setup/preset-registry.ts` (`PresetRegistry` / `useRegisterPreset`,
  a no-op outside the guide) lets a step's starting point be applied by Continue without a
  dialog, and `UnitPoliciesForm` is exported from `pages/settings/unit.tsx` for the "Unit
  policies" step.

## Smoke tests

`npm run smoke -w @shiftnurse/desktop` / `npm run smoke:packaged -w @shiftnurse/desktop` build and boot the real app headlessly against a temp `userData`, assert the preload bridge and dashboard rendered, and exit non-zero otherwise. `--screenshot <png>` captures the window. Run this after touching main/preload/IPC — unit tests cannot see a wrong-ABI native module or a preload that never ran. With the CP-SAT runner installed it generates with every solver twice (minutes); `SHIFTNURSE_SMOKE_TIMEOUT_MS` raises the 240 s limit for an emulated x64 run. `npm run fetch:cpsat -w @shiftnurse/desktop` fetches the pinned CP-SAT runner for this machine into `apps/desktop/.cpsat/host` and fails loudly (postinstall only warns).

## Conventions

- **One better-sqlite3, for Node and Electron alike.** Since 13 it is a Node-API module: the
  package ships one prebuilt binary per platform (`prebuilds/<os>-<arch>.node`) that loads under
  the system Node (tests, seeder) and Electron's embedded Node unchanged, with no install-time
  download. `apps/desktop` depends on it directly and electron-vite leaves it external, so the
  bundled `@shiftnurse/db` and `drizzle-orm` load it from disk. (12.x needed a second, Electron-ABI
  copy behind an npm alias and a postinstall swap, and published no build for Electron 44's ABI.)
  An Electron bump no longer waits on a better-sqlite3 prebuild.
- **Packaging never rebuilds native modules.** `npmRebuild: false`: the prebuilds are already
  right for every target, and a rebuild would only compile for the build machine.
  `electron-builder.yml` ships only the target OS's better-sqlite3 prebuilds (`mac.files`,
  `win.files`), and `scripts/before-pack.mjs` fetches the CP-SAT runner for each *target*
  platform/arch (a Windows installer built on a Mac must not carry a darwin binary).
  Electron is pinned to an exact version (electron-builder refuses a range). Everything
  electron-vite bundles (`@shiftnurse/*`, react, radix, tanstack) is a **devDependency**;
  `dependencies` is exactly the set the packaged main process loads from disk. `npm run
  smoke:packaged` boots the built `.app`/`.exe` from `release/` in smoke mode — run it after any
  packaging change; the dev-binary smoke cannot see a missing migration or wrong-ABI binary.
- **The renderer never re-derives time maths.** `renderer/src/format.ts` splits ISO strings
  for display and calls core's `weekdayOf`/`dayNumber` for anything else. The first version
  computed weekday as `dayNumber % 7` and labelled Sunday 2026-09-20 "Wed" — day 0 of the
  epoch was a Thursday. Renderer unit tests live next to the code and run under `npm test`;
  component tests are `*.test.tsx` with `// @vitest-environment jsdom` and Testing Library
  (the grid's drag and drop uses a stand-in `DataTransfer`, which jsdom lacks).
- **`ELECTRON_RUN_AS_NODE` must be unset when launching Electron.** VS Code's integrated
  terminal exports it, and with it set the Electron binary is a bare Node runtime — the
  symptom is `'electron' does not provide an export named 'BrowserWindow'`. `scripts/smoke.mjs`
  strips it; for `npm run dev` in a VS Code terminal, `unset ELECTRON_RUN_AS_NODE` first.
- **The preload is CommonJS** (`out/preload/index.cjs`) because a sandboxed preload has no ESM
  loader. Everything else in the app is ESM.
- **`schedule.validate` judges a period by its own `ruleSetId` snapshot, never "latest".**
  A full pass over a 6-week, 42-nurse draft takes ~14ms in main, so the grid re-validates
  after every mutation via query invalidation rather than predicting violations client-side.
- **Only the app's own page may navigate or call IPC.** `main/trusted-origin.ts` is the
  policy: `will-navigate` is blocked for any other URL (a file dropped on the grid would
  otherwise load with the preload bridge), `ipc.ts` refuses untrusted sender frames, and
  `openExternal` takes only `https:`/`mailto:`.
- **Swapping two shifts is both moves in one `transact`** (`schedule.swapAssignments`): a refusal
  of either half — a lock, a nurse already on that shift — leaves both where they were.
- **The smoke test creates data through the raw bridge**, which bypasses the renderer's
  mutation hooks and their invalidation; it reloads the window before asserting on the grid.
  Do not read that as a cache bug in the app.
- **Adding an IPC method:** add it to `ShiftNurseApi` and `API_CHANNELS` in `shared/api.ts`,
  its argument schema to `shared/schemas/<resource>.ts`, and implement it in `main/api.ts`
  (logic in the matching `main/api/` module). Preload and renderer types follow; a missing
  implementation or schema is a type error, not a runtime "no handler". `ipc.ts` parses every
  call's arguments against `API_SCHEMAS` before the handler runs: object schemas are strict
  (`object` in `schemas/primitives.ts`), so an unknown key is refused rather than dropped, and a
  schema must never be stricter than what the renderer actually sends.
- **The packaged smoke test runs outside the repo and needs `[smoke] PASS`.** `scripts/smoke.mjs`
  copies the packaged app to a temp dir first and fails unless the app prints the marker. Inside
  the repo a module missing from the app is found in the repo's `node_modules`, and a startup
  crash dialog exits 0 when dismissed; v0.1.0's first draft crashed on every real install that
  way. Anything the packaged main process imports at runtime must be bundled (so the
  `better-sqlite3` alias applies — `drizzle-orm` is, for exactly that reason) or be a real
  `dependency`. `SHIFTNURSE_SMOKE_SOLVE_TIMEOUT_MS` / `SHIFTNURSE_SMOKE_TIMEOUT_MS` loosen its
  limits for slow CI runners.
- **Main never seeds the demo on its own.** `openAppDatabase` only migrates; the demo is loaded
  by the welcome screen through `setup.loadDemo` (the test scenarios through
  `setup.loadScenarios`, which main allows only under the electron-vite dev server), and all of
  them and `setup.createUnit` refuse once any unit exists. `setupPhase` treats units-but-no-`setup_state`-row as `ready`, so an install
  from before first-run setup never sees the welcome screen. Presets are idempotent — they only
  add what is missing (coverage quick-fill sets the floors it names) — so pressing one twice, or
  revisiting a step, never duplicates rows. The smoke run starts empty and clicks "Explore the
  demo" before any other check, then walks the guide once on the demo unit.
- **Forms that hold edits until Save register with `useUnsavedChanges`.** Settings tab switches
  await `useConfirmDiscard`, `NavigationGuard` guards routes and window unload, and main answers
  Electron's `will-prevent-unload` with a native dialog (skipped in a smoke run).
- **Backups use SQLite's online backup API**, never a file copy — a WAL database copied by
  hand loses un-checkpointed pages. The smoke run builds core/db from `dist`, so rebuild packages
  (`npm run build:packages`) after touching core before trusting a smoke result. Restore and
  start over swap the file through `replaceDatabaseFile` (staged copy, then rename), so a failed
  copy leaves the live database alone. The daily copy is due by the *local* date and re-checked
  hourly while the app runs.
- **An update never migrates the only copy.** `openAppDatabase` opens without migrating, reads
  `migrationStatus`, and when migrations are pending on a non-empty file takes a `pre-migrate`
  backup first (audited once the schema is current). A database migrated by a newer release is
  refused (`DatabaseNewerThanAppError`) — drizzle's migrator would otherwise find nothing to do
  and let this build's queries run against tables it has never seen.
- **Main starts or says why not.** `index.ts` takes the single-instance lock (a second copy would
  share the database, and a restore would replace the file under it), and a startup failure
  shows a native error box naming the database, backups and log paths before exiting. Main's
  console output is teed to `userData/logs/main.log` (`main/log.ts`, rolled at 5 MB), which
  Settings › About opens.
- **Errors reach the manager in words.** `ipc.ts` logs every failed call in full and re-throws
  `userFacingMessage(err)` (`main/ipc-errors.ts`: SQLite constraint errors reworded, the app's
  own messages unchanged); the preload strips Electron's `Error invoking remote method …`
  wrapper (`shared/ipc-error.ts`). Write refusals for people, since they reach the UI verbatim.
- **The app says when a release is out, but cannot update itself** (builds are unsigned).
  `main/updates.ts` asks GitHub's latest-release API once at launch in a packaged, non-smoke run;
  any failure is silence, and only a link to the project's own releases page is ever shown.
