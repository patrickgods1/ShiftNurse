---
name: new-entity
description: Thread a new ShiftNurse entity end to end — core domain interface, Drizzle table in packages/db, migration, repository functions, audit logging on every mutation, and demo seed coverage. Use when adding any new persisted concept (shift swap, open shift, pay rate, call-off, preference, etc.); this is the pattern milestones M2–M11 repeat most.
---

# Add an entity end to end

One entity touches five places. Do all five or the feature is half-built: the UI will show data
that is never persisted, or a mutation will land with no audit trail.

## Step 1 — The domain interface

Add the interface to `packages/core/src/domain/entities.ts`, in the section it belongs to (or a new
`// ---` section with a header comment).

Rules for every entity in this file, stated in its header:

- **Plain data only.** No methods, no getters, no class instances, no persistence concerns. The
  same shapes serialise cleanly across Electron IPC today and over HTTP when this becomes a web
  app, so they must stay JSON-serialisable: no `Date`, `Map`, `Set`, or functions on a field.
- Use the shared aliases: `Id` for identifiers, `IsoDate` (from `domain/time.ts`) for calendar
  dates, `Timestamp` (epoch millis) for real events such as "when this was submitted". Never use
  a `Timestamp` for schedule geometry or an `IsoDate` for an event instant.
- Doc-comment any field whose meaning is not obvious, especially units, inclusivity of ranges
  ("inclusive on both ends", see `TimeOffRequest`), and what `null` widens (see
  `ShiftCredentialRequirement`, where `null` means "applies to all").
- Model closed sets as string-literal union types (`TimeOffStatus`, `AuditAction`), not raw
  `string`.

**Request-type entities carry a submitter, a status and a decider.** This is the seam that lets
nurse self-service be added later with no data migration (ROADMAP.md, "Future: nurse self-service"):
v1 sets `enteredBy: 'manager'`, self-service sets `'nurse'` and reuses the identical approval
workflow, tables and validation. Copy the shape of `TimeOffRequest`:

```ts
export type ShiftSwapStatus = 'pending' | 'approved' | 'denied' | 'cancelled';

export interface ShiftSwap {
  id: Id;
  kind: 'trade' | 'giveaway';
  requestingNurseId: Id;
  counterpartyNurseId: Id;
  /** The assignment(s) moving. A giveaway has no return assignment. */
  offeredAssignmentId: Id;
  returnAssignmentId?: Id;
  status: ShiftSwapStatus;
  /** 'manager' in v1; 'nurse' once self-service ships. Never inferred at read time. */
  enteredBy: 'manager' | 'nurse';
  submittedAt: Timestamp;
  decidedAt?: Timestamp;
  decidedBy?: string;
  /** Required on denial or on an override — this text is quoted in a grievance. */
  decisionReason?: string;
}
```

Export it from `packages/core/src/index.ts` if that barrel re-exports the domain types.

## Step 2 — The Drizzle table

`packages/db` does not exist yet — milestone M2 builds it (`Drizzle schema for every entity in
core/domain/entities.ts`, migrations, WAL mode, DB owned by Electron main in `userData`,
repositories per aggregate, append-only `audit_log` writer, demo seed). So:

- **If `packages/db` exists, follow whatever pattern is already there** — read a sibling table
  definition, a sibling repository and the existing migration folder, and match them exactly
  rather than following any example written here.
- If it does not exist yet, stop after step 1 and say the persistence half is blocked on M2.

Expected shape once it exists: one table per entity mirroring the interface field for field, ids as
text, `IsoDate` fields as text (`YYYY-MM-DD`, so they sort lexicographically), `Timestamp` fields as
integers, unions as text with a check or a TS-side type. Foreign keys to `nurse`, `assignment`,
`schedule_period` as appropriate, plus indexes on the columns the repositories filter by (usually
`unitId`, `nurseId`, `date`/`periodId`, `status`). Keep the DB dialect-portable: Drizzle targets
Postgres when this becomes a web app, so avoid SQLite-only constructs.

## Step 3 — Generate a migration

Use the `packages/db` migration workflow already in place (a `drizzle-kit generate` script in that
workspace's `package.json`). Commit the generated SQL — never hand-edit an applied migration; add a
new one instead. Do not install packages or run `npm install` as part of this.

## Step 4 — Repository functions

Add them to the repository module for the owning aggregate (roster, schedule, time off, census,
cost, audit). Keep the surface narrow and shaped like the future HTTP API: list-by-parent, get-by-id,
create, update-status/decide, delete or cancel. Repositories return the **plain core interfaces**
from `domain/entities.ts`, mapping rows at the boundary — the rest of the app never sees a row type.
Nothing in `packages/core` may import from `packages/db`; the dependency runs one way only.

## Step 5 — Audit logging on every mutation

Every create, update, delete, approve, deny, publish, backfill or override writes an
`AuditLogEntry` (`domain/entities.ts`): `entityType`, `entityId`, `action` from the `AuditAction`
union, `actor`, `at`, and the `before`/`after` snapshots. The log is append-only and never
rewritten.

Denials and overrides must capture a reason — `AuditLogEntry.reason` is "the manager's stated
justification, quoted verbatim if this is ever grieved". A mutation path with no audit write is a
bug, not a follow-up.

## Step 6 — Extend the demo seed

Add the new entity to the demo seeder (M2: a 42-nurse unit, 6 months of history, census actuals,
pending requests). Seed enough rows that every UI state is reachable — for a request entity that
means pending, approved and denied examples, including at least one denial with a
`decisionReason`. Reuse the builders in `packages/core/src/testing/fixtures.ts` where they fit;
they are kept in `src` precisely so the seeder and the tests share shapes.

## Verify

- `npm run check` at the repo root (lint + typecheck + tests).
- `npm run seed:demo` produces a queryable database containing the new rows.
- Confirm `packages/core` still imports nothing from Electron, Drizzle or `better-sqlite3`.
- Tick the relevant milestone checkbox in `ROADMAP.md` only when the whole thread is done.
