/**
 * A preset's summary is one long paragraph of statute; the manager reads it as a list, one
 * sentence per line, and the split must never cut a citation in half.
 */

import { JURISDICTION_PRESETS } from '@shiftnurse/core';
import { describe, expect, it } from 'vitest';
import { summarySentences } from './state-law-format.js';

describe('splitting a law summary into sentences', () => {
  it('gives one line per sentence', () => {
    expect(
      summarySentences(
        'No mandatory overtime (RCW 49.28.140), outside an emergency. Record those on the shift as "Emergency: …". There are no hour caps.',
      ),
    ).toEqual([
      'No mandatory overtime (RCW 49.28.140), outside an emergency.',
      'Record those on the shift as "Emergency: …".',
      'There are no hour caps.',
    ]);
  });

  it('keeps a statute citation on one line', () => {
    const cases: [string, number][] = [
      [
        'No hospital may require it (Conn. Gen. Stat. § 19a-490l): past a shift. A nurse may volunteer.',
        2,
      ],
      ['Minn. Stat. § 181.275 protects a nurse. Nursing facilities are not covered.', 2],
      [
        'A hospital may not mandate overtime (W. Va. Code § 21-5F-3). Required or volunteered, a nurse rests.',
        2,
      ],
      ['Anything more is voluntary (N.J.S.A. 34:11-56a34). The exception is an emergency.', 2],
      ['A last resort (R.I. Gen. Laws § 23-17.20-3). Voluntary overtime is not limited.', 2],
      [
        'A nurse may refuse (Tex. Health & Safety Code § 258.003). Time to hand over does not count.',
        2,
      ],
      ['Sick leave accrues (Lab. Code § 246(b)): the minimum. A plan can replace it.', 2],
      [
        '38 U.S.C. § 7459 forbids more. Contract terms come from the Master Agreement Art. 13–14: 11 hours. Contract nurses may be covered.',
        3,
      ],
    ];
    for (const [text, sentences] of cases) {
      const lines = summarySentences(text);
      expect(lines, text).toHaveLength(sentences);
      expect(lines.join(' ')).toBe(text);
    }
  });

  it('loses nothing from any shipped preset', () => {
    for (const preset of Object.values(JURISDICTION_PRESETS)) {
      const lines = summarySentences(preset.summary);
      expect(lines.join(' ')).toBe(preset.summary);
      for (const line of lines) {
        expect(line, preset.label).not.toMatch(/\b(Conn|Gen|Stat|Minn|Va|Tex|Lab|Art|Arts)\.$/);
        expect(line, preset.label).not.toMatch(/\b[A-Z]\.$/);
      }
    }
  });
});
