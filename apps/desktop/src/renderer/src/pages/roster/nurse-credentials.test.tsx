// @vitest-environment jsdom
/** An edited credential expiry counts as unsaved until the manager presses Save. */

import type { Credential, NurseCredential } from '@shiftnurse/core';
import { addDays, type IsoDate, today } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useConfirmDiscard } from '../../components/unsaved-changes.js';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { CredentialsSection } from './nurse-credentials.js';

const acls = { id: 'c-1', code: 'ACLS', name: 'ACLS', tracksExpiry: true } as Credential;
const held = {
  id: 'nc-1',
  nurseId: 'n-1',
  credentialId: 'c-1',
  expiresOn: '2030-01-01',
} as NurseCredential;

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respondDefault([]);
  bridge.respond('credentials', 'forNurse', [held]);
  bridge.respond('credentials', 'list', [acls]);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('a nurse’s credential expiry in the drawer', () => {
  it('asks about Credential expiry once the manager changes a date', async () => {
    let ask: ReturnType<typeof useConfirmDiscard> | undefined;
    function Probe() {
      ask = useConfirmDiscard();
      return null;
    }
    renderWithApp(
      <>
        <Probe />
        <CredentialsSection nurseId="n-1" />
      </>,
    );
    const field = await screen.findByLabelText('Expires');
    expect(await ask?.()).toBe(true);

    fireEvent.change(field, { target: { value: '2031-02-02' } });
    const pending = ask?.();
    await screen.findByText('Discard unsaved changes to Credential expiry?');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await pending).toBe(false);
  });
});

const lifeSupport = {
  id: 'c-acls',
  code: 'ACLS',
  name: 'Advanced Cardiac Life Support',
  tracksExpiry: true,
} as Credential;
const basic = {
  id: 'c-bls',
  code: 'BLS',
  name: 'Basic Life Support',
  tracksExpiry: true,
} as Credential;
const pediatric = {
  id: 'c-pals',
  code: 'PALS',
  name: 'Pediatric Advanced Life Support',
  tracksExpiry: false,
} as Credential;
const holdsAcls = {
  id: 'nc-1',
  nurseId: 'n-1',
  credentialId: 'c-acls',
  expiresOn: '2027-03-03',
} as NurseCredential;

function script(held: NurseCredential[]) {
  bridge.respond('credentials', 'list', [lifeSupport, basic, pediatric]);
  bridge.respond('credentials', 'forNurse', held);
  bridge.respond('nurses', 'get', { id: 'n-1', firstName: 'Ana', lastName: 'Cruz' } as never);
}

