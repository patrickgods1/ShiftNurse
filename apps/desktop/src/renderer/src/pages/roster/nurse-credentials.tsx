/**
 * A nurse's credentials: what they hold, when each lapses, granting and revoking. A revoke asks
 * first and may carry a reason for the audit trail; clearing an expiry asks first, because no
 * expiry means valid forever.
 */

import type { Credential, Id, IsoDate, NurseCredential } from '@shiftnurse/core';
import { useId, useRef, useState } from 'react';
import {
  useCredentialCatalogue,
  useGrantCredential,
  useGrantNewCredential,
  useNurse,
  useNurseCredentials,
  useRevokeCredential,
  useUpdateCredentialExpiry,
} from '../../api.js';
import { AsyncState } from '../../components/async-state.js';
import { useConfirm } from '../../components/confirm.js';
import { DateField, dateProblem } from '../../components/date-field.js';
import { describedBy, Field } from '../../components/field-help.js';
import { Modal } from '../../components/modal.js';
import {
  DANGER_SOLID,
  errorMessage,
  INPUT,
  PRIMARY_SMALL,
  SECONDARY,
} from '../../components/ui.js';
import { useUnsavedChanges } from '../../components/unsaved-changes.js';
import { useFieldDraft } from '../../field-values.js';
import { daysFromToday, formatDate } from '../../format.js';
import { CredentialBadge, standingOf } from './credential-badge.js';

/** "expires in 24 months", "expires in 12 days", "expired 3 days ago". */
function expiresIn(days: number): string {
  if (days < 0) return `expired ${-days} day${days === -1 ? '' : 's'} ago`;
  if (days === 0) return 'expires today';
  if (days < 60) return `expires in ${days} day${days === 1 ? '' : 's'}`;
  return `expires in ${Math.round(days / 30)} months`;
}

/** The words take the badge's colour, so colour never says what the badge and words do not. */
const STANDING_COLOR = { lapsed: 'text-danger', soon: 'text-warn' } as const;

export function CredentialsSection({ nurseId }: { nurseId: Id }) {
  const credentialsQuery = useNurseCredentials(nurseId);
  const catalogueQuery = useCredentialCatalogue();
  const updateExpiry = useUpdateCredentialExpiry(nurseId);
  const [showGrant, setShowGrant] = useState(false);
  const [revoking, setRevoking] = useState<NurseCredential | undefined>(undefined);
  // The row, and its Revoke button, is gone once the revoke lands.
  const grantButton = useRef<HTMLButtonElement>(null);

  const catalogueById = new Map<Id, Credential>((catalogueQuery.data ?? []).map((c) => [c.id, c]));

  return (
    <section data-testid="nurse-credentials" className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text">Credentials</h3>
        <button
          ref={grantButton}
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
              onUpdateExpiry={(expiresOn, onSuccess) =>
                updateExpiry.mutate({ id: nc.id, expiresOn }, { onSuccess })
              }
              error={
                updateExpiry.variables?.id === nc.id ? errorMessage(updateExpiry.error) : undefined
              }
              onRevoke={() => setRevoking(nc)}
            />
          ))}
        </ul>
      )}

      {showGrant ? (
        <GrantCredentialForm
          nurseId={nurseId}
          catalogue={catalogueQuery.data ?? []}
          catalogueLoading={catalogueQuery.isPending}
          held={new Set((credentialsQuery.data ?? []).map((nc) => nc.credentialId))}
          onDone={() => setShowGrant(false)}
        />
      ) : null}

      {revoking ? (
        <RevokeDialog
          nurseId={nurseId}
          nurseCredential={revoking}
          credential={catalogueById.get(revoking.credentialId)}
          onClose={() => setRevoking(undefined)}
          returnFocus={() => grantButton.current}
        />
      ) : null}
    </section>
  );
}

