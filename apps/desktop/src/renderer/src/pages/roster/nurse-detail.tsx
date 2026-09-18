/**
 * The nurse detail drawer: summary, credential tracking and the preference editor. Lives
 * beside the roster table rather than behind its own route because a manager clicking through
 * fifty nurses in one sitting shouldn't wait on a route transition each time — it's state on
 * `roster.tsx`, not a page.
 */

import * as Dialog from '@radix-ui/react-dialog';
import type { Credential, Id, IsoDate, Nurse, NurseCredential, Preference } from '@shiftnurse/core';
import { useEffect, useId, useState } from 'react';
import type { PreferenceInput } from '../../../../shared/api.js';
import {
  useCreateCredential,
  useCredentialCatalogue,
  useDeactivateNurse,
  useGrantCredential,
  useNurse,
  useNurseCredentials,
  useNursePreferences,
  useReplacePreferences,
  useRevokeCredential,
  useShiftTypes,
  useUpdateCredentialExpiry,
} from '../../api.js';
import { AsyncState } from '../../components/async-state.js';
import { daysFromToday, formatDate } from '../../format.js';

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

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
          <Dialog.Overlay className="fixed inset-0 bg-black/40" />
          <Dialog.Content
            className="fixed left-1/2 top-1/2 w-[380px] -translate-x-1/2 -translate-y-1/2
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

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function expiryColor(expiresOn: IsoDate | undefined): string {
  if (expiresOn === undefined) return 'text-text';
  const days = daysFromToday(expiresOn);
  if (days <= 30) return 'text-danger';
  if (days <= 90) return 'text-warn';
  return 'text-text';
}

function CredentialsSection({ nurseId }: { nurseId: Id }) {
  const credentialsQuery = useNurseCredentials(nurseId);
  const catalogueQuery = useCredentialCatalogue();
  const updateExpiry = useUpdateCredentialExpiry(nurseId);
  const revoke = useRevokeCredential(nurseId);
  const [showGrant, setShowGrant] = useState(false);

  const catalogueById = new Map<Id, Credential>((catalogueQuery.data ?? []).map((c) => [c.id, c]));

  return (
    <section data-testid="nurse-credentials" className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text">Credentials</h3>
        <button
          type="button"
          onClick={() => setShowGrant((v) => !v)}
          className="rounded-md border border-border px-2 py-1 text-xs text-text hover:bg-bg"
        >
          {showGrant ? 'Cancel' : 'Grant credential'}
        </button>
      </div>

      {credentialsQuery.isPending ? (
        <AsyncState status="loading" label="Loading credentials" />
      ) : credentialsQuery.isError ? (
        <AsyncState
          status="error"
          label="Could not load credentials"
          error={credentialsQuery.error}
        />
      ) : credentialsQuery.data.length === 0 ? (
        <p className="text-sm text-text-muted">No credentials on file.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {credentialsQuery.data.map((nc) => (
            <CredentialRow
              key={nc.id}
              nurseCredential={nc}
              credential={catalogueById.get(nc.credentialId)}
              onUpdateExpiry={(expiresOn) => updateExpiry.mutate({ id: nc.id, expiresOn })}
              onRevoke={() => revoke.mutate(nc.id)}
            />
          ))}
        </ul>
      )}

      {showGrant ? (
        <GrantCredentialForm
          nurseId={nurseId}
          catalogue={catalogueQuery.data ?? []}
          onDone={() => setShowGrant(false)}
        />
      ) : null}
    </section>
  );
}

function CredentialRow({
  nurseCredential,
  credential,
  onUpdateExpiry,
  onRevoke,
}: {
  nurseCredential: NurseCredential;
  credential: Credential | undefined;
  onUpdateExpiry: (expiresOn: IsoDate | undefined) => void;
  onRevoke: () => void;
}) {
  const [expiry, setExpiry] = useState(nurseCredential.expiresOn ?? '');
  const inputId = useId();

  return (
    <li className="rounded-md border border-border p-2 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium text-text">
          {credential ? `${credential.name} (${credential.code})` : nurseCredential.credentialId}
        </span>
        <button type="button" onClick={onRevoke} className="text-xs text-danger hover:underline">
          Revoke
        </button>
      </div>
      {credential?.tracksExpiry !== false ? (
        <div className="mt-1 flex items-center gap-2">
          <label htmlFor={inputId} className="text-text-muted">
            Expires
          </label>
          <input
            id={inputId}
            type="date"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
            className="rounded-md border border-border bg-bg px-1.5 py-0.5 text-text"
          />
          <span className={expiryColor(nurseCredential.expiresOn)}>
            {nurseCredential.expiresOn
              ? `${daysFromToday(nurseCredential.expiresOn)}d`
              : 'no expiry'}
          </span>
          <button
            type="button"
            onClick={() => onUpdateExpiry((expiry || undefined) as IsoDate | undefined)}
            className="text-xs text-accent hover:underline"
          >
            Save
          </button>
        </div>
      ) : null}
    </li>
  );
}

