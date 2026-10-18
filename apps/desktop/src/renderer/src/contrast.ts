/**
 * WCAG contrast maths, and the readable chip text colour built on it.
 *
 * Shift colours are picked freely on the Settings screen (see `shift-types.tsx`); nothing stops
 * a manager choosing a pale yellow or a near-black navy. Without this, white-on-yellow or
 * black-on-navy chips would be unreadable at a glance — exactly the moment a manager is
 * scanning the grid fastest, during a shift handoff. The text colour is picked by comparing
 * the two contrast ratios, not by a luminance cut-off: a cut-off chose white for amber (2.15:1).
 */

const HEX_RE = /^#?([0-9a-f]{6})$/i;
const DARK_TEXT = '#1a1f28';
const LIGHT_TEXT = '#ffffff';

function parseHex(hex: string): [number, number, number] | undefined {
  const match = HEX_RE.exec(hex.trim());
  if (!match) return undefined;
  const value = match[1]!;
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

/** WCAG relative luminance, or undefined when `hex` is not a six-digit hex colour. */
export function relativeLuminance(hex: string): number | undefined {
  const rgb = parseHex(hex);
  if (rgb === undefined) return undefined;
  const [r, g, b] = rgb.map((channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio (1 to 21), or undefined when either colour cannot be read. */
export function contrastRatio(a: string, b: string): number | undefined {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === undefined || lb === undefined) return undefined;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** '#1a1f28' or '#ffffff', whichever has the higher contrast against `hex`; ties go to dark. */
export function readableTextColor(hex: string): string {
  const dark = contrastRatio(hex, DARK_TEXT);
  const light = contrastRatio(hex, LIGHT_TEXT);
  if (dark === undefined || light === undefined) return DARK_TEXT;
  return dark >= light ? DARK_TEXT : LIGHT_TEXT;
}
