/**
 * Id generation.
 *
 * Ids are generated in the application, not by the database, so the solver and CSV importers
 * can build a complete object graph in memory and persist it in one transaction — no
 * round trip per row to learn what id a record was given.
 */

import { randomUUID } from 'node:crypto';
import type { Id } from '@shiftnurse/core';

/** A prefixed UUID. The prefix makes ids self-describing in logs and audit entries. */
export function newId(prefix: string): Id {
  return `${prefix}_${randomUUID()}` as Id;
}

export const ids = {
  unit: () => newId('unit'),
  shiftType: () => newId('st'),
  nurse: () => newId('nur'),
  credential: () => newId('cred'),
  nurseCredential: () => newId('ncred'),
  credentialRequirement: () => newId('creq'),
  preference: () => newId('pref'),
  timeOff: () => newId('to'),
  shiftSwap: () => newId('swp'),
  acuityTier: () => newId('tier'),
  ratioRule: () => newId('ratio'),
  hppdTarget: () => newId('hppd'),
  census: () => newId('cen'),
  coverage: () => newId('cov'),
  holiday: () => newId('hol'),
  ruleSet: () => newId('rs'),
  period: () => newId('per'),
  assignment: () => newId('asg'),
  scheduleVersion: () => newId('ver'),
  scheduleChange: () => newId('chg'),
  callOff: () => newId('coff'),
  callAttempt: () => newId('catt'),
  payRate: () => newId('rate'),
  differential: () => newId('diff'),
  overtimeRule: () => newId('ot'),
  budget: () => newId('bud'),
  conflictPolicy: () => newId('cpol'),
  fairness: () => newId('fair'),
  audit: () => newId('aud'),
} as const;
