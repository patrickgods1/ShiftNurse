# Architecture

This document explains *why* ShiftNurse is built the way it is: the stack choices, the
trade-offs weighed against them, and the invariants that keep the design intact as the app
grows. For the practical "how do I run/build/ship it" guide, see [README.md](README.md). For
the day-to-day conventions and file-by-file map, see [CLAUDE.md](CLAUDE.md).

## The shape of the problem

ShiftNurse solves a constraint problem (build a legal, fair, affordable nurse schedule) and
then has to live with that schedule for weeks: managers edit it by hand, staff call off,
shifts get traded, and every one of those changes has to be re-checked against the same
rules that produced the schedule in the first place. That's the core design pressure —
the rule engine, solver, and reporting all have to reason about the *same* domain model,
consistently, whether they're generating a schedule from scratch or re-validating one manual
edit. A design that let the solver and the live-editing grid drift apart would let the two
disagree about what "legal" means, which in this domain surfaces as a real grievance, not a
bug report.

## Why Electron + a pure TypeScript core

**The domain logic (`packages/core`) is a dependency-free TypeScript package: no Electron, no
database, no filesystem I/O.** Rules, the solver, acuity/forecasting, fairness scoring, cost
pricing, conflict detection and resolution, exchange evaluation, and publish/compliance logic
all live here as pure functions over plain data.

Why this matters:

- **v1 targets a local desktop app** (Windows 11 + macOS, offline, one unit's data on one
  machine) because that's the actual deployment the first real unit needs — no server to
  operate, no network dependency, works on a nurses' station with unreliable connectivity.
  Electron gets a single TypeScript/React codebase to both platforms without maintaining
  separate native UIs.
- **The stated intent is "architected to become a product,"** which in practice means a
  future web/mobile version with a real backend and nurse self-service logins. If the
  scheduling logic were entangled with Electron IPC or direct SQLite calls, that migration
  would be a rewrite. Because `packages/core` only ever takes data in and returns data out,
  moving it behind an HTTP API later is a *re-host*: the same rule engine and solver become
  the server engine unchanged. This is the single biggest architectural bet in the codebase,
  and it's enforced as a hard boundary (see below), not a convention people are trusted to
  remember.
