/**
 * The nurse detail drawer: summary, credential tracking and the preference editor. Lives
 * beside the roster table rather than behind its own route because a manager clicking through
 * fifty nurses in one sitting shouldn't wait on a route transition each time — it's state on
 * `roster.tsx`, not a page.
 */

import type { DeactivationImpact, FutureShiftView } from '@shared/api.js';
import type { Id, Nurse } from '@shiftnurse/core';
import { Link } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import {
  useDeactivateNurse,
  useDeactivationImpact,
  useIncompatibilityGroups,
  useNurse,
  useUpdateNurse,
} from '../../api.js';
import { AsyncState } from '../../components/async-state.js';
import { Modal } from '../../components/modal.js';
import { DANGER_SOLID, errorMessage, SECONDARY } from '../../components/ui.js';
import { usePanelFocus } from '../../components/use-panel-focus.js';
import { formatDate, formatDateWithWeekday } from '../../format.js';
import { CredentialsSection } from './nurse-credentials.js';
import { LeaveSection } from './nurse-leave.js';
import { PreferencesSection } from './nurse-preferences.js';
import { ExportRecordButton } from './nurse-record.js';
import { AlsoWorksOnSection } from './nurse-units.js';

interface NurseDetailProps {
  nurseId: Id;
  onClose: () => void;
  onEdit: (nurse: Nurse) => void;
}

export function NurseDetail({ nurseId, onClose, onEdit }: NurseDetailProps) {
  const nurseQuery = useNurse(nurseId);
  const panelRef = useRef<HTMLDivElement>(null);
  usePanelFocus(panelRef, true, onClose);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Nurse detail"
      className="fixed inset-y-0 right-0 z-40 flex w-[min(420px,calc(100vw-2rem))] flex-col overflow-y-auto border-l
        border-border bg-surface p-5 shadow-xl"
    >
      <div className="mb-4 flex items-start justify-between gap-2">
        <h2 className="text-lg font-semibold text-text">Nurse detail</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close nurse detail"
          className="rounded-md px-2 py-1 text-sm text-text-muted hover:bg-bg"
        >
          Close
        </button>
      </div>

      {nurseQuery.isPending ? (
        <AsyncState status="loading" label="Loading nurse" />
      ) : nurseQuery.isError ? (
        <AsyncState status="error" label="Could not load nurse" error={nurseQuery.error} />
      ) : nurseQuery.data === undefined ? (
        <AsyncState status="empty" label="Nurse not found" />
      ) : (
        <NurseDetailBody nurseId={nurseId} nurse={nurseQuery.data} onEdit={onEdit} />
      )}
    </div>
  );
}

