/**
 * The nurse detail drawer: summary, credential tracking and the preference editor. Lives
 * beside the roster table rather than behind its own route because a manager clicking through
 * fifty nurses in one sitting shouldn't wait on a route transition each time — it's state on
 * `roster.tsx`, not a page.
 */

import type { Id, Nurse } from '@shiftnurse/core';
import { useRef, useState } from 'react';
import { useDeactivateNurse, useIncompatibilityGroups, useNurse } from '../../api.js';
import { AsyncState } from '../../components/async-state.js';
import { Modal } from '../../components/modal.js';
import { SECONDARY } from '../../components/ui.js';
import { usePanelFocus } from '../../components/use-panel-focus.js';
import { formatDate } from '../../format.js';
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
      className="fixed inset-y-0 right-0 z-40 flex w-[420px] flex-col overflow-y-auto border-l
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
            onClick={() => setConfirmingDeactivate(true)}
            className="rounded-md border border-danger px-3 py-1.5 text-sm text-danger hover:bg-bg"
          >
            Deactivate
          </button>
        ) : (
          <span className="self-center text-sm text-text-muted">Inactive</span>
        )}
      </div>

      <Modal
        open={confirmingDeactivate}
        onOpenChange={setConfirmingDeactivate}
        variant="popup"
        size="sm"
        title={`Deactivate ${nurse.firstName} ${nurse.lastName}?`}
        description="This removes them from future scheduling. Their history is kept."
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
              disabled={deactivateNurse.isPending}
              onClick={() =>
                deactivateNurse.mutate(nurseId, {
                  onSuccess: () => setConfirmingDeactivate(false),
                })
              }
              className="rounded-md bg-danger px-3 py-1.5 text-sm font-medium text-white
                disabled:opacity-60"
            >
              {deactivateNurse.isPending ? 'Deactivating…' : 'Deactivate'}
            </button>
          </>
        }
      />

      <CredentialsSection nurseId={nurseId} />
      <AlsoWorksOnSection nurse={nurse} />
      <LeaveSection nurseId={nurseId} />
      <PreferencesSection nurseId={nurseId} unitId={nurse.unitId} />
    </>
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
