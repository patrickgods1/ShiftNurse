/// <reference types="node" />
// The renderer's tsconfig loads no node types; this test alone reads the real stylesheet.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast.js';

const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');

/** Index of the brace that closes the block whose opening brace precedes `from`, by depth. */
function closingBrace(from: number): number {
  let depth = 1;
  for (let i = from; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return i;
  }
  throw new Error('styles.css has an unclosed block');
}

/** The `--color-*: #hex` declarations of the block that opens with `header`. */
function block(header: string): Record<string, string> {
  const start = css.indexOf(header);
  if (start < 0) throw new Error(`styles.css has no block "${header}"`);
  const body = css.slice(start + header.length, closingBrace(start + header.length));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})/g)) out[m[1]!] = m[2]!;
  return out;
}

const light = block(':root {');
const osDark = block(':root:not([data-theme="light"]) {');
const dark = block(':root[data-theme="dark"] {');
const themes: Record<string, Record<string, string>> = { light, dark };

const PAIRS: [string, string][] = [
  ['on-accent', 'accent-fill'],
  ['on-accent', 'accent-fill-hover'],
  ['on-danger', 'danger-fill'],
  ['on-danger', 'danger-fill-hover'],
  ...['text', 'text-muted', 'warn', 'danger', 'success', 'accent'].flatMap(
    (fg): [string, string][] => [
      [fg, 'bg'],
      [fg, 'surface'],
    ],
  ),
];

describe('the theme tokens', () => {
  it('the OS dark theme and the chosen dark theme are the same palette', () => {
    expect(Object.keys(dark).length).toBeGreaterThan(10);
    expect(osDark).toEqual(dark);
  });

  const cases = ['light', 'dark'].flatMap((theme) =>
    PAIRS.map(([fg, bg]) => [theme, fg, bg] as const),
  );
  it.each(cases)('in %s, %s on %s reads at 4.5 : 1 or better', (theme, fg, bg) => {
    const map = themes[theme]!;
    expect(map[fg], `${fg} defined`).toBeDefined();
    expect(map[bg], `${bg} defined`).toBeDefined();
    expect(contrastRatio(map[fg]!, map[bg]!)!).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ['light', 'accent'],
    ['dark', 'accent'],
    ['light', 'danger'],
    ['dark', 'danger'],
  ])('a fill is darker on hover, never lighter (%s %s)', (theme, name) => {
    const map = themes[theme]!;
    const on = map[`on-${name}`]!;
    expect(contrastRatio(on, map[`${name}-fill-hover`]!)!).toBeGreaterThan(
      contrastRatio(on, map[`${name}-fill`]!)!,
    );
  });
});
