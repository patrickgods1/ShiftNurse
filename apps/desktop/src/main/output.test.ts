import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dirs = vi.hoisted(() => ({ userData: '' }));
const behaviour = vi.hoisted(() => ({
  load: async (_path: string): Promise<void> => {},
}));
const created = vi.hoisted(() => ({ options: [] as unknown[], pdf: [] as unknown[] }));
const region = vi.hoisted(() => ({ code: 'US' }));

vi.mock('electron', () => {
  class FakeWindow {
    webContents = {
      printToPDF: vi.fn(async (o: unknown) => {
        created.pdf.push(o);
        return Buffer.from('%PDF');
      }),
    };
    loadFile = vi.fn(async (p: string) => behaviour.load(p));
    destroy = vi.fn();
    constructor(options: unknown) {
      created.options.push(options);
    }
  }
  return {
    app: { getPath: () => dirs.userData, getLocaleCountryCode: () => region.code },
    BrowserWindow: FakeWindow,
  };
});

import { ScheduleView, type Unit } from '@shiftnurse/core';
import { clearPrintScratch, htmlToPdf, renderOutput } from './output.js';

const FAILED = 'The PDF could not be produced. Try a shorter date range, or export CSV instead.';

describe('PDF rendering', () => {
  beforeEach(() => {
    dirs.userData = mkdtempSync(join(tmpdir(), 'sn-output-'));
    created.options.length = 0;
    created.pdf.length = 0;
    behaviour.load = async () => {};
  });
  afterEach(() => {
    region.code = 'US';
    rmSync(dirs.userData, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('prints from a private file with scripts off and leaves nothing behind', async () => {
    let loadedPath = '';
    let heldWhileLoading = '';
    behaviour.load = async (p) => {
      loadedPath = p;
      heldWhileLoading = readFileSync(p, 'utf8');
    };
    const pdf = await htmlToPdf('<p>Ana Ruiz</p>', false, 'letter');
    expect(pdf.toString()).toBe('%PDF');
    expect(
      (created.options[0] as { webPreferences: { javascript: boolean } }).webPreferences.javascript,
    ).toBe(false);
    expect(loadedPath.startsWith(join(dirs.userData, 'print'))).toBe(true);
    expect(loadedPath.endsWith('document.html')).toBe(true);
    expect(heldWhileLoading).toBe('<p>Ana Ruiz</p>');
    expect(readdirSync(join(dirs.userData, 'print'))).toEqual([]);
  });

  it('turns a failed render into words that carry none of the document', async () => {
    behaviour.load = async () => {
      throw new Error("ERR_FAILED (-2) loading 'file:///…' %3Cp%3EAna Ruiz, employee 10442");
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(htmlToPdf('<p>Ana Ruiz</p>', true, 'letter')).rejects.toThrow(
      expect.objectContaining({ message: FAILED }),
    );
    expect(readdirSync(join(dirs.userData, 'print'))).toEqual([]);
    for (const call of logged.mock.calls) expect(call.join(' ')).not.toContain('Ana');
  });

  it('asks the print engine for A4 when the unit prints on A4', async () => {
    await htmlToPdf('<p>Ana Ruiz</p>', false, 'a4');
    await htmlToPdf('<p>Ana Ruiz</p>', false, 'letter');
    expect(created.pdf.map((o) => (o as { pageSize: string }).pageSize)).toEqual(['A4', 'Letter']);
  });

  it('gives the fixed words when the print folder cannot even be made', async () => {
    // A file where the folder should be: the failure message would name the userData path.
    writeFileSync(join(dirs.userData, 'print'), 'in the way');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(htmlToPdf('<p>Ana Ruiz</p>', false, 'letter')).rejects.toThrow(
      expect.objectContaining({ message: FAILED }),
    );
    for (const call of logged.mock.calls) expect(call.join(' ')).not.toContain(dirs.userData);
  });

  describe('one paper for the page and the print engine', () => {
    const view = new ScheduleView({
      period: {
        id: 'p1',
        unitId: 'u1',
        name: 'March',
        startDate: '2026-03-01',
        endDate: '2026-03-14',
        status: 'draft',
      } as never,
      assignments: [],
      nurses: [],
      shiftTypes: [],
    });
    const unit = (paperSize?: 'letter' | 'a4') =>
      ({ id: 'u1', name: '4A', unitType: 'Med', ...(paperSize ? { paperSize } : {}) }) as Unit;
    const render = async (format: 'pdf-grid' | 'pdf-nurses', paperSize?: 'letter' | 'a4') => {
      let html = '';
      behaviour.load = async (p) => {
        html = readFileSync(p, 'utf8');
      };
      await renderOutput(
        { schedule: view, ctx: { unit: unit(paperSize), version: undefined, status: 'draft' } },
        format,
      );
      return { html, pageSize: (created.pdf.at(-1) as { pageSize: string }).pageSize };
    };

    it('follows a German computer to A4 on the grid when the unit has not chosen', async () => {
      region.code = 'DE';
      const out = await render('pdf-grid');
      expect(out.html).toContain('size: A4 landscape');
      expect(out.pageSize).toBe('A4');
    });

    it("lets the unit's Letter beat a German computer on the nurse sheets", async () => {
      region.code = 'DE';
      const out = await render('pdf-nurses', 'letter');
      expect(out.html).toContain('size: letter portrait');
      expect(out.pageSize).toBe('Letter');
    });
  });

  it('clears print files left by a crash at the next launch', () => {
    const job = join(dirs.userData, 'print', 'job-x');
    mkdirSync(job, { recursive: true });
    writeFileSync(join(job, 'document.html'), '<p>Ana Ruiz</p>');
    clearPrintScratch();
    expect(existsSync(join(dirs.userData, 'print'))).toBe(false);
  });
});