- **A pure TypeScript solver first, OR-Tools second.** v1 shipped only a hand-written
  greedy-seed + simulated-annealing solver, to avoid shipping a second runtime inside an
  Electron installer. M15 revisited that: a hybrid that lets Google OR-Tools' CP-SAT
  re-optimise a few days at a time beat the annealer on the demo and a 24-nurse unit
  ([docs/solver-bench.md](docs/solver-bench.md)), so OR-Tools now ships — but as a small
  native **C++** runner, not a Python process (see [Why a C++ sidecar](#why-a-c-sidecar-for-or-tools)).
  The annealer stays pure TypeScript and is always available, so a missing or broken runner
  degrades Generate to SA + LNS rather than breaking it.

### The boundary rule

`packages/core` imports nothing from Electron and nothing from the database: no `electron`,
no `better-sqlite3`, no `drizzle-orm`, no `fs`, no `node:*` I/O. If a core module needs data
it takes it as an argument; if it needs to persist something it returns a value and lets the
caller persist it. Entities are plain data with no methods and no persistence concerns.

The same layering continues upward: the SQLite database is owned exclusively by the Electron
**main** process (`packages/db`); the **renderer** never imports `@shiftnurse/db` and never
opens a database connection. It reaches data through a typed IPC surface
(`apps/desktop/src/shared/api.ts`) that is deliberately shaped like the HTTP API this app
will eventually have — same request/response shapes, just carried over `ipcRenderer.invoke`
instead of `fetch`. Adding an IPC method means adding it to that shared contract first; a
missing implementation in `main/api.ts` is then a type error, not a runtime "no handler"
surprise.

```
┌─────────────────────────────┐
│  apps/desktop (Electron)    │
│                              │
│  renderer (React) ─IPC──►main─┐
│                              │ │
│                              │ ▼
│                              │  packages/db (Drizzle + better-sqlite3)
│                              │       │
│                              └───────┼──► packages/core (pure TS domain)
│                                      │        rules · solver · acuity ·
│                                      │        fairness · cost · conflicts
└─────────────────────────────┘
```

## Why SQLite (via Drizzle + better-sqlite3), not a client-server database

The app runs on one machine with one unit's data — there's no multi-tenant or
multi-writer requirement to justify a database server. SQLite gives a single-file,
zero-install, transactional database that ships inside the Electron app with no separate
process to manage, back up, or fail independently.

- **`better-sqlite3` is synchronous.** Scheduling operations (publish a period, resolve a
  conflict, apply a replacement) are short, transactional, and need to compose — publishing a
  schedule writes assignments, a period status, a fairness ledger, and audit entries in one
  `transact()`, and a partial publish is worse than a failed one. A synchronous driver makes
  that composition trivial; an async driver would need the same guarantees built on top of
  promises and rollback bookkeeping for no benefit, since nothing in this app is waiting on
  network I/O at the database layer.
- **Drizzle** gives a typed schema and query builder without an ORM's runtime magic or a
  separate migration DSL to learn — the 30-table schema, migrations, and repositories are all
  plain TypeScript, and `drizzle-kit generate` produces the SQL migrations that ship with the
  installer.
- **Trade-off accepted:** SQLite means no built-in replication or concurrent multi-writer
  access. That's fine for "one manager, one machine, one unit" in v1, and is exactly the
  piece that changes (to a server-side Postgres or similar, behind the same repository
  functions' shapes) if/when this becomes a hosted multi-user product — another payoff of
  keeping `packages/db` behind repository functions rather than scattering raw queries
  through the app.
- **Two builds of the same native module, on purpose.** Tests and the seeder run under system
  Node; the packaged app runs under Electron's own Node ABI. Rather than force one binary to
  serve both (which breaks one of the two), the repo keeps a hoisted `better-sqlite3` for
  Node and installs `better-sqlite3-electron` (an npm alias of the same package) for
  `apps/desktop`, swapped to the Electron-ABI prebuild by a postinstall script. Packaging
  disables electron-builder's own native-rebuild step for the same reason — its default
  would recompile the hoisted (test-facing) copy for Electron and quietly break `npm test`.

## Why the wall-clock time model

Nurse contracts are written in wall-clock time — "at least 10 hours between shifts," "no more
than 4 consecutive 12-hour shifts" — not in absolute instants. Modelling shifts as UTC
timestamps would make one night shift 11 hours and another 13 across the twice-yearly DST
transition, and every rest/consecutive-hours calculation would silently drift by an hour for
one day a year. Instead the schedule lives on a continuous local wall-clock timeline (minute
0 = midnight beginning 1970-01-01 local, every day exactly 1440 minutes), a shift's duration
comes from its declared `durationHours` rather than subtracting timestamps, and calendar math
goes through `Date.UTC` so it never depends on the host's local timezone. Real instants
(audit timestamps, when a call-off was phoned in) intentionally use a separate `Timestamp`
type so the two notions of "time" can never be mixed by accident. See the header of
`packages/core/src/domain/time.ts` for the full rationale — this is called out here because
it's the single easiest invariant in the codebase to violate without realizing it, and the
bug it produces (an off-by-one-hour rest calculation one day a year) is exactly the kind of
silent-but-wrong result this whole architecture is trying to avoid.

## Why a deterministic, budget-bounded solver

The solver (`packages/core/src/solver/`) is a greedy seed followed by simulated-annealing
moves, seeded from a hash of the period id and stopped by an iteration budget rather than a
wall-clock timer (the wall-clock limit exists only as a safety valve). This makes
"regenerate unchanged inputs → identical schedule" a property the smoke test can actually
assert, which matters for trust: a manager who reruns the generator on the same period
without changing anything should get the same answer, not a different-but-also-valid one.
Hard rules are evaluated incrementally on a per-nurse or per-shift view (never the whole
schedule) so the solver stays fast enough to run interactively; each rule declares its
`scope` precisely so a rule that secretly reads outside its scope fails loudly (passes in the
solver, fails on the grid) instead of silently producing a different answer in each context.

## Why three solvers, and why the hybrid is the default

The published nurse-rostering results (INRC-I/II) put exact methods — branch-and-price,
mixed-integer programming — at the top and large-neighbourhood simulated annealing close
behind, with CP-SAT strong on the Boolean-heavy rules (rest, consecutive days, overlap). What
matters here is how each does on *this* problem at *this* size, so M15 built three behind the
same `Solver` seam and measured them (`npm run bench:solvers`); citations for all of this are
in [README.md › Credits and references](README.md#credits-and-references):

- **SA + LNS** (pure TS): annealing with ruin-and-recreate and the two-nurse block swaps from
  Ceschia, Guido & Schaerf (2020). Fast, always available, no optimality bound.
- **CP-SAT** over the whole period: correct, and it reports a bound — but its linear relaxation
  is weak for this objective, and on the demo unit it left 14–17 floors short where the
  annealer left 0–1. Its fast parallel portfolio is not deterministic; the deterministic
  interleaved mode is slower still. Kept for small units and for a proven bound.
- **Hybrid** (default): anneal in eight chunks, and between them hand the worst three days to
  CP-SAT with every other shift fixed. A window is a few hundred variables, solved to
  optimality in well under a second, and it is exactly where annealing is weakest — a knot of
  rest rules across adjacent days that no single move can untie. Best median objective on the
  demo and a 24-nurse unit; about 3× the annealer's run time.

Two properties hold for every backend. **One judge**: CP-SAT's model is a second statement of
the rules, so its answers go back through `SolverModel.canAdd` — the same gate every annealer
move passes — and the report comes from the same `evaluateSchedule`/`scoreFairness`/
`costSchedule`; a disagreement fails loudly instead of reaching the grid. A guard test fails if
any registered rule has no CP-SAT encoding. **Determinism**: CP-SAT is seeded from the period,
bounded by deterministic time and run in `interleave_search` mode, so every backend regenerates
the identical schedule from unchanged inputs.

## Why a C++ sidecar for OR-Tools

OR-Tools has no JavaScript bindings. The options were a Python process (the `ortools` wheel
frozen with PyInstaller — 100 MB+ per platform, slow start-up, a second language runtime) or a
small C++ program linked against the official OR-Tools C++ release. The C++ runner is ~200
lines, starts in a fraction of a second, bundles only the OR-Tools libraries it loads (~50 MB
unpacked), and speaks JSON lines whose schema imports OR-Tools' own `CpModelProto`, so a
request is parsed straight into the real protobuf with exact int64 handling. CI builds it for
every target and publishes it as a pinned release; the desktop build downloads it by tag and
SHA-256 — nobody building the app needs a C++ toolchain.

It runs as a subprocess of the solver *worker thread*, never of `packages/core` (which still
starts no processes) and never on the main thread (encoding a large unit takes long enough to
stall IPC). Core provides the pure halves — build the model, read the answer — and the desktop
runs the one impure step in between.

## Why React 18 + TanStack Router/Query + Radix + Tailwind

The renderer is a fairly ordinary modern React SPA: TanStack Router for code-based, hash-history
routing (no server to serve arbitrary paths from, since this is a `file://`-adjacent Electron
renderer), TanStack Query to manage IPC calls as cache-invalidated queries/mutations rather
than hand-rolled loading state, Radix for accessible unstyled primitives (dialogs, dropdowns,
tooltips), and Tailwind v4 tokens for styling. None of this is scheduling-specific; it was
chosen to keep the UI layer conventional and replaceable, since the interesting, hard-to-get-right
logic is deliberately concentrated in `packages/core`, not the UI.

## Why Biome instead of ESLint + Prettier

One tool, one config, for both formatting and linting, with `noExplicitAny`,
`noUnusedVariables`, and `noUnusedImports` as errors. This is a project-size and
maintenance-burden call, not a scheduling-domain one: fewer moving parts in the toolchain, no
Prettier/ESLint rule conflicts to reconcile. One deliberate deviation: `noNonNullAssertion`
is disabled, because Biome's autofix for it rewrites `arr[0]!` to `arr[0]?.`, which silently
changes semantics from "this index cannot be undefined" to "skip the rest of the expression
if it is" — a live bug generator with `noUncheckedIndexedAccess` on, which this codebase
also enables deliberately (to force every array/index access to confront `T | undefined`
rather than assume it away).

## Why npm workspaces, not pnpm

Purely a machine/tooling constraint stated up front in the project's locked-in decisions:
pnpm isn't installed on the development machine, and npm workspaces are the safer pairing
with Electron's native-module rebuild story. Not a technical argument against pnpm in
general — just not worth introducing a second package manager's lockfile for this project.

## Packaging trade-offs

`electron-builder` produces the installers (`dmg` for macOS x64+arm64, `nsis` for Windows
x64), but its default behavior of rebuilding native modules for Electron's ABI as part of
packaging is disabled (`npmRebuild: false`) because that rebuild targets the *hoisted*
`better-sqlite3` — the one `npm test` and the seeder depend on being built for system Node.
Instead, `before-pack.mjs` fetches the correct prebuilt binary per **target** platform/arch
(so a Windows installer built on a Mac doesn't accidentally carry a macOS binary), and
`dist.mjs` restores the host binary afterward regardless of outcome. Electron is pinned to an
exact version rather than a range because electron-builder requires that. The same hook
fetches the CP-SAT runner for each target from its pinned GitHub release — the installer
carries a native binary it did not compile, which is why the fetch checks a SHA-256 pinned in
the repo. Installers are
unsigned for now — accepted as a v1 trade-off (Gatekeeper/SmartScreen warnings) with signing
deferred rather than blocking the first real-world usage on it.

## What this architecture optimizes for, and what it gives up

**Optimized for:**
- Correctness of scheduling logic staying provable and testable in isolation (pure core,
  no mocking Electron or a database to test a rule).
- A straight-line path to a hosted, multi-user version later without rewriting the domain
  logic — only the persistence and transport layers change.
- A manager being able to trust a regenerated schedule (determinism) and trust that a manual
  edit is validated against the exact rules the schedule was published under (`ruleSetId`
  snapshots, never "latest").

**Given up, deliberately, for v1:**
- Multi-user concurrent editing (SQLite, single machine) — acceptable because v1 is
  explicitly manager-only, one unit, one machine.
- A pure-TypeScript-only app — given up in M15 for the hybrid solver's better schedules. The
  cost is a native runner per platform (and ~20 MB compressed per installer), a second
  statement of every rule in the CP-SAT encoding (guarded by tests against the rule engine),
  and a hybrid Generate that takes ~3× as long as the annealer's.
- Code-signed installers — acceptable to defer past first real usage; revisit before wider
  distribution.

## Further reading

- [README.md › Credits and references](README.md#credits-and-references) — OR-Tools and CP-SAT
  (with the citations their authors ask for), the libraries the runner bundles, and the
  papers the solver design draws on.

- [ROADMAP.md](ROADMAP.md) — the plan of record: milestones, locked-in decisions, and the
  verification steps each one was actually checked against.
- [CLAUDE.md](CLAUDE.md) — conventions, invariants, and the file-by-file map of what exists
  and why, kept current as the source of truth for anyone (human or AI) working in this repo.
- `.claude/skills/scheduling-review/` — the domain-specific review checklist applied to any
  change touching rules, the solver, fairness, or time math.
