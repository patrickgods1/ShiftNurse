// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AsyncState } from './async-state.js';

describe('AsyncState', () => {
  it('shows the reason a load failed', () => {
    render(
      <AsyncState status="error" label="Could not load" error={new Error('Database is locked')} />,
    );
    expect(screen.getByText('Database is locked')).toBeTruthy();
  });

  it('never shows the word undefined when the failure has no message', () => {
    render(<AsyncState status="error" label="Could not load" error={undefined} />);
    expect(screen.getByText('Unknown error')).toBeTruthy();
    expect(screen.queryByText('undefined')).toBeNull();
  });
});
