/// <reference types="node" />
// The renderer's tsconfig loads no node types; this test alone reads the real README.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NOT_ENFORCED } from './limits.js';

const readme = readFileSync(
  fileURLToPath(new URL('../../../../../README.md', import.meta.url)),
  'utf8',
);

/** Curly quotes and emphasis differ between the two files; the words must not. */
function normalise(text: string): string {
  return text
    .replace(/\*\*/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The bullets under the README heading, each continuation line folded into its bullet. */
function readmeBullets(): string[] {
  const lines = readme.split('\n');
  const start = lines.findIndex((l) => l.trim() === '## What ShiftNurse does not enforce yet');
  if (start < 0) throw new Error('README has no "What ShiftNurse does not enforce yet" section');
  const bullets: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    if (line.startsWith('- ')) bullets.push(line.slice(2));
    else if (bullets.length > 0 && /^\s+\S/.test(line)) bullets[bullets.length - 1] += ` ${line}`;
  }
  return bullets.map(normalise);
}

describe('the in-app list of limits', () => {
  it('shows every limit the README says ShiftNurse does not enforce', () => {
    expect(NOT_ENFORCED.map(normalise)).toEqual(readmeBullets());
  });
});
