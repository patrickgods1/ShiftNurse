# packages/db

> Loaded automatically when Claude works on files under this folder. Cross-cutting rules live in the root `CLAUDE.md`. Demo and scenario data: `src/seed/CLAUDE.md`.

## What is here

- `packages/db` (M2, complete): 52-table Drizzle schema, generated migrations, `client.ts`
  (WAL, foreign keys ON, `transact`), `audit.ts`, `mappers.ts`, and repositories under
  `repositories/` — `roster`, `config` (unit, shift types, coverage, holidays, credential
  requirements), `acuity` (tiers, ratios, HPPD), `rulesets`, `schedule`, `timeoff`, `calloffs`,
  `pay` (rates, differentials, overtime, budget), `ledger`, `incompatibility` (groups of nurses
  kept apart, migration 0011), shared `patch` (`patchOf`) and `bulk`
  (`insertRows`), `publish` (M12:
  `publishSchedule` (takes `ShiftNurseTx`) writes a `schedule_version` + status + ledger; `requireChangeReason` /
  `recordScheduleChange` are the post-publish change log; M15: `solver` (the per-unit
  `solver_settings`) and `solve-input` (`loadPeriodInput`, the one definition of a period's
  `SolveInput`, shared by Generate, conflicts, cost, grid validation and the solver benchmark)).

## Conventions

- **`PublishInput.hardViolations` is the caller's in-transaction count of hard rule breaks.** Above zero `publishSchedule` refuses without a reason and records `{ count, codes }` in the strict `schedule_version` audit; omitted (seeds, repo callers) records nothing new.
- **Pay settings carry `holidayPayCoversOvertime` (migration 0036, nullable, null reads false)
  and `reportingPayNoticeHours` (migration 0037, nullable, null reads 2; saves refuse outside 0–24)
  and `overtimeWindowAttribution` (migration 0047, nullable, null reads `'clock'`; saves refuse
  other values). `unit.holiday_attribution` (same migration, null reads `'start'`) decides who
  `workedFromSchedules` lists as working a holiday.**
  `paySettingsSaved` says whether a unit has a row at all: `applyJurisdiction` offers the preset's
  pay settings (and a wider weekend) only to a unit that saved none, since a saved row may follow a
  contract the preset cannot see.

- **A published period is priced under the pay configuration it was first published with
  (`pay_config_snapshot`, migration `0048_pay_config_snapshot`):** differentials, overtime rules,
  pay settings, the unit's holiday attribution and nearby holiday dates. Drafts are priced live.
  `repricePeriod` takes a new snapshot with a strict reason. Pay rates are not snapshotted (they
  carry `effectiveFrom`). `backfillPayConfigSnapshots` covers periods published before the table
  existed.
- **Demand rules are kept as they were on each date (`demand_config_version`, migration
  `0050_demand_config_history`, append-only by trigger).** A version is the unit's active shift-type
  ids, acuity tiers, active ratio rules, coverage floors and ratio staffing, as canonical JSON
  (arrays by id); census and the HPPD target stay live. Every writer of those tables (`acuity.ts`,
  `config.ts`, so the presets, `applyJurisdiction` and the seeds too) calls
  `recordDemandConfigVersion` (`repositories/demand-history.ts`) after its write: it inserts only
  when the canonical JSON differs from the last version, audits it, and clears the unit's
  `demand_config_dirty` row. Triggers on those tables' demand columns fill that row, so a writer
  that forgets fails the table-driven tripwire in `demand-history.test.ts`, and
  `backfillDemandConfigVersions` (main's startup) records the missed version and a first version
  for a unit with none. A step of many writes (`applySetupPreset`, `applyJurisdiction`,
  `duplicateShiftType`, `fillCoverageWeek`, the demo and scenario seeds) runs in
  `batchDemandVersions`, which holds the calls back and records one version per touched unit when
  the outermost scope ends (nothing if it throws), so no partial version exists for a date before
  the first to fall back on. `demandConfigOn` reads the version in force at the end of a date (the
  earliest one before any). `demand-history.ts` imports no repository: `config.ts` and `acuity.ts`
  call it.
- **History is append-only in the file (migration `0049_history_is_append_only`):** `rule_set`,
  `rule_config`, `schedule_version`, `schedule_change` and `pay_config_snapshot` refuse UPDATE and
  DELETE, like `audit_log` (0013). They also abort FK cascades, so no unit or published period can
  be deleted. A migration that rebuilds or backfills one of them drops and re-creates its trigger.
- **Event writers (`reportCallOff`, `logCallAttempt`, `createTimeOffRequest`, `approveTimeOff`,
  `denyTimeOff`) take an optional `at` for past events: seeds and imports pass it, live paths never
  do. The audit row carries the same time. `localInstant` (`local-days.ts`) turns a local date and
  time into that instant.
- **Write the change, then its audit row; check a required reason first.** Audit-first only under
  `ShiftNurseTx`, where the whole call rolls back together (`audit.ts` header).
- **A raised ceiling, a lowered RN share, a moved role or tier, a rewritten citation and a
  deactivation of a ratio rule need a reason (`recordAuditStrict`); tightening does not.**
  `updateRatioRule` judges the edit with core's `protectedRatioChanges` and refuses in
  `describeRatioChanges`' words before writing (`auditedUpdate`'s `reasonRequired`/`reason`);
  `deactivateRatioRule` always takes one. `applyJurisdiction` only tightens, so passes none.