function RevokeDialog({
  nurseId,
  nurseCredential,
  credential,
  onClose,
  returnFocus,
}: {
  nurseId: Id;
  nurseCredential: NurseCredential;
  credential: Credential | undefined;
  onClose: () => void;
  returnFocus: () => HTMLElement | null;
}) {
  const revoke = useRevokeCredential(nurseId);
  const nurse = useNurse(nurseId).data;
  const [reason, setReason] = useState('');
  const reasonId = useId();
  const who = nurse ? `${nurse.firstName} ${nurse.lastName}` : 'this nurse';
  const what = credential
    ? `${credential.name} (${credential.code})`
    : nurseCredential.credentialId;
  const expiry = nurseCredential.expiresOn
    ? `It expires ${formatDate(nurseCredential.expiresOn)}. `
    : '';
  const error = errorMessage(revoke.error);
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !revoke.isPending) onClose();
      }}
      variant="popup"
      size="sm"
      title={`Revoke ${what} from ${who}?`}
      description={`${expiry}It comes off their record, and shifts that need it are checked again. Granting it again means entering the expiry again.`}
      returnFocus={returnFocus}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={revoke.isPending} className={SECONDARY}>
            Cancel
          </button>
          <button
            type="button"
            disabled={revoke.isPending}
            onClick={() =>
              revoke.mutate(
                { id: nurseCredential.id, reason: reason.trim() || undefined },
                { onSuccess: onClose },
              )
            }
            className={DANGER_SOLID}
          >
            {revoke.isPending ? 'Revoking…' : 'Revoke'}
          </button>
        </>
      }
    >
      <div className="mt-3">
        <Field id={reasonId} label="Reason (optional)" hint="Kept in the audit trail.">
          <textarea
            id={reasonId}
            className={INPUT}
            rows={2}
            value={reason}
            aria-describedby={describedBy(reasonId, { hint: true })}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

