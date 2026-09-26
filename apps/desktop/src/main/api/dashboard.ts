/** The Dashboard's one-call summary of a unit: drafts, requests, call-offs, credentials, today. */

import {
  addDays,
  type Id,
  type IsoDate,
  type SchedulePeriod,
  type ShiftType,
  today,
} from '@shiftnurse/core';
import {
  credentialsExpiringBetween,
  type DbLike,
  getCurrentDraft,
  listActiveNursesForUnit,
  listAssignmentsForDate,
  listCallOffsForUnit,
  listNursesForUnit,
  listPeriodsForUnit,
  listShiftTypesForUnit,
  listTimeOffForUnit,
} from '@shiftnurse/db';
import type { DashboardSummary, OnShiftView } from '../../shared/api.js';

import { unitOrThrow } from './context.js';

const CREDENTIAL_LOOKAHEAD_DAYS = 90;

function latestPublished(periods: SchedulePeriod[]): SchedulePeriod | undefined {
  return periods
    .filter((p) => p.status === 'published')
    .sort((a, b) => (a.startDate < b.startDate ? 1 : -1))[0];
}

function onShiftToday(db: DbLike, unitId: Id, date: IsoDate): OnShiftView[] {
  const nurses = new Map(listNursesForUnit(db, unitId).map((n) => [n.id, n]));
  const shiftTypes = listShiftTypesForUnit(db, unitId);
  const byShift = new Map<Id, OnShiftView>(
    shiftTypes.map((st: ShiftType) => [st.id, { shiftType: st, nurses: [] }]),
  );
  for (const a of listAssignmentsForDate(db, date)) {
    const view = byShift.get(a.shiftTypeId);
    const nurse = nurses.get(a.nurseId);
    if (view && nurse) view.nurses.push(nurse);
  }
  return [...byShift.values()].filter((v) => v.nurses.length > 0);
}

export function dashboardSummary(db: DbLike, unitId: Id): DashboardSummary {
  const unit = unitOrThrow(db, unitId);
  const now = today();
  const periods = listPeriodsForUnit(db, unitId);
  const unitNurseIds = new Set(listNursesForUnit(db, unitId).map((n) => n.id));

  return {
    unit,
    today: now,
    activeNurses: listActiveNursesForUnit(db, unitId).length,
    currentDraft: getCurrentDraft(db, unitId),
    latestPublished: latestPublished(periods),
    pendingTimeOff: listTimeOffForUnit(db, unitId, 'pending').length,
    openCallOffs: listCallOffsForUnit(db, unitId, { status: 'open' }).length,
    expiringCredentials: credentialsExpiringBetween(
      db,
      now,
      addDays(now, CREDENTIAL_LOOKAHEAD_DAYS),
    ).filter((e) => unitNurseIds.has(e.nurse.id)),
    todayOnShift: onShiftToday(db, unitId, now),
  };
}