- **`better-sqlite3` is synchronous.** No `async`/`await`/`Promise` in `packages/db`.
- **Repository patches go through `patchOf` with a `PatchKeys<Patch>` allow-list**
  (`db/src/repositories/patch.ts`). IPC payloads are typed, not checked, so spreading a patch
  into a row once let `{ unitId }` move a nurse between units and `{ date }` move a locked
  shift. An unknown key throws. An assignment's date, shift and nurse change only by a move;
  `AssignmentPatch` carries flags and notes, and IPC creates are always `source: 'manual'`.
  `auditedUpdate` writes nothing for an empty patch and still audits it (the manager pressed Save).
- **Moving a shift is delete + create in one `transact`.** `nurseId` is immutable on an
  assignment; the move carries `isCharge`/`isOvertime`/`notes` across (`target.isCharge` overrides the
  carried flag; resolutions set it) and refuses locked rows
  and a shift with a recorded holdover (the minutes belong to that nurse and day; `approveSwap`
  refuses the same way).
  Every create (and so every move, cover, backfill, resolution and Generate save) refuses a date
  outside the period, a non-date, or another unit's shift type.
- **`call_off` carries the shift (period/nurse/shift type/date) and no FK on `assignmentId`.** A
  backfill deletes the absent nurse's row and writes a `source: 'callout'` one, so the call-off and
  its call log must outlive the id they point at — the same reason `shift_swap` has no assignment
  FK. Migration 0005 rebuilds `call_attempt` before dropping `call_off`: the drizzle migrator runs a
  file inside one transaction, where `PRAGMA foreign_keys=OFF` is a no-op and a parent drop
  cascades into its children. Sick hours are credited only once the shift is off the schedule and
  not back on it, and never for a cancelled call-off.
- **Mappers omit absent keys (`optKey`) and throw on a damaged JSON version or change-log row.**
- **Real instants against local days go through `local-days.ts`** (`instantWindow` +
  `onLocalDays`), never `dayNumber × MS_PER_DAY` alone.
- **The ledger's `periodId` has no foreign key on purpose:** imported history uses synthetic
  `import:<start>` ids for pay periods that predate the app. A historical re-import's audit row
  holds the replaced and written rows in full.
- **Every ledger row says how long its period was and how many days the nurse was there**
  (`fairness_ledger.period_days` / `available_days`, migration `0046_ledger_exposure`). The
  backfill took the length from the row's `schedule_period`, or the unit's `pay_period_days` for
  imported `import:` rows, and the availability from approved leave and the hire date (core's
  `daysAvailable`). A writer always sets both: `periodDays` is required, `availableDays` defaults
  to it, and `ledgerValues` refuses a zero-day period or more days there than the period has.
- **The host's clock changes come from `host-dst.ts`** (`dstTransitionsForPeriod`), the one
  local-`Date` use besides `today()`. `costContext` and `loadPeriodInput` attach them, so pay and
  the statutory hour caps count real minutes on DST nights (D19).
- **Hours worked are `workedShiftsForNurseInRange`** (`repositories/worked-hours.ts`): published
  or archived periods' shifts on any unit, at each shift type's own `durationHours`, standby
  excluded, and so is a shift whose call-off is open or uncovered (she did not work it). A draft
  is a proposal, not work. `listAssignmentsForNurseInRange` returns drafts too,
  for approve-and-lift; never sum hours worked from it.
