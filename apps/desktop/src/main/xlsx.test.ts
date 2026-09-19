import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildXlsx, columnName } from './xlsx.js';

/** Walk the local file headers and inflate each entry — enough of a zip reader to check ours. */
function readZip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let offset = 0;
  while (buf.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buf.readUInt32LE(offset + 18);
    const nameLength = buf.readUInt16LE(offset + 26);
    const extraLength = buf.readUInt16LE(offset + 28);
    const name = buf.toString('utf8', offset + 30, offset + 30 + nameLength);
    const start = offset + 30 + nameLength + extraLength;
    out.set(name, inflateRawSync(buf.subarray(start, start + compressedSize)).toString('utf8'));
    offset = start + compressedSize;
  }
  return out;
}

describe('buildXlsx', () => {
  it('names columns the way Excel does past Z', () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(columnName)).toEqual([
      'A',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA',
      'ZZ',
      'AAA',
    ]);
  });

  it('writes a readable workbook with inline strings and numeric hours', () => {
    const buf = buildXlsx([
      {
        name: 'Grid',
        rows: [
          ['name', '2026-01-04', 'hours'],
          ['Lee, Ann', 'D12*', 36],
        ],
      },
      { name: 'Shifts/Long', rows: [['employee_id', 'date', 'shift']] },
    ]);
    const parts = readZip(buf);
    expect([...parts.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]);
    const grid = parts.get('xl/worksheets/sheet1.xml')!;
    expect(grid).toContain(
      '<c r="A2" t="inlineStr"><is><t xml:space="preserve">Lee, Ann</t></is></c>',
    );
    expect(grid).toContain('<c r="C2"><v>36</v></c>');
    // The slash is illegal in a sheet name; it must be replaced, not written through.
    expect(parts.get('xl/workbook.xml')).toContain('name="Shifts Long"');
    expect(buf.subarray(buf.length - 22).readUInt32LE(0)).toBe(0x06054b50);
  });

  it('is byte-for-byte deterministic', () => {
    const rows = [
      ['a', 1],
      ['b', 2],
    ];
    expect(buildXlsx([{ name: 'S', rows }]).equals(buildXlsx([{ name: 'S', rows }]))).toBe(true);
  });
});
