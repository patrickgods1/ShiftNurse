/**
 * The one way a repository turns a caller's partial patch into columns to write.
 *
 * Patch types are the only thing standing between an update and columns it must never touch —
 * a nurse's `unitId`, an assignment's `nurseId` or `date` — and types do not exist at runtime.
 * The renderer reaches these functions through IPC, where a payload is whatever JSON arrived,
 * so spreading a patch into a row would let `{ unitId }` move a nurse to another unit, or
 * `{ date }` move a locked shift without the lock check `moveAssignment` makes.
 *
 * Each caller passes the allowed keys as a `Record<keyof Patch, true>`: the compiler then
 * refuses a key list that drifts from the patch type in either direction. An unknown key
 * throws rather than being dropped — a payload that tries to write a column it may not is a
 * bug or an attack, and silently ignoring it would hide both.
 */

export type PatchKeys<T> = { readonly [K in keyof Required<T>]: true };

/** Keep the allowed keys the caller set (dropping `undefined`); throw on any other key. */
export function patchOf<T extends object>(
  patch: T,
  allowed: PatchKeys<T>,
  entity: string,
): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(allowed, key)) {
      throw new Error(`A ${entity} update cannot change '${key}'`);
    }
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}
