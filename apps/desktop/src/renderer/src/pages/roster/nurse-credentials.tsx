/** A nurse's credentials: what they hold, when each lapses, granting and revoking. */

import type { Credential, Id, IsoDate, NurseCredential } from '@shiftnurse/core';
import { useId, useState } from 'react';
import {
  useCreateCredential,
  useCredentialCatalogue,
  useGrantCredential,
  useNurseCredentials,
  useRevokeCredential,
  useUpdateCredentialExpiry,
} from '../../api.js';
import { AsyncState } from '../../components/async-state.js';
import { daysFromToday } from '../../format.js';

function expiryColor(expiresOn: IsoDate | undefined): string {
  if (expiresOn === undefined) return 'text-text';
  const days = daysFromToday(expiresOn);
  if (days <= 30) return 'text-danger';
  if (days <= 90) return 'text-warn';
  return 'text-text';
}

export function CredentialsSection({ nurseId }: { nurseId: Id }) {
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
