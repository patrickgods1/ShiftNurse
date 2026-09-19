/**
 * Conflicts: the unit's auto-resolve policy, and applying a resolution the manager (or the
 * policy) picked.
 *
 * Core's `generateResolutions` returns plain `ResolutionAction`s and writes nothing; this is
 * where they become rows. Every action a resolution carries lands in one call so a resolution
 * that moves one nurse and denies another's request can never half-apply — a moved shift with
 * the request still approved is a schedule nobody chose. The caller wraps this in `transact`,
 * as with every other multi-row write in this package.
 *
 * The audit entry is the point: a resolution — especially an *auto*-applied one — is a decision
 * that will be asked about ("why did Priya get that Saturday?"), so the entry quotes the
 * resolution's own description or the manager's stated reason, and `recordAuditStrict`
 * refuses to write one without either.
 */

import type { AutoResolvePolicy, Id, Resolution } from '@shiftnurse/core';
import { DEFAULT_AUTO_RESOLVE_POLICY } from '@shiftnurse/core';
import { and, eq } from 'drizzle-orm';
import { recordAudit, recordAuditStrict } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import { assignment, conflictPolicy } from '../schema.js';
import {
  createAssignment,
  deleteAssignment,
  getAssignment,
  getPeriod,
  moveAssignment,
} from './schedule.js';
import { denyTimeOff } from './timeoff.js';

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

function toPolicy(row: typeof conflictPolicy.$inferSelect): AutoResolvePolicy {
  return {
    enabled: row.enabled,
    maxCostDelta: row.maxCostDelta,
    maxFairnessDrop: row.maxFairnessDrop,
  };
}

/** A unit with no saved policy gets the default, which is off. */
export function getConflictPolicy(db: DbLike, unitId: Id): AutoResolvePolicy {
  const row = db.select().from(conflictPolicy).where(eq(conflictPolicy.unitId, unitId)).get();
  return row ? toPolicy(row) : { ...DEFAULT_AUTO_RESOLVE_POLICY };
}

export function saveConflictPolicy(
  db: DbLike,
  unitId: Id,
  policy: AutoResolvePolicy,
  actor: string,
): AutoResolvePolicy {
  if (!(policy.maxCostDelta >= 0) || !(policy.maxFairnessDrop >= 0)) {
    throw new Error('Auto-resolve thresholds must be zero or positive numbers');
  }
  const values = {
    enabled: policy.enabled,
    maxCostDelta: policy.maxCostDelta,
    maxFairnessDrop: policy.maxFairnessDrop,
  };
  const row = db.select().from(conflictPolicy).where(eq(conflictPolicy.unitId, unitId)).get();
  if (row) {
    const before = toPolicy(row);
    db.update(conflictPolicy).set(values).where(eq(conflictPolicy.id, row.id)).run();
    const after = toPolicy({ ...row, ...values });
    recordAudit(db, {
      entityType: 'conflict_policy',
      entityId: row.id,
      action: 'update',
      actor,
      before,
      after,
    });
    return after;
  }
  const id = ids.conflictPolicy();
  db.insert(conflictPolicy)
    .values({ id, unitId, ...values })
    .run();
  const after = toPolicy({ id, unitId, ...values });
  recordAudit(db, { entityType: 'conflict_policy', entityId: id, action: 'create', actor, after });
  return after;
}

// ---------------------------------------------------------------------------
// Applying a resolution
// ---------------------------------------------------------------------------

export interface ApplyResolutionOptions {
  /** True when the policy picked it; the audit action becomes `auto_resolve`. */
  auto: boolean;
  /** The manager's stated reason. Required for a manual apply; ignored for auto. */
  reason?: string;
}

export interface AppliedResolution {
  resolution: Resolution;
  auditId: Id;
}

/**
 * Persist every action of one resolution and one audit entry describing the decision. Refuses
 * on anything other than a draft — a published schedule changes through the post-publish
 * change log, not here — and refuses to double-book a nurse rather than letting the unique
 * index raise a bare SQL error halfway through the actions.
 */
export function applyResolution(
  db: DbLike,
  periodId: Id,
  resolution: Resolution,
  actor: string,
  opts: ApplyResolutionOptions,
): AppliedResolution {
  const period = getPeriod(db, periodId);
  if (!period) throw new Error(`Unknown period ${periodId}`);
  if (period.status !== 'draft') {
    throw new Error(
      `Period "${period.name}" is ${period.status}; a resolution can only be applied to a draft`,
    );
  }
  const reason = opts.auto ? resolution.description : opts.reason?.trim();
  // Audited before the writes: a manual apply with no reason must not touch a row.
  const auditId = recordAuditStrict(db, {
    entityType: 'conflict',
    entityId: resolution.conflictId,
    action: opts.auto ? 'auto_resolve' : 'resolve',
    actor,
    reason,
    after: {
      id: resolution.id,
      kind: resolution.kind,
      title: resolution.title,
      actions: resolution.actions,
      impact: resolution.impact,
      nurseIds: resolution.nurseIds,
    },
  });

  for (const action of resolution.actions) {
    switch (action.type) {
      case 'create_assignment': {
        const clash = db
          .select({ id: assignment.id })
          .from(assignment)
          .where(
            and(
              eq(assignment.nurseId, action.nurseId),
              eq(assignment.date, action.date),
              eq(assignment.shiftTypeId, action.shiftTypeId),
            ),
          )
          .get();
        if (clash) {
          throw new Error(
            `Nurse ${action.nurseId} already holds shift ${action.shiftTypeId} on ${action.date}; ` +
              'the resolution is stale — re-analyse the period',
          );
        }
        createAssignment(
          db,
          {
            periodId,
            nurseId: action.nurseId,
            shiftTypeId: action.shiftTypeId,
            date: action.date,
            source: 'resolution',
            isCharge: action.isCharge,
            isOvertime: action.isOvertime,
          },
          actor,
        );
        break;
      }
      case 'move_assignment': {
        const existing = getAssignment(db, action.assignmentId);
        if (!existing) {
          throw new Error(
            `Assignment ${action.assignmentId} no longer exists; the resolution is stale — re-analyse the period`,
          );
        }
        if (existing.periodId !== periodId) {
          throw new Error(`Assignment ${action.assignmentId} belongs to another period`);
        }
        moveAssignment(
          db,
          action.assignmentId,
          { nurseId: existing.nurseId, shiftTypeId: action.toShiftTypeId, date: action.toDate },
          actor,
          'resolution',
        );
        break;
      }
      case 'deny_time_off':
        // The resolution's own description is the denial reason the nurse will read: it names
        // the shift that could not otherwise be covered.
        denyTimeOff(db, action.timeOffId, actor, resolution.description);
        break;
      case 'delete_assignment': {
        const existing = getAssignment(db, action.assignmentId);
        if (!existing) {
          throw new Error(
            `Assignment ${action.assignmentId} no longer exists; the resolution is stale — re-analyse the period`,
          );
        }
        if (existing.periodId !== periodId) {
          throw new Error(`Assignment ${action.assignmentId} belongs to another period`);
        }
        // Approved leave outranks a lock, so a locked row is deleted here rather than refused.
        deleteAssignment(db, action.assignmentId, actor, resolution.description);
        break;
      }
      case 'accept_shortfall':
        // Nothing changes on the grid; the audit entry above *is* the decision on record.
        break;
    }
  }
  return { resolution, auditId };
}