describe('a nurse’s credentials', () => {
  it('grants the credential the list shows even when the list arrived after the form opened', async () => {
    let release: (list: Credential[]) => void = () => {};
    bridge.respond(
      'credentials',
      'list',
      (() =>
        new Promise<Credential[]>((resolve) => {
          release = resolve;
        })) as never,
    );
    bridge.respond('credentials', 'forNurse', []);
    renderWithApp(<CredentialsSection nurseId="n-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Grant credential' }));
    release([lifeSupport, basic]);
    const select = (await screen.findByLabelText('Credential')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('c-acls'));
    fireEvent.click(screen.getByRole('button', { name: 'Grant' }));
    await waitFor(() =>
      expect(bridge.callsTo('credentials', 'grant')).toEqual([
        [{ nurseId: 'n-1', credentialId: 'c-acls' }],
      ]),
    );
  });

  it('does not offer a credential the nurse already holds', async () => {
    script([holdsAcls]);
    renderWithApp(<CredentialsSection nurseId="n-1" />);
    await screen.findByText(/Advanced Cardiac Life Support \(ACLS\)/);
    fireEvent.click(screen.getByRole('button', { name: 'Grant credential' }));
    const select = await screen.findByLabelText('Credential');
    await waitFor(() =>
      expect(
        within(select)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['Basic Life Support (BLS)', 'Pediatric Advanced Life Support (PALS)']),
    );
  });

  it('adds a new credential type and grants it in one step', async () => {
    script([]);
    renderWithApp(<CredentialsSection nurseId="n-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Grant credential' }));
    fireEvent.click(await screen.findByRole('button', { name: '+ New credential type' }));
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'tncc' } });
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Trauma Nursing Core Course' },
    });
    fireEvent.change(screen.getByLabelText('Expires on'), { target: { value: '2027-05-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Grant' }));
    await waitFor(() =>
      expect(bridge.callsTo('credentials', 'grantNew')).toEqual([
        [
          {
            nurseId: 'n-1',
            code: 'TNCC',
            name: 'Trauma Nursing Core Course',
            tracksExpiry: true,
            expiresOn: '2027-05-01',
          },
        ],
      ]),
    );
    expect(bridge.callsTo('credentials', 'create')).toEqual([]);
    expect(bridge.callsTo('credentials', 'grant')).toEqual([]);
  });

  it('says why Grant is off for a code already on file', async () => {
    script([]);
    renderWithApp(<CredentialsSection nurseId="n-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Grant credential' }));
    fireEvent.click(await screen.findByRole('button', { name: '+ New credential type' }));
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'acls' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Anything' } });
    await screen.findByText('ACLS is already on file; choose it from the list.');
    expect((screen.getByRole('button', { name: 'Grant' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('asks before revoking, and keeps the reason given', async () => {
    script([holdsAcls]);
    renderWithApp(<CredentialsSection nurseId="n-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke ACLS' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Revoke Advanced Cardiac Life Support (ACLS) from Ana Cruz?',
    });
    expect(bridge.callsTo('credentials', 'revoke')).toEqual([]);
    fireEvent.change(within(dialog).getByLabelText('Reason (optional)'), {
      target: { value: 'Not renewed' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() =>
      expect(bridge.callsTo('credentials', 'revoke')).toEqual([['nc-1', 'Not renewed']]),
    );
  });

  it('keeps Save off until the expiry changes', async () => {
    script([holdsAcls]);
    renderWithApp(<CredentialsSection nurseId="n-1" />);
    const save = await screen.findByRole('button', { name: 'Save ACLS expiry' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Expires'), { target: { value: '2028-03-03' } });
    expect((save as HTMLButtonElement).disabled).toBe(false);
  });

  it('asks before clearing an expiry, which would make ACLS valid indefinitely', async () => {
    script([holdsAcls]);
    renderWithApp(<CredentialsSection nurseId="n-1" />);
    fireEvent.change(await screen.findByLabelText('Expires'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save ACLS expiry' }));
    await screen.findByText('ACLS will count as valid indefinitely.');
    expect(bridge.callsTo('credentials', 'updateExpiry')).toEqual([]);
    fireEvent.click(screen.getByTestId('confirm-accept'));
    await waitFor(() =>
      expect(bridge.callsTo('credentials', 'updateExpiry')).toEqual([['nc-1', undefined]]),
    );
  });

  it('keeps the typed date and says so when the expiry could not be saved', async () => {
    script([holdsAcls]);
    bridge.fail('credentials', 'updateExpiry', new Error('Database is locked'));
    renderWithApp(<CredentialsSection nurseId="n-1" />);
    const field = (await screen.findByLabelText('Expires')) as HTMLInputElement;
    fireEvent.change(field, { target: { value: '2028-03-03' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save ACLS expiry' }));
    await screen.findByText('Database is locked');
    expect(field.value).toBe('2028-03-03');
    expect(
      (screen.getByRole('button', { name: 'Save ACLS expiry' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('colours the expiry words the way the badge does', async () => {
    script([{ ...holdsAcls, expiresOn: addDays(today(), 12) as IsoDate }]);
    renderWithApp(<CredentialsSection nurseId="n-1" />);
    const phrase = await screen.findByText('expires in 12 days');
    expect(phrase.className).toContain('text-warn');
    expect(phrase.className).not.toContain('text-danger');
    expect(screen.getByText('Expires soon')).toBeTruthy();
  });

  it('does not ask for an expiry date for a type that never expires', async () => {
    script([]);
    renderWithApp(<CredentialsSection nurseId="n-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Grant credential' }));
    const select = (await screen.findByLabelText('Credential')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('c-acls'));
    fireEvent.change(select, { target: { value: 'c-pals' } });
    expect(screen.queryByLabelText('Expires on')).toBeNull();
    fireEvent.change(select, { target: { value: 'c-acls' } });
    fireEvent.click(screen.getByRole('button', { name: '+ New credential type' }));
    expect(screen.getByLabelText('Expires on')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Tracks expiry'));
    expect(screen.queryByLabelText('Expires on')).toBeNull();
  });
});
