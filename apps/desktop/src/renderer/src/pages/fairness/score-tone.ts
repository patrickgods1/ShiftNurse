/**
 * Shared thresholds for coloring a 0–100 fairness score, so the per-nurse table and the
 * component breakdown bars read the same way: green means the nurse is at or ahead of their
 * fair share, amber means a moderate gap worth watching, red means the schedule owes them
 * relief. Colour is always paired with the number itself (never the only signal) per the
 * manager needing to defend a decision with a figure, not a swatch.
 */

export type ScoreTone = 'success' | 'warn' | 'danger';

export const SCORE_TONE_CLASSES: Record<ScoreTone, string> = {
  success: 'text-success',
  warn: 'text-warn',
  danger: 'text-danger',
};

export const SCORE_BAR_CLASSES: Record<ScoreTone, string> = {
  success: 'bg-success',
  warn: 'bg-warn',
  danger: 'bg-danger',
};

export function scoreTone(score: number): ScoreTone {
  if (score >= 85) return 'success';
  if (score >= 60) return 'warn';
  return 'danger';
}
