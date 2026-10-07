# packages/db

> Loaded automatically when Claude works on files under this folder. Cross-cutting rules live in the root `CLAUDE.md`. Demo and scenario data: `src/seed/CLAUDE.md`.

## What is here

- `packages/db` (M2, complete): 49-table Drizzle schema, generated migrations, `client.ts`
  (WAL, foreign keys ON, `transact`), `audit.ts`, `mappers.ts`, and repositories under
  `repositories/` — `roster`, `config` (unit, shift types, coverage, holidays, credential
  requirements), `acuity` (tiers, ratios, HPPD), `rulesets`, `schedule`, `timeoff`, `calloffs`,
  `pay` (rates, differentials, overtime, budget), `ledger`, `incompatibility` (groups of nurses
  kept apart, migration 0011), shared `patch` (`patchOf`) and `bulk`
  (`insertRows`), `publish` (M12:
  `publishSchedule` writes a `schedule_version` + status + ledger; `requireChangeReason` /
  `recordScheduleChange` are the post-publish change log; M15: `solver` (the per-unit
  `solver_settings`) and `solve-input` (`loadPeriodInput`, the one definition of a period's
  `SolveInput`, shared by Generate, conflicts, cost and the solver benchmark)).

## Conventions

- **Pay settings carry `holidayPayCoversOvertime` (migration 0036, nullable, null reads false).**
  `paySettingsSaved` says whether a unit has a row at all: `applyJurisdiction` offers the preset's
  pay settings (and a wider weekend) only to a unit that saved none, since a saved row may follow a
  contract the preset cannot see.

- **`better-sqlite3` is synchronous.** No `async`/`await`/`Promise` in `packages/db`.
- **Repository patches go through `patchOf` with a `PatchKeys<Patch>` allow-list**
  (`db/src/repositories/patch.ts`). IPC payloads are typed, not checked, so spreading a patch
  into a row once let `{ unitId }` move a nurse between units and `{ date }` move a locked
  shift. An unknown key throws. An assignment's date, shift and nurse change only by a move;
  `AssignmentPatch` carries flags and notes, and IPC creates are always `source: 'manual'`.
- **Moving a shift is delete + create in one `transact`.** `nurseId` is immutable on an
  assignment; the move carries `isCharge`/`isOvertime`/`notes` across and refuses locked rows.
- **`call_off` carries the shift (period/nurse/shift type/date) and no FK on `assignmentId`.** A
  backfill deletes the absent nurse's row and writes a `source: 'callout'` one, so the call-off and
  its call log must outlive the id they point at — the same reason `shift_swap` has no assignment
  FK. Migration 0005 rebuilds `call_attempt` before dropping `call_off`: the drizzle migrator runs a
  file inside one transaction, where `PRAGMA foreign_keys=OFF` is a no-op and a parent drop
  cascades into its children.
- **The ledger's `periodId` has no foreign key on purpose:** imported history uses synthetic
  `import:<start>` ids for pay periods that predate the app.
- **A published period is editable, with a reason.** Only `archived` is read-only. Every
  schedule mutation takes an optional `reason`; `requireChangeReason` throws on a published
  period without one and `editSchedule` in main writes each touched shift to `schedule_change`.
  A republish needs a reason and refuses an unchanged schedule. The diff is keyed on
  nurse/date/shift, never row ids, so a regenerate that lands the same shifts is "no change".
- **A nurse's record leaves the app without HR or medical matters.** The grievance export
  (`repositories/nurse-record.ts`, Roster › nurse › Export record…) carries every audit entry
  about a nurse — time, action, actor, reason, never the before/after snapshots — and their
  published-shift changes, but `RECORD_EXCLUDED_ENTITIES` keeps kept-apart groups, FMLA
  certifications and accommodations (`availability_block`) out, and every record's footer says so whether or not the nurse has either.
- **A holdover is recorded on a published shift, never a draft.** `recordHoldover`
  (`repositories/holdovers.ts`, migration 0029: `assignment.holdover_minutes`, default 0, and
  `holdover_mandated`) refuses drafts and standby, takes whole minutes 0–720 (0 clears, and a clear
  is never "required"), and audits with `before`; a required one goes through `recordAuditStrict`.
  `toAssignment` emits the fields only when minutes > 0, so an untouched row maps as before. Only a
  draft is generated, so the solvers never write over one.