function GrantCredentialForm({
  nurseId,
  catalogue,
  onDone,
}: {
  nurseId: Id;
  catalogue: Credential[];
  onDone: () => void;
}) {
  const grant = useGrantCredential(nurseId);
  const createCredential = useCreateCredential();
  const [creatingNew, setCreatingNew] = useState(false);
  const [selectedId, setSelectedId] = useState<Id | ''>(catalogue[0]?.id ?? '');
  const [expiresOn, setExpiresOn] = useState('');
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [newTracksExpiry, setNewTracksExpiry] = useState(true);
  const selectId = useId();

  async function handleGrant() {
    let credentialId = selectedId;
    if (creatingNew) {
      if (!newCode.trim() || !newName.trim()) return;
      const created = await createCredential.mutateAsync({
        code: newCode.trim().toUpperCase(),
        name: newName.trim(),
        tracksExpiry: newTracksExpiry,
      });
      credentialId = created.id;
    }
    if (!credentialId) return;
    grant.mutate(
      {
        nurseId,
        credentialId,
        issuedOn: undefined,
        expiresOn: (expiresOn || undefined) as IsoDate | undefined,
      },
      { onSuccess: onDone },
    );
  }

  return (
    <div className="mt-3 rounded-md border border-border bg-bg p-3 text-sm">
      {!creatingNew ? (
        <>
          <label htmlFor={selectId} className="block text-text-muted">
            Credential
          </label>
          <select
            id={selectId}
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value as Id)}
            className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1"
          >
            {catalogue.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.code})
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setCreatingNew(true)}
            className="mt-1 text-xs text-accent hover:underline"
          >
            + New credential type
          </button>
        </>
      ) : (
        <div className="flex flex-col gap-2">
          <label className="text-text-muted">
            Code
            <input
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
              className="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-1"
            />
          </label>
          <label className="text-text-muted">
            Name
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-1"
            />
          </label>
          <label className="flex items-center gap-2 text-text">
            <input
              type="checkbox"
              checked={newTracksExpiry}
              onChange={(e) => setNewTracksExpiry(e.target.checked)}
            />
            Tracks expiry
          </label>
          <button
            type="button"
            onClick={() => setCreatingNew(false)}
            className="self-start text-xs text-text-muted hover:underline"
          >
            Use existing instead
          </button>
        </div>
      )}

      <label className="mt-2 block text-text-muted">
        Expires on
        <input
          type="date"
          value={expiresOn}
          onChange={(e) => setExpiresOn(e.target.value)}
          className="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-1"
        />
      </label>

      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onDone}
          className="rounded-md border border-border px-3 py-1 text-xs text-text hover:bg-bg"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleGrant}
          disabled={grant.isPending || createCredential.isPending}
          className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white disabled:opacity-60"
        >
          Grant
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

type PreferenceKind = Preference['kind'];

const PREFERENCE_KIND_LABELS: Record<PreferenceKind, string> = {
  prefer_shift_type: 'Prefers shift type',
  avoid_shift_type: 'Avoids shift type',
  prefer_weekday: 'Prefers weekday',
  avoid_weekday: 'Avoids weekday',
  weekend_appetite: 'Weekend appetite',
  preferred_block_length: 'Preferred block length',
};

interface PreferenceRow {
  key: string;
  value: PreferenceInput;
}

function toRows(preferences: Preference[]): PreferenceRow[] {
  return preferences.map((p, i) => {
    const { id: _id, nurseId: _nurseId, ...rest } = p;
    return { key: `${p.id}-${i}`, value: rest as PreferenceInput };
  });
}

function defaultForKind(kind: PreferenceKind): PreferenceInput {
  switch (kind) {
    case 'prefer_shift_type':
    case 'avoid_shift_type':
      return { kind, shiftTypeId: '', weight: 3 };
    case 'prefer_weekday':
    case 'avoid_weekday':
      return { kind, weekday: 0, weight: 3 };
    case 'weekend_appetite':
      return { kind, level: 0, weight: 3 };
    case 'preferred_block_length':
      return { kind, shifts: 3, weight: 3 };
  }
}