- **The lookback tail is published and archived periods only** (`PRIOR_ASSIGNMENT_LOOKBACK_DAYS`).
  `historyFromFor` says how far that tail is complete; the contracted-hours rule judges a pay
  period that began before the period only from there.
- **`periodTailFor` is the one loader of a period's tail**, for `loadPeriodInput` and main's
  `scheduleViewFor` alike: the unit's own earlier shifts (real types), its published or archived
  shifts of another period dated inside this one, and other units' shifts (any status), the last
  two as core's `busyElsewhere` locked rows on inactive `elsewhere:` types. The unit's own earlier
  shifts that were floated off are swapped in place for core's `floatedOff` copies on inactive
  `floated:` types. Same-unit drafts stay out; nothing it returns is added to the period's own
  `assignments`.
- **A shift type used by a published or archived schedule keeps its timing** (`startTime`,
  `durationHours`, `isNight`, `isOnCall`, `withinShiftTypeId`): `updateShiftType` refuses those
  fields and the manager duplicates the type instead (`duplicateShiftType`). Published shifts are
  judged and priced from the live shift-type row (`schedule_version` stores only assignment rows).
  `shiftTypeHistoryCount` counts distinct periods, change-log rows included; repeating a current
  value is not a change. A duplicate copies the floors and credential requirements, moves census
  forecasts and repoints never-published mid shifts to the new type, adds a copy of each shift-type
  wish, and retires the old type; it leaves forecasts dated inside a published or archived period,
  mid shifts with published history of their own (named in `stillInsideOld`) and draft shifts
  (counted in `draftShiftsOnOld`) on the old one.
- **A published period is editable, with a reason.** Only `archived` is read-only. Every
  schedule mutation takes an optional `reason`; `requireChangeReason` throws on a published
  period without one and `editSchedule` in main writes each touched shift to `schedule_change`.
  A republish needs a reason and refuses an unchanged schedule. The diff is keyed on
  nurse/date/shift, never row ids, so a regenerate that lands the same shifts is "no change".
  Status changes only through `publishSchedule` and `archivePeriod` (published → archived, strict
  reason). There is no other publish path; the seeds publish history through `publishSchedule`,
  so every published period has a version.
  A publish that books a ledger books it whole: rows for nurses no longer on the period are
  deleted, audited with `before` (an omitted `ledger` touches nothing).
- **A nurse's record leaves the app without HR or medical matters.** The grievance export
  (`repositories/nurse-record.ts`, Roster › nurse › Export record…) carries every audit entry
  about a nurse — time, action, actor, reason, never the before/after snapshots — and their
  published-shift changes (entries are found by `nurseId`, `requestingNurseId`,
  `counterpartyNurseId`, `orienteeId`, `preceptorId` or a `nurseIds` array, so a snapshot about a
  nurse must carry one of them), but `RECORD_EXCLUDED_ENTITIES` keeps kept-apart groups, FMLA
  certifications and accommodations (`availability_block`) out, and every record's footer says so whether or not the nurse has either.
  Two tripwires guard this: `nurse-record.completeness.test.ts` fails when a new audited entity type is unclassified or when a new column points at a nurse under a key the record does not look for, and `nurse-record.entries.test.ts` fails when a nurse-scoped type's entry, written by its real repository function, does not reach the record.
- **Saved cancellation orders gain `"float"` after `"agency"`** (migration 0038, data only;
  after `"volunteer"` where there is no agency tier, else first). A float on the unit that day can
  be recorded as sent home: `recordShiftCancellation` checks `requireWorksOnUnit`.
- **`perNurseRecordsFor` is the one source of person-scoped records** (credentials, preferences,
  leave, sick pay, rest waivers, accommodations, per-nurse pay rates) for `loadPeriodInput`,
  `costContext` and alerts: each list is this unit's rows in today's order, then what the roster
  brings from other units appended, so a unit nobody floats to reads exactly as before. The
  `satisfies Record<keyof SolveInput, Scope>` test in `solve-input.test.ts` makes a new
  `SolveInput` field a compile error until it is classified person, recorded-here, unit or roster.
