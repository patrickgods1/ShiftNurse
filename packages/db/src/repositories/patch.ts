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

import type { Id } from '@shiftnurse/core';
import { recordAudit, recordAuditStrict } from '../audit.js';
import type { DbLike } from '../client.js';

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

/**
 * Refuse a whole object (not a patch) that carries a key its type does not. Saves like the
 * conflict policy and solver settings copy named fields out of an IPC payload, so a stray key
 * would otherwise vanish silently — the same hidden bug `patchOf` exists to surface. The
 * allow-list is a `PatchKeys` record for the same reason: a field added to the type later must
 * be added here too, or the code does not compile.
 */
export function assertKeys<T extends object>(
  value: T,
  allowed: PatchKeys<T>,
  entity: string,
): void {
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(allowed, key)) {
      throw new Error(`A ${entity} cannot include '${key}'`);
    }
  }
}

export interface AuditedUpdate<Entity, Patch extends object> {
  id: Id;
  /** The audit row's entity type, e.g. 'pay_rate'. */
  entityType: string;
  /** The noun `patchOf` uses in its refusal, e.g. 'pay rate'. */
  entityLabel: string;
  allowed: PatchKeys<Patch>;
  patch: Patch;
  read(id: Id): Entity | undefined;
  write(id: Id, values: Partial<Patch>): void;
  /** The exact message for a missing row; it reaches the manager verbatim. */
  notFound: string;
  /** Throw to refuse; runs after the key check and before anything is written. */
  validate?(values: Partial<Patch>, before: Entity): void;
  /**
   * True when this edit is one that must be explained (a looser ratio ceiling): the audit row is
   * then written with `recordAuditStrict`, which refuses a blank `reason`. Refuse in `validate`
   * first, in the manager's words — the strict audit runs after the write, as a backstop.
   */
  reasonRequired?(values: Partial<Patch>, before: Entity): boolean;
  /** Why the change was made; recorded on the audit row whenever it is given. */
  reason?: string;
  actor: string;
}

/**
 * Read, check, write, re-read and audit one row's update — the shape every repository updater
 * shares. It lives here so the audit contract (a `before` and an `after` on every update, in the
 * same call as the write) is made in one place: an updater that forgot the audit would be a
 * mutation with no record. The caller supplies only what differs per table — how to read the
 * entity, how to write the columns — and an empty patch writes nothing but is still audited
 * (the manager pressed Save).
 */
export function auditedUpdate<Entity, Patch extends object>(
  db: DbLike,
  spec: AuditedUpdate<Entity, Patch>,
): Entity {
  const { id, entityType } = spec;
  const before = spec.read(id);
  if (before === undefined) throw new Error(spec.notFound);
  const values = patchOf(spec.patch, spec.allowed, spec.entityLabel);
  spec.validate?.(values, before);
  const strict = spec.reasonRequired?.(values, before) ?? false;
  // An empty patch has no columns to set (drizzle throws); it is still the manager pressing Save.
  if (Object.keys(values).length > 0) spec.write(id, values);
  const after = spec.read(id);
  if (after === undefined) throw new Error(spec.notFound);
  const entry = { entityType, entityId: id, action: 'update' as const, actor: spec.actor, before };
  const reason = spec.reason?.trim() ? { reason: spec.reason } : {};
  if (strict) recordAuditStrict(db, { ...entry, after, ...reason }, { requireReason: true });
  else recordAudit(db, { ...entry, after, ...reason });
  return after;
}
