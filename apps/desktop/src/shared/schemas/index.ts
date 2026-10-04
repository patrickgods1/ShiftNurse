/**
 * Every IPC method's argument schema, keyed like `API_CHANNELS`. `ipc.ts` parses each call's
 * arguments with the matching entry before the handler runs. The `ApiSchemas` type makes a
 * method without a schema, or a schema that drifts from the contract, a compile error.
 */

import { acuitySchemas } from './acuity.js';
import { appSchemas } from './app.js';
import { backupsSchemas } from './backups.js';
import { censusSchemas } from './census.js';
import { conflictsSchemas } from './conflicts.js';
import { costSchemas } from './cost.js';
import { coverageSchemas } from './coverage.js';
import { credentialsSchemas } from './credentials.js';
import { dashboardSchemas } from './dashboard.js';
import { dayOfSchemas } from './dayOf.js';
import { exchangeSchemas } from './exchange.js';
import { fairnessSchemas } from './fairness.js';
import { holidaysSchemas } from './holidays.js';
import { incompatibilitySchemas } from './incompatibility.js';
import { leaveBiddingSchemas } from './leaveBidding.js';
import { nursesSchemas } from './nurses.js';
import { outputSchemas } from './output.js';
import { overtimeVolunteersSchemas } from './overtimeVolunteers.js';
import { periodsSchemas } from './periods.js';
import { preferencesSchemas } from './preferences.js';
import type { ApiSchemas } from './primitives.js';
import { publishSchemas } from './publish.js';
import { rosterSchemas } from './roster.js';
import { rulesSchemas } from './rules.js';
import { scheduleSchemas } from './schedule.js';
import { setupSchemas } from './setup.js';
import { shiftTypesSchemas } from './shiftTypes.js';
import { solverSchemas } from './solver.js';
import { solverSettingsSchemas } from './solverSettings.js';
import { timeOffSchemas } from './timeOff.js';
import { unitsSchemas } from './units.js';

export const API_SCHEMAS: ApiSchemas = {
  app: appSchemas,
  units: unitsSchemas,
  setup: setupSchemas,
  dashboard: dashboardSchemas,
  nurses: nursesSchemas,
  credentials: credentialsSchemas,
  preferences: preferencesSchemas,
  incompatibility: incompatibilitySchemas,
  overtimeVolunteers: overtimeVolunteersSchemas,
  leaveBidding: leaveBiddingSchemas,
  shiftTypes: shiftTypesSchemas,
  coverage: coverageSchemas,
  holidays: holidaysSchemas,
  acuity: acuitySchemas,
  census: censusSchemas,
  roster: rosterSchemas,
  periods: periodsSchemas,
  schedule: scheduleSchemas,
  publish: publishSchemas,
  output: outputSchemas,
  backups: backupsSchemas,
  solver: solverSchemas,
  solverSettings: solverSettingsSchemas,
  rules: rulesSchemas,
  fairness: fairnessSchemas,
  cost: costSchemas,
  timeOff: timeOffSchemas,
  conflicts: conflictsSchemas,
  exchange: exchangeSchemas,
  dayOf: dayOfSchemas,
};