function CredentialRow({
  nurseCredential,
  credential,
  onUpdateExpiry,
  error,
  onRevoke,
}: {
  nurseCredential: NurseCredential;
  credential: Credential | undefined;
  onUpdateExpiry: (expiresOn: IsoDate | undefined, onSuccess: () => void) => void;
  error: string | undefined;
  onRevoke: () => void;
}) {
  const saved = nurseCredential.expiresOn ?? '';
  const draft = useFieldDraft(saved);
  const expiry = draft.text;
  const inputId = useId();
  const confirm = useConfirm();
  const code = credential?.code ?? nurseCredential.credentialId;
  useUnsavedChanges('Credential expiry', expiry !== saved);
  const standing = standingOf(nurseCredential.expiresOn);
  const canSave = expiry !== saved && dateProblem(expiry, undefined, undefined) === undefined;

  async function save() {
    // No expiry means valid forever, so a cleared box must be meant.
    if (
      credential?.tracksExpiry !== false &&
      saved !== '' &&
      expiry === '' &&
      !(await confirm({
        title: `Remove ${code}'s expiry date?`,
        description: `${code} will count as valid indefinitely.`,
        confirmLabel: 'Remove expiry',
      }))
    ) {
      return;
    }
    // Reset only once it is saved: after a failure the box must keep what the manager typed.
    onUpdateExpiry((expiry || undefined) as IsoDate | undefined, () => draft.reset(expiry));
  }

  return (
    <li className="rounded-md border border-border p-2 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium text-text">
          {credential ? `${credential.name} (${credential.code})` : nurseCredential.credentialId}
        </span>
        <button
          type="button"
          onClick={onRevoke}
          aria-label={`Revoke ${code}`}
          className="text-xs text-danger hover:underline"
        >
          Revoke
        </button>
      </div>
      {credential?.tracksExpiry !== false ? (
        <div className="mt-1 flex items-center gap-2">
          <DateField
            id={inputId}
            label="Expires"
            value={expiry as IsoDate | ''}
            onChange={draft.setText}
          />
          <span className={standing ? STANDING_COLOR[standing] : 'text-text'}>
            {nurseCredential.expiresOn
              ? expiresIn(daysFromToday(nurseCredential.expiresOn))
              : 'no expiry'}
          </span>
          {standing === undefined ? null : <CredentialBadge standing={standing} />}
          <button
            type="button"
            onClick={() => void save()}
            disabled={!canSave}
            aria-label={`Save ${code} expiry`}
            className="text-xs text-accent hover:underline disabled:opacity-50"
          >
            Save
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </li>
  );
}

function GrantCredentialForm({
  nurseId,
  catalogue,
  catalogueLoading,
  held,
  onDone,
}: {
  nurseId: Id;
  catalogue: Credential[];
  catalogueLoading: boolean;
  held: Set<Id>;
  onDone: () => void;
}) {
  const grant = useGrantCredential(nurseId);
  const grantNew = useGrantNewCredential(nurseId);
  const firstName = useNurse(nurseId).data?.firstName ?? 'This nurse';
  const [creatingNew, setCreatingNew] = useState(false);
  const [selectedId, setSelectedId] = useState<Id | ''>('');
  const [expiresOn, setExpiresOn] = useState('');
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [newTracksExpiry, setNewTracksExpiry] = useState(true);
  const selectId = useId();
  const codeId = useId();
  const nameId = useId();
  const whyId = useId();

  // The list can arrive after the form opens, or change under it; the select shows exactly the
  // id that Grant will send.
  const available = catalogue.filter((c) => !held.has(c.id));
  const effectiveId =
    selectedId !== '' && available.some((c) => c.id === selectedId)
      ? selectedId
      : (available[0]?.id ?? '');
  const chosen = available.find((c) => c.id === effectiveId);
  const code = newCode.trim().toUpperCase();
  const onFile = catalogue.some((c) => c.code.toUpperCase() === code);

  let why: string | undefined;
  if (catalogueLoading) why = 'Loading credential types…';
  else if (creatingNew) {
    if (code === '') why = 'Enter a code, such as ACLS.';
    else if (newName.trim() === '') why = "Enter the credential's name.";
    else if (onFile) why = `${code} is already on file; choose it from the list.`;
  } else if (effectiveId === '') {
    why = `${firstName} already holds every credential type on file; add a new type.`;
  }

  const showExpiry = creatingNew ? newTracksExpiry : chosen?.tracksExpiry !== false;
  const pending = grant.isPending || grantNew.isPending;
  const error = errorMessage(grant.error ?? grantNew.error);

  function handleGrant() {
    if (why !== undefined) return;
    if (creatingNew) {
      grantNew.mutate(
        {
          nurseId,
          code,
          name: newName.trim(),
          tracksExpiry: newTracksExpiry,
          ...(newTracksExpiry && expiresOn ? { expiresOn: expiresOn as IsoDate } : {}),
        },
        { onSuccess: onDone },
      );
      return;
    }
    grant.mutate(
      {
        nurseId,
        credentialId: effectiveId as Id,
        ...(showExpiry && expiresOn ? { expiresOn: expiresOn as IsoDate } : {}),
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
            value={effectiveId}
            onChange={(e) => setSelectedId(e.target.value as Id)}
            className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1"
          >
            {available.map((c) => (
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
          <div>
            <label htmlFor={codeId} className="text-text-muted">
              Code
            </label>
            <input
              id={codeId}
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
              className="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-1"
            />
          </div>
          <div>
            <label htmlFor={nameId} className="text-text-muted">
              Name
            </label>
            <input
              id={nameId}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-1"
            />
          </div>
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

      {showExpiry ? (
        <div className="mt-2">
          <DateField label="Expires on" value={expiresOn as IsoDate | ''} onChange={setExpiresOn} />
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-danger">
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap justify-end gap-2">
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
          disabled={pending || why !== undefined}
          aria-describedby={why !== undefined ? whyId : undefined}
          className={PRIMARY_SMALL}
        >
          Grant
        </button>
      </div>
      {why !== undefined ? (
        <p id={whyId} className="mt-1 text-right text-xs text-text-muted">
          {why}
        </p>
      ) : null}
    </div>
  );
}
