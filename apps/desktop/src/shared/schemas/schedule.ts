/** Argument schemas for `schedule`. */

import { z } from 'zod';
import { id, isoDate, object, type ResourceSchemas, text } from './primitives.js';

/** Only a published period needs one; main (`requireChangeReason`) words the refusal. */
const reason = text.optional();

const createAssignmentInput = object({
  periodId: id,
  nurseId: id,
  shiftTypeId: id,
  date: isoDate,
  isLocked: z.boolean().optional(),
  isCharge: z.boolean().optional(),
  isOvertime: z.boolean().optional(),
  notes: text.optional(),
});

const moveAssignmentInput = object({
  assignmentId: id,
  nurseId: id,
  shiftTypeId: id,
  date: isoDate,
});

/** Flags and notes only: date, nurse and shift change by a move, so a patch carrying one is
 * refused here rather than stripped (CLAUDE.md, "Repository patches go through patchOf"). */
const assignmentPatch = object({
  isCharge: z.boolean().optional(),
  isOvertime: z.boolean().optional(),
  notes: text.optional(),
});

export const scheduleSchemas = {
  validate: z.tuple([id]),
  createAssignment: z.tuple([createAssignmentInput, reason]),
  moveAssignment: z.tuple([moveAssignmentInput, reason]),
  swapAssignments: z.tuple([id, id, reason]),
  updateAssignment: z.tuple([id, assignmentPatch, reason]),
  deleteAssignment: z.tuple([id, reason]),
  setLocked: z.tuple([id, z.boolean()]),
} satisfies ResourceSchemas<'schedule'>;
