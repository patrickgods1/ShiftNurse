/**
 * Which paper a printout is laid out for (decision D25). A unit can choose; until it does, the
 * computer's region decides, because a hospital in Europe that gets Letter PDFs prints them
 * cropped or scaled. One value feeds both the stylesheet's `@page` and Chromium's `pageSize`,
 * so the two can never disagree. Electron-free: `output.ts` reads the region and passes it in.
 */

import type { PaperSize } from '@shiftnurse/core';

/** ISO 3166 regions where Letter is the norm; everything else prints A4. */
export const LETTER_REGIONS: ReadonlySet<string> = new Set([
  'US',
  'CA',
  'MX',
  'PH',
  'PR',
  'CL',
  'CO',
  'VE',
  'CR',
  'GT',
  'PA',
  'DO',
  'SV',
  'NI',
  'BZ',
]);

/** An empty region (the OS reports none) keeps Letter: the app's behaviour before D25. */
export function paperForRegion(region: string): PaperSize {
  const code = region.trim().toUpperCase();
  return code === '' || LETTER_REGIONS.has(code) ? 'letter' : 'a4';
}

export function cssPageSize(paper: PaperSize): 'letter' | 'A4' {
  return paper === 'a4' ? 'A4' : 'letter';
}

export function pdfPageSize(paper: PaperSize): 'Letter' | 'A4' {
  return paper === 'a4' ? 'A4' : 'Letter';
}
