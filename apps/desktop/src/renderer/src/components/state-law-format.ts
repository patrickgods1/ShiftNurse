/**
 * Turns a preset's summary — one paragraph of statute, written as sentences — into lines a
 * manager can scan, without rewriting the text in core, which the tests there quote.
 *
 * A sentence ends at ". " (or "? ", "! ") before a capital, a digit or an opening quote. Legal
 * citations are full of periods that are not ends: "Conn. Gen. Stat.", "W. Va. Code", "38 U.S.C.",
 * "Art. 13". Any abbreviation of one letter or with an inner dot is kept together, and the few
 * multi-letter ones the presets use are listed; a split inside a citation would read as a typo
 * in the law.
 */

const ABBREVIATIONS = new Set(['Conn', 'Gen', 'Stat', 'Minn', 'Va', 'Tex', 'Lab', 'Art', 'Arts']);

function isAbbreviation(wordBeforeDot: string): boolean {
  return (
    wordBeforeDot.length === 1 || wordBeforeDot.includes('.') || ABBREVIATIONS.has(wordBeforeDot)
  );
}

export function summarySentences(summary: string): string[] {
  const text = summary.trim();
  const lines: string[] = [];
  let start = 0;
  const end = /[.?!]["”)]* (?=["“(A-Z0-9])/g;
  for (let m = end.exec(text); m !== null; m = end.exec(text)) {
    const boundary = m.index + m[0].length;
    const before = text.slice(start, m.index);
    const word = /[A-Za-z.]+$/.exec(before)?.[0] ?? '';
    if (m[0].startsWith('.') && isAbbreviation(word)) continue;
    lines.push(text.slice(start, boundary).trim());
    start = boundary;
  }
  if (start < text.length) lines.push(text.slice(start).trim());
  return lines;
}
