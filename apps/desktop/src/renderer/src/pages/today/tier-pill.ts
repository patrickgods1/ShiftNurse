/**
 * Pure display mapping for a replacement candidate's pay tier, pulled out of `call-off-card.tsx`
 * so the label/tone rule — the one place the contract's straight/overtime/agency priority
 * becomes English and a colour — has an independent test instead of only being exercised through
 * a rendered dialog.
 */

import type { PayTier } from '@shiftnurse/core';

export type Tone = 'success' | 'warn' | 'danger';

const LABELS: Record<PayTier, string> = {
  straight: 'Straight time',
  overtime: 'Overtime',
  agency: 'Agency',
};

const TONES: Record<PayTier, Tone> = {
  straight: 'success',
  overtime: 'warn',
  agency: 'danger',
};

export function payTierLabel(tier: PayTier): string {
  return LABELS[tier];
}

export function payTierTone(tier: PayTier): Tone {
  return TONES[tier];
}

export const TONE_CLASSES: Record<Tone, string> = {
  success: 'bg-success/15 text-success',
  warn: 'bg-warn/15 text-warn',
  danger: 'bg-danger/15 text-danger',
};
