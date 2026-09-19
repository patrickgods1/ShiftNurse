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
  if (amount === 0) return formatDollars(0);
  const sign = amount > 0 ? '+' : '−';
  return `${sign}${formatDollars(Math.abs(amount))}`;
}

/** Hours to one decimal, dropping a trailing ".0". */
export function formatHours(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}h`;
}