- **One membership predicate.** `nurseWorksOnUnit`/`requireWorksOnUnit` (`nurse-units.ts`): home
  unit, or a float membership covering the dates. Every validator that asks 'does this nurse work
  here' uses it. Accommodations stay on the home unit and apply everywhere.
- **A float works here only inside her membership dates.** `loadPeriodInput` fills
  `SolveInput.memberships` from `listFloatMemberships` (the same filter, window and order as
  `listFloatNurses`), which core's `works-within-membership` rule and both solvers read. Manual
  placement asks `requireWorksOnUnit` for the shift's start date in `placeableOrThrow`, so every
  `createAssignment` and `replaceAssignments` (echoed locked rows included: one outside the dates is
  fixed by hand) refuses a day outside them.
- **A floated shift stays (migration 0039, `assignment.floated_to`).** `markFloatedOff` locks and
  marks it, `updateAssignment` refuses to unlock it, and loaders turn it into busy time for
  judging (`splitFloatedOff`, `periodTailFor`): it never reaches `SolveInput.assignments`, and
  Generate keeps it as a locked row. Floats deleted before this change are not reconstructed.
- **The home unit is `unit.is_home`** (migration 0040; backfilled from the first-inserted unit; a
  partial unique index allows one). `getHomeUnit` is what the app opens; `listUnits` stays
  alphabetical for pickers.
- **A holdover is recorded on a published shift, never a draft.** `recordHoldover`
  (`repositories/holdovers.ts`, migration 0029: `assignment.holdover_minutes`, default 0, and
  `holdover_mandated`) refuses drafts and standby, takes whole minutes 0–720 (0 clears, and a clear
  is never "required"), refuses minutes that run into the nurse's own next worked shift on any unit
  (a holdover there is double-counted time), and audits with `before`; a required one goes through
  `recordAuditStrict`. Audited with the shift's `nurseId`, `date` and `shiftTypeId` so the nurse's
  record finds it.
  `toAssignment` emits the fields only when minutes > 0, so an untouched row maps as before. Only a
  draft is generated, so the solvers never write over one. The grid offers no Undo for removing a
  held-over shift.
- **Deactivating a nurse lifts her draft shifts from today on and is refused while she holds a
  published one** (`deactivation.ts`); archived periods are history.
- **A time-off request moves only along `TIME_OFF_TRANSITIONS`** (approve from pending or denied;
  deny and cancel from pending; withdraw from approved, strict reason); every writer checks it first.
- **Approve-and-lift reads from the day before the leave** and lifts (draft) or reports (published)
  the night dated then only if that period's own rule set has the time-off rule on with
  `nightShiftEndingOnLeaveCounts`, judged by core's `overlappingLeaveDate` (window, not `isNight`).
- **A coverage floor is unique per (unit, shift type, role, weekday) or per (..., date), with exactly
  one of weekday/date and min ≤ target.** The repository refuses in words; migration
  `0041_coverage_floor_keys` repaired older files, keeping the row core was reading (the highest
  rowid), and audited each change as actor `'upgrade'`.
- **Units carry `paperSize`** (migration `0045_unit_paper_size`, nullable; null follows the computer's
  region via the desktop's `main/paper.ts`).
- **A pay rate is unique per (nurse, start date) or per (role default, start date).** The
  repository refuses a second one in words; migration `0042_pay_rate_keys` kept the rate that was
  already pricing shifts (the lowest rowid). Every cost writer checks its numbers itself, because
  seeds and presets bypass IPC.
- **Validation triggers (migration `0043_validation_triggers`) backstop nurse
  role/employment/FTE/contract/dates, unit pay period, and period status/dates.**
  `nurse_keeps_history` refuses deleting a nurse with assignments, change-log or ledger rows. These
  are triggers because a CHECK needs a table rebuild; the update triggers fire only on the guarded
  columns (`BEFORE UPDATE OF`). `float_record.shift_type_id` no longer cascades (migration 0044).
- **Employee ids match case-insensitively (core `sameEmployeeId`).** A roster import updates the
  stored nurse whose id differs only by case (the stored spelling is kept), a case-twin is refused
  at create and update, and an import whose id matches two stored nurses is refused before any
  write. No `lower()` unique index: an existing file may already hold twins.
- **A period's ledger is `periodLedgerRows(view, counterContextFor(...))`** (`period-ledger.ts`):
  main's publish, the history importer and the demo seeds all book it there.
