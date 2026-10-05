/** A nurse's record export. Nothing is cached: the file is written, not read back. */

import type { NurseRecordFormat } from '@shared/api.js';
import type { Id, IsoDate } from '@shiftnurse/core';
import { useMutation } from '@tanstack/react-query';
import { api } from './api.js';

export function useExportNurseRecord() {
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (v: { nurseId: Id; start: IsoDate; end: IsoDate; format: NurseRecordFormat }) =>
      api.nurseRecord.exportToFile(v.nurseId, v.start, v.end, v.format),
  });
}