function NurseDetailBody({
  nurseId,
  nurse,
  onEdit,
}: {
  nurseId: Id;
  nurse: Nurse;
  onEdit: (nurse: Nurse) => void;
}) {
  const [confirmingDeactivate, setConfirmingDeactivate] = useState(false);
  const deactivateNurse = useDeactivateNurse(nurse.unitId);
  const reactivateNurse = useUpdateNurse(nurse.unitId);
  const impact = useDeactivationImpact(nurseId, confirmingDeactivate);
  const name = `${nurse.firstName} ${nurse.lastName}`;
  // The control that opened a dialog is gone once the nurse flips state, so focus goes to the one
  // that replaced it as soon as it mounts (the nurse refetch lands after the dialog has closed).
  const focusNext = useRef<'deactivate' | 'reactivate' | null>(null);
  const deactivateButton = (el: HTMLButtonElement | null) => {
    if (el !== null && focusNext.current === 'deactivate') {
      focusNext.current = null;
      el.focus();
    }
  };
  const reactivateEl = useRef<HTMLButtonElement | null>(null);
  const reactivateButton = (el: HTMLButtonElement | null) => {
    reactivateEl.current = el;
    if (el !== null && focusNext.current === 'reactivate') {
      focusNext.current = null;
      el.focus();
    }
  };
  const blocked = impact.data !== undefined && impact.data.published.length > 0;

  return (
    <>
      <NurseSummary nurse={nurse} />
      <KeptApart nurse={nurse} />

      <div className="mt-4 flex gap-2">
        <button type="button" onClick={() => onEdit(nurse)} className={SECONDARY}>
          Edit
        </button>
        <ExportRecordButton nurse={nurse} />
        {nurse.active ? (
          <button
            type="button"
            ref={deactivateButton}
            onClick={() => {
              deactivateNurse.reset();
              setConfirmingDeactivate(true);
            }}
            className="rounded-md border border-danger px-3 py-1.5 text-sm text-danger hover:bg-bg"
          >
            Deactivate
          </button>
        ) : (
          <>
            <span className="self-center text-sm text-text-muted">Inactive</span>
            <button
              type="button"
              ref={reactivateButton}
              disabled={reactivateNurse.isPending}
              onClick={() => {
                focusNext.current = 'deactivate';
                reactivateNurse.mutate({ id: nurseId, patch: { active: true } });
              }}
              className={SECONDARY}
            >
              {reactivateNurse.isPending ? 'Reactivating…' : 'Reactivate'}
            </button>
          </>
        )}
      </div>
      {reactivateNurse.isError ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {errorMessage(reactivateNurse.error)}
        </p>
      ) : null}

      <Modal
        open={confirmingDeactivate}
        onOpenChange={setConfirmingDeactivate}
        variant="popup"
        size="sm"
        // The Deactivate button this opened from is gone by then; the Close button the drawer
        // focused on mount would otherwise win.
        returnFocus={() => reactivateEl.current}
        title={`Deactivate ${name}?`}
        description={impactSummary(name, impact)}
        footer={
          <>
            <button
              type="button"
              className={SECONDARY}
              onClick={() => setConfirmingDeactivate(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={deactivateNurse.isPending || impact.data === undefined || blocked}
              onClick={() =>
                deactivateNurse.mutate(nurseId, {
                  onSuccess: () => {
                    focusNext.current = 'reactivate';
                    setConfirmingDeactivate(false);
                  },
                })
              }
              className={DANGER_SOLID}
            >
              {deactivateNurse.isPending ? 'Deactivating…' : 'Deactivate'}
            </button>
          </>
        }
      >
        {impact.data !== undefined && blocked ? (
          <PublishedShifts
            impact={impact.data}
            nurseId={nurseId}
            firstName={nurse.firstName}
            onFollow={() => setConfirmingDeactivate(false)}
          />
        ) : null}
        {deactivateNurse.isError ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {errorMessage(deactivateNurse.error)}
          </p>
        ) : null}
      </Modal>

      <CredentialsSection nurseId={nurseId} />
      <AlsoWorksOnSection nurse={nurse} />
      <LeaveSection nurseId={nurseId} />
      <PreferencesSection nurseId={nurseId} unitId={nurse.unitId} />
    </>
  );
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** One sentence for what the dialog is about to do; the published list is rendered beneath it. */
function impactSummary(
  name: string,
  impact: { isPending: boolean; isError: boolean; error: unknown; data?: DeactivationImpact },
): string {
  if (impact.isError) return `Could not check ${name}'s shifts: ${errorMessage(impact.error)}`;
  const data = impact.data;
  if (data === undefined) return `Checking ${name}'s shifts from today on…`;
  if (data.published.length > 0) {
    return `${name} has ${plural(data.published.length, 'shift')} on published schedules from today on:`;
  }
  if (data.draft.length > 0) {
    return `Deactivating takes ${name}'s ${plural(data.draft.length, 'draft shift')} from ${formatDateWithWeekday(data.draft[0]!.date)} on off the schedule. Their history is kept.`;
  }
  return `${name} has no shifts from today on. Their history is kept, and they will not appear on new schedules.`;
}

const LISTED = 5;

function PublishedShifts({
  impact,
  nurseId,
  firstName,
  onFollow,
}: {
  impact: DeactivationImpact;
  nurseId: Id;
  firstName: string;
  onFollow: () => void;
}) {
  const line = (s: FutureShiftView) =>
    `${formatDateWithWeekday(s.date)} · ${s.shiftTypeName} · ${s.periodName}`;
  const more = impact.published.length - LISTED;
  return (
    <div className="mt-2 text-sm text-text">
      <ul className="list-disc pl-5">
        {impact.published.slice(0, LISTED).map((s) => (
          <li key={s.assignmentId}>{line(s)}</li>
        ))}
      </ul>
      {more > 0 ? <p className="mt-1">and {more} more</p> : null}
      <p className="mt-2 text-text-muted">
        Staff already hold these. Give them away or remove them on the schedule grid, with a reason,
        then deactivate.
      </p>
      <Link
        to="/schedule"
        search={{ nurse: nurseId }}
        onClick={onFollow}
        className="mt-2 inline-block text-accent hover:underline"
      >
        Open {firstName}'s schedule
      </Link>
    </div>
  );
}

function NurseSummary({ nurse }: { nurse: Nurse }) {
  const flags: string[] = [];
  if (nurse.isChargeEligible) flags.push('Charge eligible');
  if (nurse.isNovice) flags.push('Novice');
  if (nurse.isFloatEligible) flags.push('Float eligible');

  return (
    <div className="rounded-md border border-border bg-bg p-3 text-sm">
      <p className="text-base font-medium text-text">
        {nurse.lastName}, {nurse.firstName}
      </p>
      <p className="text-text-muted">
        {nurse.employeeId} · {nurse.role} · {nurse.employmentType.replace('_', ' ')}
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-text-muted">
        <dt>FTE</dt>
        <dd className="text-text">{nurse.fte.toFixed(2)}</dd>
        <dt>Contracted hrs/period</dt>
        <dd className="text-text">{nurse.contractedHoursPerPeriod}</dd>
        <dt>Seniority date</dt>
        <dd className="text-text">{formatDate(nurse.seniorityDate)}</dd>
        {nurse.hireDate ? (
          <>
            <dt>Hire date</dt>
            <dd className="text-text">{formatDate(nurse.hireDate)}</dd>
          </>
        ) : null}
        {nurse.phone ? (
          <>
            <dt>Phone</dt>
            <dd className="text-text">{nurse.phone}</dd>
          </>
        ) : null}
        {nurse.email ? (
          <>
            <dt>Email</dt>
            <dd className="text-text">{nurse.email}</dd>
          </>
        ) : null}
      </dl>
      {flags.length > 0 ? <p className="mt-2 text-text">{flags.join(' · ')}</p> : null}
      {nurse.notes ? <p className="mt-2 italic text-text-muted">{nurse.notes}</p> : null}
    </div>
  );
}

/** The groups this nurse is kept apart in, by name; the members and reason are on the roster. */
function KeptApart({ nurse }: { nurse: Nurse }) {
  const groups = useIncompatibilityGroups(nurse.unitId);
  const mine = (groups.data ?? []).filter((g) => g.nurseIds.includes(nurse.id));
  if (mine.length === 0) return null;
  return (
    <p className="mt-3 text-sm text-text-muted">
      Kept apart in: <span className="text-text">{mine.map((g) => g.name).join(', ')}</span>
    </p>
  );
}
