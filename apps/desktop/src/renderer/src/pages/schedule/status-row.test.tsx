// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { type StatusItem, StatusRow } from './status-row.js';

afterEach(cleanup);

const items: StatusItem[] = [
  {
    id: 'v',
    testId: 'violation-summary',
    tone: 'warn',
    label: '0 hard · 2 soft',
    detail: <p>Soft — rest is short</p>,
  },
  {
    id: 'c',
    testId: 'cost-summary',
    tone: 'muted',
    label: '$431,911 · +$308k vs budget',
    detail: <p>Overtime 12h</p>,
  },
  { id: 'n', testId: 'plain', tone: 'ok', label: 'All good' },
];

describe('the schedule status row', () => {
  it('shows one pill for each status that is present, and nothing for none', () => {
    const { container, rerender } = render(<StatusRow items={items} />);
    expect(screen.getByTestId('violation-summary').textContent).toContain('0 hard · 2 soft');
    expect(screen.getByTestId('cost-summary').textContent).toContain('+$308k vs budget');
    expect(screen.getByTestId('plain')).toBeTruthy();
    rerender(<StatusRow items={[]} />);
    expect(container.textContent).toBe('');
  });

  it("opens a pill's detail in place when it is clicked, and closes it on a second click", () => {
    render(<StatusRow items={items} />);
    expect(screen.queryByText('Soft — rest is short')).toBeNull();
    fireEvent.click(screen.getByTestId('violation-summary'));
    expect(screen.getByText('Soft — rest is short')).toBeTruthy();
    expect(screen.getByTestId('violation-summary').getAttribute('aria-expanded')).toBe('true');
    const region = screen.getByTestId('violation-summary-detail');
    expect(region.id).toBe('violation-summary-detail');
    expect(screen.getByTestId('violation-summary').getAttribute('aria-controls')).toBe(region.id);
    fireEvent.click(screen.getByTestId('cost-summary'));
    expect(screen.queryByText('Soft — rest is short')).toBeNull();
    expect(screen.getByText('Overtime 12h')).toBeTruthy();
    fireEvent.click(screen.getByTestId('cost-summary'));
    expect(screen.queryByText('Overtime 12h')).toBeNull();
  });

  it('marks tone with an icon as well as colour', () => {
    render(<StatusRow items={items} />);
    expect(screen.getByTestId('violation-summary').textContent).toContain('⚠');
    expect(screen.getByTestId('plain').textContent).toContain('✓');
  });
});
