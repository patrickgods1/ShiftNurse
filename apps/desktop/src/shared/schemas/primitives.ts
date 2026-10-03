/**
 * The building blocks every IPC argument schema is made of.
 *
 * The contract in `api.ts` is TypeScript, and TypeScript does not exist at runtime: whatever
 * JSON the renderer sends arrives in main as-is. These schemas are the runtime half of that
 * contract — `ipc.ts` parses every call's arguments with them before a handler runs, so a NaN
 * pay rate, a date of "2026-02-30" or an object where an id belongs is refused at the door
 * instead of being written and silently mispricing every shift after it.
 *
 * Values are checked for *shape and range*, never for business rules: whether a nurse may
 * work a shift, or a rate is plausible, is the repository's and the rule engine's call.
 */

import { type IsoDate, isIsoDate, type NurseRole } from '@shiftnurse/core';
import { z } from 'zod';
import type { ShiftNurseApi } from '../api.js';

type Args<F> = F extends (...args: infer P) => unknown ? P : never;

/**
 * One schema per method, parsing the method's whole argument list as a tuple. The schema's
 * output must be assignable to the method's parameters, so a schema that drifts from the
 * contract — a missing method, a field of the wrong type — is a compile error, not a gap.
 */
export type ResourceSchemas<R extends keyof ShiftNurseApi> = {
  [M in keyof ShiftNurseApi[R]]: z.ZodType<Args<ShiftNurseApi[R][M]>>;
};
export type ApiSchemas = { [R in keyof ShiftNurseApi]: ResourceSchemas<R> };

export const id = z.string().min(1, 'must be an id');

/** A calendar date the time model accepts: `YYYY-MM-DD` that does not roll over. */
export const isoDate = z.custom<IsoDate>(
  (value) => typeof value === 'string' && isIsoDate(value),
  'must be a date (YYYY-MM-DD)',
);

/** `HH:MM`, 24-hour: shift starts and similar wall-clock times. */
export const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a time (HH:MM)');

/** Dollars: zero or more, never NaN or infinite (zod numbers refuse both). */
export const money = z.number().min(0, 'must be zero or more');

/** Hours in one shift or one threshold: more than zero, at most a day. */
export const shiftHours = z.number().gt(0, 'must be more than zero').max(24, 'must be 24 or fewer');

/** Hours over a longer span (a pay period, a contract): zero or more. */
export const hours = z.number().min(0, 'must be zero or more');

/** A count of people or patients. */
export const count = z.number().int('must be a whole number').min(0, 'must be zero or more');

/** A multiplier on pay: 1 is straight time. */
export const multiplier = z.number().min(1, 'must be 1 or more');

export const nurseRole = z.enum(['RN', 'LPN', 'CNA']) satisfies z.ZodType<NurseRole>;

/** Free text a manager typed: a reason, a note, a name. Required reasons are checked by the
 * audit layer (`recordAuditStrict`), which words the refusal for the manager. */
export const text = z.string();

/** A method that takes no arguments. */
export const none = z.tuple([]);

/**
 * Every object schema is strict: an unknown key is refused, never stripped. A plain object
 * schema that forgot an optional field would otherwise drop it from the payload silently —
 * a nurse's phone number lost on save, with nothing to say why.
 */
export const object = z.strictObject;
