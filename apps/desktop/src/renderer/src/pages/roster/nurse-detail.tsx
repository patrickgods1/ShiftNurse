/**
 * The nurse detail drawer: summary, credential tracking and the preference editor. Lives
 * beside the roster table rather than behind its own route because a manager clicking through
 * fifty nurses in one sitting shouldn't wait on a route transition each time — it's state on
 * `roster.tsx`, not a page.
 */

import * as Dialog from '@radix-ui/react-dialog';
import type { Id, Nurse } from '@shiftnurse/core';
import { useState } from 'react';
import { useDeactivateNurse, useNurse } from '../../api.js';
import { AsyncState } from '../../components/async-state.js';
import { OVERLAY } from '../../components/ui.js';
import { formatDate } from '../../format.js';
import { CredentialsSection } from './nurse-credentials.js';
import { PreferencesSection } from './nurse-preferences.js';

interface NurseDetailProps {
  nurseId: Id;
  onClose: () => void;
  onEdit: (nurse: Nurse) => void;
}

export function NurseDetail({ nurseId, onClose, onEdit }: NurseDetailProps) {
  const nurseQuery = useNurse(nurseId);

  return (
    <div
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

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={() => onEdit(nurse)}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-text hover:bg-bg"
        >
          Edit
        </button>
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

      <Dialog.Root open={confirmingDeactivate} onOpenChange={setConfirmingDeactivate}>
        <Dialog.Portal>
          <Dialog.Overlay className={OVERLAY} />
          <Dialog.Content
            className="fixed z-50 left-1/2 top-1/2 w-[380px] -translate-x-1/2 -translate-y-1/2
              rounded-lg border border-border bg-surface p-5 shadow-lg"
          >
            <Dialog.Title className="mb-2 text-base font-semibold text-text">
              Deactivate {nurse.firstName} {nurse.lastName}?
            </Dialog.Title>
            <p className="mb-4 text-sm text-text-muted">
              This removes them from future scheduling. Their history is kept.
            </p>
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-md border border-border px-3 py-1.5 text-sm text-text hover:bg-bg"
                >
                  Cancel
                </button>
              </Dialog.Close>
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
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <CredentialsSection nurseId={nurseId} />
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
