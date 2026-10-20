import { describe, expect, it } from 'vitest';
import { cssPageSize, paperForRegion, pdfPageSize } from './paper.js';

describe('paper size by region', () => {
  it('prints on Letter in the US and Canada', () => {
    expect(paperForRegion('US')).toBe('letter');
    expect(paperForRegion('CA')).toBe('letter');
  });

  it('prints on A4 in the UK, Germany and Australia', () => {
    expect(paperForRegion('GB')).toBe('a4');
    expect(paperForRegion('DE')).toBe('a4');
    expect(paperForRegion('AU')).toBe('a4');
  });

  it('keeps Letter when the computer reports no region', () => {
    // The app printed Letter before the paper size existed.
    expect(paperForRegion('')).toBe('letter');
  });

  it('reads the region code whatever its case', () => {
    expect(paperForRegion('us')).toBe('letter');
  });

  it('names the same paper to the stylesheet and to the PDF engine', () => {
    expect(cssPageSize('a4')).toBe('A4');
    expect(pdfPageSize('a4')).toBe('A4');
    expect(cssPageSize('letter')).toBe('letter');
    expect(pdfPageSize('letter')).toBe('Letter');
  });
});
