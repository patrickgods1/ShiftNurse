// @vitest-environment jsdom
/** A nurse's preference editor tells the truth about whether what is on screen is saved. */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { PreferencesSection } from './nurse-preferences.js';

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respondDefault([]);
  bridge.respond('preferences', 'forNurse', []);
  bridge.respond('preferences', 'replace', []);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('a nurse’s preferences in the drawer', () => {
  it('hides Saved once the manager edits again', async () => {
    renderWithApp(<PreferencesSection nurseId="n-1" unitId="u-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save preferences' }));
    await screen.findByText('Saved');
    fireEvent.click(screen.getByRole('button', { name: '+ Add' }));
    await waitFor(() => expect(screen.queryByText('Saved')).toBeNull());
  });
});
