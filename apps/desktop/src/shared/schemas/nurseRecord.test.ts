import { describe, expect, it } from 'vitest';
import { API_SCHEMAS } from './index.js';

describe('a record export arriving over IPC', () => {
  const { exportToFile } = API_SCHEMAS.nurseRecord;

  it('accepts a nurse, two dates and a format of csv or pdf', () => {
    expect(exportToFile.safeParse(['n-1', '2026-01-01', '2026-03-31', 'pdf']).success).toBe(true);
    expect(exportToFile.safeParse(['n-1', '2026-01-01', '2026-03-31', 'csv']).success).toBe(true);
  });

  it('refuses an xlsx request, or a date that is not one', () => {
    expect(exportToFile.safeParse(['n-1', '2026-01-01', '2026-03-31', 'xlsx']).success).toBe(false);
    expect(exportToFile.safeParse(['n-1', '2026-02-31', '2026-03-31', 'pdf']).success).toBe(false);
  });
});