function PreferencesSection({ nurseId, unitId }: { nurseId: Id; unitId: Id }) {
  const preferencesQuery = useNursePreferences(nurseId);
  const shiftTypesQuery = useShiftTypes(unitId);
  const replace = useReplacePreferences(nurseId);
  const [rows, setRows] = useState<PreferenceRow[]>([]);
  const [nextKey, setNextKey] = useState(0);

  useEffect(() => {
    if (preferencesQuery.data) setRows(toRows(preferencesQuery.data));
  }, [preferencesQuery.data]);

  function addRow() {
    setRows((prev) => [
      ...prev,
      { key: `new-${nextKey}`, value: defaultForKind('prefer_shift_type') },
    ]);
    setNextKey((k) => k + 1);
  }

  function removeRow(key: string) {
    setRows((prev) => prev.filter((r) => r.key !== key));
  }

  function updateRow(key: string, value: PreferenceInput) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, value } : r)));
  }

  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text">Preferences</h3>
        <button
          type="button"
          onClick={addRow}
          className="rounded-md border border-border px-2 py-1 text-xs text-text hover:bg-bg"
        >
          + Add
        </button>
      </div>

      {preferencesQuery.isPending || shiftTypesQuery.isPending ? (
        <AsyncState status="loading" label="Loading preferences" />
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {rows.map((row) => (
              <PreferenceRowEditor
                key={row.key}
                row={row}
                shiftTypes={shiftTypesQuery.data ?? []}
                onChange={(value) => updateRow(row.key, value)}
                onRemove={() => removeRow(row.key)}
              />
            ))}
          </ul>
          {rows.length === 0 ? (
            <p className="text-sm text-text-muted">No preferences set.</p>
          ) : null}
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => replace.mutate(rows.map((r) => r.value))}
              disabled={replace.isPending}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white
                disabled:opacity-60"
            >
              {replace.isPending ? 'Saving…' : 'Save preferences'}
            </button>
            {replace.isSuccess ? <span className="text-xs text-success">Saved</span> : null}
            {replace.isError ? <span className="text-xs text-danger">Could not save</span> : null}
          </div>
        </>
      )}
    </section>
  );
}

function PreferenceRowEditor({
  row,
  shiftTypes,
  onChange,
  onRemove,
}: {
  row: PreferenceRow;
  shiftTypes: { id: Id; name: string }[];
  onChange: (value: PreferenceInput) => void;
  onRemove: () => void;
}) {
  const { value } = row;

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2 text-sm">
      <select
        aria-label="Preference kind"
        value={value.kind}
        onChange={(e) => onChange(defaultForKind(e.target.value as PreferenceKind))}
        className="rounded-md border border-border bg-bg px-1.5 py-1"
      >
        {Object.entries(PREFERENCE_KIND_LABELS).map(([kind, label]) => (
          <option key={kind} value={kind}>
            {label}
          </option>
        ))}
      </select>

      {value.kind === 'prefer_shift_type' || value.kind === 'avoid_shift_type' ? (
        <select
          aria-label="Shift type"
          value={value.shiftTypeId}
          onChange={(e) => onChange({ ...value, shiftTypeId: e.target.value as Id })}
          className="rounded-md border border-border bg-bg px-1.5 py-1"
        >
          <option value="">Select…</option>
          {shiftTypes.map((st) => (
            <option key={st.id} value={st.id}>
              {st.name}
            </option>
          ))}
        </select>
      ) : null}

      {value.kind === 'prefer_weekday' || value.kind === 'avoid_weekday' ? (
        <select
          aria-label="Weekday"
          value={value.weekday}
          onChange={(e) =>
            onChange({
              ...value,
              weekday: Number(e.target.value) as 0 | 1 | 2 | 3 | 4 | 5 | 6,
            })
          }
          className="rounded-md border border-border bg-bg px-1.5 py-1"
        >
          {WEEKDAY_NAMES.map((name, i) => (
            <option key={name} value={i}>
              {name}
            </option>
          ))}
        </select>
      ) : null}

      {value.kind === 'weekend_appetite' ? (
        <select
          aria-label="Weekend appetite"
          value={value.level}
          onChange={(e) => onChange({ ...value, level: Number(e.target.value) })}
          className="rounded-md border border-border bg-bg px-1.5 py-1"
        >
          <option value={-1}>Wants none</option>
          <option value={0}>Neutral</option>
          <option value={1}>Wants weekends</option>
        </select>
      ) : null}

      {value.kind === 'preferred_block_length' ? (
        <select
          aria-label="Preferred block length"
          value={value.shifts}
          onChange={(e) => onChange({ ...value, shifts: Number(e.target.value) })}
          className="rounded-md border border-border bg-bg px-1.5 py-1"
        >
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={n}>
              {n} shifts
            </option>
          ))}
        </select>
      ) : null}

      <label className="ml-auto flex items-center gap-1 text-text-muted">
        Weight
        <select
          aria-label="Weight"
          value={value.weight}
          onChange={(e) => onChange({ ...value, weight: Number(e.target.value) })}
          className="rounded-md border border-border bg-bg px-1.5 py-1"
        >
          {[1, 2, 3, 4, 5].map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
      </label>

      <button type="button" onClick={onRemove} className="text-xs text-danger hover:underline">
        Remove
      </button>
    </li>
  );
}
