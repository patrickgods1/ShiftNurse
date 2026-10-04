/**
 * One line of status pills above the grid, in place of four full-width banners. On a 1366x768
 * laptop the banners (requests nudge, violations, cost, alerts) took two thirds of the screen
 * and a manager building a schedule spent the evening scrolling; the grid is the page, status
 * is a glance, and the detail opens in place below the row on demand.
 *
 * A pill never relies on colour alone: each carries an icon and its text. Each keeps the
 * `data-testid` of the banner it replaced, on the element that holds the headline (and the
 * preview tag), so a previewed variation's numbers are still visibly the variation's.
 */

import { Link } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';

export type StatusTone = 'ok' | 'warn' | 'danger' | 'muted';

export interface StatusItem {
  id: string;
  testId: string;
  tone: StatusTone;
  /** Headline text; the pill's accessible name. */
  label: ReactNode;
  /** The variation's name tag, while one is previewed. */
  previewTag?: ReactNode;
  /** What opens below the row. Without it the pill is a plain readout. */
  detail?: ReactNode;
  /** A pill that goes to another page instead of opening detail. */
  to?: string;
  /** Hover text: the longer sentence the pill abbreviates. */
  title?: string;
  /** An error reads as an alert, everything else as a polite status. */
  isAlert?: boolean;
}

const TONES: Record<StatusTone, { icon: string; cls: string }> = {
  ok: { icon: '✓', cls: 'text-success' },
  warn: { icon: '⚠', cls: 'text-warn' },
  danger: { icon: '✕', cls: 'text-danger' },
  muted: { icon: 'ⓘ', cls: 'text-text-muted' },
};

const PILL =
  'inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs font-medium';

export function StatusRow({ items }: { items: readonly StatusItem[] }) {
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  if (items.length === 0) return null;
  const open = items.find((i) => i.id === openId && i.detail !== undefined);

  return (
    <div data-testid="status-row" className="mb-2">
      <div className="flex flex-wrap items-center gap-2">
        {items.map((item) => {
          const { icon, cls } = TONES[item.tone];
          const content = (
            <>
              <span aria-hidden="true">{icon}</span>
              {item.previewTag}
              <span>{item.label}</span>
            </>
          );
          const common = `${PILL} ${cls}`;
          if (item.to !== undefined) {
            return (
              <Link
                key={item.id}
                to={item.to}
                data-testid={item.testId}
                title={item.title}
                className={`${common} hover:bg-border/40`}
              >
                {content}
              </Link>
            );
          }
          if (item.detail === undefined) {
            return (
              <p
                key={item.id}
                data-testid={item.testId}
                title={item.title}
                role={item.isAlert ? 'alert' : undefined}
                aria-live={item.isAlert ? undefined : 'polite'}
                className={common}
              >
                {content}
              </p>
            );
          }
          const isOpen = open?.id === item.id;
          return (
            <button
              key={item.id}
              type="button"
              data-testid={item.testId}
              title={item.title}
              aria-expanded={isOpen}
              aria-controls={isOpen ? `${item.testId}-detail` : undefined}
              onClick={() => setOpenId(isOpen ? undefined : item.id)}
              className={`${common} hover:bg-border/40`}
            >
              {content}
              <span aria-hidden="true" className="text-text-muted">
                {isOpen ? '▴' : '▾'}
              </span>
            </button>
          );
        })}
      </div>
      {open ? (
        <div
          id={`${open.testId}-detail`}
          data-testid={`${open.testId}-detail`}
          className="mt-2 rounded-md border border-border bg-surface px-3 py-2 text-sm"
        >
          {open.detail}
        </div>
      ) : null}
    </div>
  );
}
