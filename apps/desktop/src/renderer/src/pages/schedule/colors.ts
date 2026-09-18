/**
 * Readable chip text colour from a shift type's background hex.
 *
 * Shift colours are picked freely on the Settings screen (see `shift-types.tsx`); nothing stops
 * a manager choosing a pale yellow or a near-black navy. Without this, white-on-yellow or
 * black-on-navy chips would be unreadable at a glance — exactly the moment a manager is
 * scanning the grid fastest, during a shift handoff.
 */

const HEX_RE = /^#?([0-9a-f]{6})$/i;

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

/** WCAG relative luminance. */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channels = [r, g, b].map((channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

/** Black text on light backgrounds, white on dark ones. Falls back to black on an unparsable hex. */
export function readableTextColor(hex: string): string {
  const rgb = parseHex(hex);
  if (rgb === undefined) return '#1a1f28';
  return relativeLuminance(rgb) > 0.55 ? '#1a1f28' : '#ffffff';
}
