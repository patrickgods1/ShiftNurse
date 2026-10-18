/**
 * Display-only money formatting. Costing happens in core on plain numbers; this is the one
 * place those numbers become "$1,234.50" so every screen rounds and groups the same way.
 */

const WHOLE = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});
const CENTS = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Whole dollars for headline totals; cents for rates and line items. */
export function formatDollars(amount: number, options: { cents?: boolean } = {}): string {
  return options.cents ? CENTS.format(amount) : WHOLE.format(amount);
}

/** "+$1,200" / "−$300": a signed variance, with a real minus sign. */
export function formatSignedDollars(amount: number): string {
  // Round before taking the sign: 40 cents of variance displays as "$0", and "+$0" would claim
  // a direction the whole-dollar figure does not have.
  const whole = Math.round(Math.abs(amount));
  if (whole === 0) return formatDollars(0);
  return `${amount > 0 ? '+' : '−'}${formatDollars(whole)}`;
}

/** Hours to one decimal, dropping a trailing ".0". */
export function formatHours(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}h`;
}
