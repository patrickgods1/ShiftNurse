// @vitest-environment jsdom
/**
 * The "Why?" dialog in front of every denial, withdrawal and resolution. Its reason is what gets
 * quoted if a decision is challenged, so the form must not let a blank one through.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReasonDialog } from './reason-dialog.js';

afterEach(cleanup);

function renderDialog(props: Partial<Parameters<typeof ReasonDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  render(
    <ReasonDialog
      open
      onOpenChange={vi.fn()}
      title="Deny time off"
      confirmLabel="Deny"
      pending={false}
      error={undefined}
      onConfirm={onConfirm}
      {...props}
    />,
  );
  return { onConfirm, reason: screen.getByRole('textbox', { name: /reason/i }) };
}

describe('asking the manager why', () => {
  it('will not deny a request until a reason is typed', () => {
    const { onConfirm } = renderDialog();
    const deny = screen.getByRole('button', { name: 'Deny' });
    expect(deny).toHaveProperty('disabled', true);
    fireEvent.click(deny);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('does not count spaces as a reason', () => {
    const { onConfirm, reason } = renderDialog();
    fireEvent.change(reason, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Deny' })).toHaveProperty('disabled', true);
    fireEvent.submit(reason.closest('form') as HTMLFormElement);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('records the reason as typed, without stray spaces', () => {
    const { onConfirm, reason } = renderDialog();
    fireEvent.change(reason, { target: { value: '  Three nurses already off that weekend ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onConfirm).toHaveBeenCalledWith('Three nurses already off that weekend');
  });

  it('lets an optional reason be left blank', () => {
    const { onConfirm } = renderDialog({ required: false, confirmLabel: 'Approve' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onConfirm).toHaveBeenCalledWith('');
  });

  it('shows why the save failed, in the words main sent', () => {
    renderDialog({ error: new Error('That request was already decided. Reload and try again.') });
    expect(screen.getByRole('alert').textContent).toBe(
      'That request was already decided. Reload and try again.',
    );
  });

  it('cannot be confirmed twice while the first save is still running', () => {
    renderDialog({ pending: true });
    expect(screen.getByRole('button', { name: 'Saving…' })).toHaveProperty('disabled', true);
  });
});
