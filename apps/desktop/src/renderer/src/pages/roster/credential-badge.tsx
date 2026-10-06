/**
 * "Lapsed" / "Expires soon" markers for credentials. Always a word, never colour alone: the
 * colour is for a glance, the text is what a screen reader and a printout carry.
 */

import type { IsoDate } from '@shiftnurse/core';
import { daysFromToday } from '../../format.js';

export type CredentialStanding = 'lapsed' | 'soon';

const STYLE: Record<CredentialStanding, { label: string; className: string }> = {
  lapsed: { label: 'Lapsed', className: 'border-danger text-danger' },
  soon: { label: 'Expires soon', className: 'border-warn text-warn' },
};

/** A record's own standing: expiry day itself is the last valid day, so only days < 0 lapse. */
export function standingOf(expiresOn: IsoDate | undefined): CredentialStanding | undefined {
  if (expiresOn === undefined) return undefined;
  const days = daysFromToday(expiresOn);
  if (days < 0) return 'lapsed';
  return days <= 30 ? 'soon' : undefined;
}

export function CredentialBadge({ standing }: { standing: CredentialStanding }) {
  const { label, className } = STYLE[standing];
  return (
    <span
      data-testid={`credential-badge-${standing}`}
      className={`inline-block whitespace-nowrap rounded border px-1.5 py-0.5 text-xs font-medium ${className}`}
    >
      {label}
    </span>
  );
}
