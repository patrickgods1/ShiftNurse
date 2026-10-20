// @vitest-environment jsdom
/** An edited credential expiry counts as unsaved until the manager presses Save. */

import type { Credential, NurseCredential } from '@shiftnurse/core';
import { cleanup, fireEvent, screen } from '@testing-library/react';
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
