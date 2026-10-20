/**
 * The renderer's single point of contact with `window.shiftnurse`, plus the React Query hooks
 * built on it. Centralising the query keys here means a page never invents its own cache key
 * spelling, which is how two components end up looking at (and invalidating) different caches
 * for the same data.
 */

import type {
  Credential,
  Id,
  IsoDate,
  NurseCredential,
  RosterCsvRow,
  TimeOffStatus,
} from '@shiftnurse/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AvailabilityBlockInput,
  AvailabilityBlockPatch,
  IncompatibilityGroupInput,
  IncompatibilityGroupPatch,
  NurseInput,
  NursePatch,
  OvertimeVolunteerInput,
  OvertimeVolunteerPatch,
  PreceptorshipInput,
  PreceptorshipPatch,
  PreferenceInput,
  RestWaiverInput,
} from '../../shared/api.js';
import { afterConfigChange } from './period-cache.js';
import { queryRoots } from './query-roots.js';

export const api = window.shiftnurse;

export const queryKeys = {
  units: () => [...queryRoots.units] as const,
  homeUnit: () => [...queryRoots.units, 'home'] as const,
  dashboard: (unitId: Id) => [...queryRoots.dashboard, unitId] as const,
  nurses: (unitId: Id) => [...queryRoots.nurses, unitId] as const,
  nurse: (id: Id) => [...queryRoots.nurse, id] as const,
  shiftTypes: (unitId: Id) => [...queryRoots.shiftTypes, unitId] as const,
  periods: (unitId: Id) => [...queryRoots.periods, unitId] as const,
  assignments: (periodId: Id) => [...queryRoots.assignments, periodId] as const,
  timeOff: (unitId: Id, status?: TimeOffStatus) =>
    [...queryRoots.timeOff, unitId, status ?? 'all'] as const,
  appInfo: () => [...queryRoots.appInfo] as const,
  update: () => [...queryRoots.update] as const,
  credentials: () => [...queryRoots.credentials] as const,
  nurseCredentials: (nurseId: Id) => [...queryRoots.nurseCredentials, nurseId] as const,
  preferences: (nurseId: Id) => [...queryRoots.preferences, nurseId] as const,
  incompatibility: (unitId: Id) => [...queryRoots.incompatibility, unitId] as const,
  overtimeVolunteers: (unitId: Id) => [...queryRoots.overtimeVolunteers, unitId] as const,
  preceptorships: (unitId: Id) => [...queryRoots.preceptorships, unitId] as const,
  restWaivers: (unitId: Id) => [...queryRoots.restWaivers, unitId] as const,
  availabilityBlocks: (unitId: Id) => [...queryRoots.availabilityBlocks, unitId] as const,
};

export function useUnits() {
  return useQuery({ queryKey: queryKeys.units(), queryFn: () => api.units.list() });
}

/** The unit the app opens, by id; `useUnits` is alphabetical and only for pickers. */
export function useHomeUnit() {
  return useQuery({ queryKey: queryKeys.homeUnit(), queryFn: () => api.units.home() });
}

export function useDashboard(unitId: Id | undefined) {
  return useQuery({
    queryKey: queryKeys.dashboard(unitId ?? ''),
    queryFn: () => api.dashboard.summary(unitId as Id),
    enabled: unitId !== undefined,
  });
}

export function useNurses(unitId: Id | undefined) {
  return useQuery({
    queryKey: queryKeys.nurses(unitId ?? ''),
    queryFn: () => api.nurses.list(unitId as Id),
    enabled: unitId !== undefined,
  });
}

export function useShiftTypes(unitId: Id | undefined) {
  return useQuery({
    queryKey: queryKeys.shiftTypes(unitId ?? ''),
    queryFn: () => api.shiftTypes.list(unitId as Id),
    enabled: unitId !== undefined,
  });
}

export function usePeriods(unitId: Id | undefined) {
  return useQuery({
    queryKey: queryKeys.periods(unitId ?? ''),
    queryFn: () => api.periods.list(unitId as Id),
    enabled: unitId !== undefined,
  });
}

export function useAssignments(periodId: Id | undefined) {
  return useQuery({
    queryKey: queryKeys.assignments(periodId ?? ''),
    queryFn: () => api.periods.assignments(periodId as Id),
    enabled: periodId !== undefined,
  });
}

export function useTimeOff(unitId: Id | undefined, status?: TimeOffStatus) {
  return useQuery({
    queryKey: queryKeys.timeOff(unitId ?? '', status),
    queryFn: () => api.timeOff.list(unitId as Id, status),
    enabled: unitId !== undefined,
  });
}

export function useAppInfo() {
  return useQuery({ queryKey: queryKeys.appInfo(), queryFn: () => api.app.info() });
}

/**
 * A newer release, if main's launch check found one. The check runs in the background after
 * the window opens, so this asks again for a few minutes rather than once at first paint.
 */
export function useAvailableUpdate() {
  return useQuery({
    queryKey: queryKeys.update(),
    queryFn: () => api.app.update(),
    refetchInterval: (query) =>
      query.state.data || query.state.dataUpdateCount > 10 ? false : 30_000,
  });
}

// ---------------------------------------------------------------------------
// Nurses
// ---------------------------------------------------------------------------

export function useNurse(id: Id | undefined) {
  return useQuery({
    queryKey: queryKeys.nurse(id ?? ''),
    queryFn: () => api.nurses.get(id as Id),
    enabled: id !== undefined,
  });
}

/**
 * Every roster mutation invalidates the unit's nurse list and dashboard (counts/expiring
 * credentials there can shift) rather than trying to patch the cache by hand — the roster is
 * small enough that a refetch is cheap, and a hand-patched cache is exactly the kind of thing
 * that quietly drifts from the database.
 */
function useInvalidateRoster(unitId: Id | undefined) {
  const queryClient = useQueryClient();
  return () => {
    if (unitId !== undefined) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.nurses(unitId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(unitId) });
    } else {
      void queryClient.invalidateQueries({ queryKey: queryRoots.nurses });
    }
    // Who is on the roster, and with what contract, feeds every schedule check.
    afterConfigChange(queryClient);
  };
}

export function useCreateNurse(unitId: Id | undefined) {
  const invalidate = useInvalidateRoster(unitId);
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (input: NurseInput) => api.nurses.create(input),
    onSuccess: invalidate,
  });
}

export function useUpdateNurse(unitId: Id | undefined) {
  const invalidate = useInvalidateRoster(unitId);
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ id, patch }: { id: Id; patch: NursePatch }) => api.nurses.update(id, patch),
    onSuccess: (nurse) => {
      invalidate();
      void queryClient.invalidateQueries({ queryKey: queryKeys.nurse(nurse.id) });
    },
  });
}

export function useDeactivateNurse(unitId: Id | undefined) {
  const invalidate = useInvalidateRoster(unitId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: Id) => api.nurses.deactivate(id),
    onSuccess: (nurse) => {
      invalidate();
      void queryClient.invalidateQueries({ queryKey: queryKeys.nurse(nurse.id) });
    },
  });
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export function useCredentialCatalogue() {
  return useQuery({ queryKey: queryKeys.credentials(), queryFn: () => api.credentials.list() });
}

export function useNurseCredentials(nurseId: Id | undefined) {
  return useQuery({
    queryKey: queryKeys.nurseCredentials(nurseId ?? ''),
    queryFn: () => api.credentials.forNurse(nurseId as Id),
    enabled: nurseId !== undefined,
  });
}

export function useCreateCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<Credential, 'id'>) => api.credentials.create(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.credentials() });
      afterConfigChange(queryClient);
    },
  });
}

function useInvalidateNurseCredentials(nurseId: Id | undefined) {
  const queryClient = useQueryClient();
  return () => {
    if (nurseId !== undefined) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.nurseCredentials(nurseId) });
      // A credential decides who may fill a requirement, in every period.
      afterConfigChange(queryClient);
    }
  };
}

export function useGrantCredential(nurseId: Id | undefined) {
  const invalidate = useInvalidateNurseCredentials(nurseId);
  return useMutation({
    mutationFn: (input: Omit<NurseCredential, 'id'>) => api.credentials.grant(input),
    onSuccess: invalidate,
  });
}

export function useUpdateCredentialExpiry(nurseId: Id | undefined) {
  const invalidate = useInvalidateNurseCredentials(nurseId);
  return useMutation({
    mutationFn: ({ id, expiresOn }: { id: Id; expiresOn: IsoDate | undefined }) =>
      api.credentials.updateExpiry(id, expiresOn),
    onSuccess: invalidate,
  });
}

export function useRevokeCredential(nurseId: Id | undefined) {
  const invalidate = useInvalidateNurseCredentials(nurseId);
  return useMutation({
    mutationFn: (id: Id) => api.credentials.revoke(id),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export function useNursePreferences(nurseId: Id | undefined) {
  return useQuery({
    queryKey: queryKeys.preferences(nurseId ?? ''),
    queryFn: () => api.preferences.forNurse(nurseId as Id),
    enabled: nurseId !== undefined,
  });
}

export function useReplacePreferences(nurseId: Id | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (preferences: PreferenceInput[]) =>
      api.preferences.replace(nurseId as Id, preferences),
    onSuccess: () => {
      if (nurseId !== undefined) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.preferences(nurseId) });
        // Preferences are what "against preference" and fairness are judged by.
        afterConfigChange(queryClient);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Incompatible staff
// ---------------------------------------------------------------------------

export function useIncompatibilityGroups(unitId: Id | undefined) {
  return useQuery({
    queryKey: queryKeys.incompatibility(unitId ?? ''),
    queryFn: () => api.incompatibility.list(unitId as Id),
    enabled: unitId !== undefined,
  });
}

/**
 * A group changes what every schedule check says about the people in it, so the grid's
 * validation, Generate's candidates, conflicts, backfills and exchanges all refresh with it.
 */
function useInvalidateIncompatibility(unitId: Id | undefined) {
  const queryClient = useQueryClient();
  return () => {
    if (unitId !== undefined) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.incompatibility(unitId) });
    }
    afterConfigChange(queryClient);
  };
}

export function useCreateIncompatibilityGroup(unitId: Id | undefined) {
  const invalidate = useInvalidateIncompatibility(unitId);
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ input, reason }: { input: IncompatibilityGroupInput; reason: string }) =>
      api.incompatibility.create(input, reason),
    onSuccess: invalidate,
  });
}

export function useUpdateIncompatibilityGroup(unitId: Id | undefined) {
  const invalidate = useInvalidateIncompatibility(unitId);
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({
      id,
      patch,
      reason,
    }: {
      id: Id;
      patch: IncompatibilityGroupPatch;
      reason: string;
    }) => api.incompatibility.update(id, patch, reason),
    onSuccess: invalidate,
  });
}

export function useRemoveIncompatibilityGroup(unitId: Id | undefined) {
  const invalidate = useInvalidateIncompatibility(unitId);
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ id, reason }: { id: Id; reason: string }) =>
      api.incompatibility.remove(id, reason),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Overtime volunteers
// ---------------------------------------------------------------------------

export function useOvertimeVolunteers(unitId: Id | undefined) {
  return useQuery({
    queryKey: queryKeys.overtimeVolunteers(unitId ?? ''),
    queryFn: () => api.overtimeVolunteers.list(unitId as Id),
    enabled: unitId !== undefined,
  });
}

/**
 * An offer decides whether an overtime shift is voluntary, so the grid's validation, Generate's
 * candidates, conflicts and the day-of replacement list all refresh with it.
 */
function useInvalidateOvertimeVolunteers(unitId: Id) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.overtimeVolunteers(unitId) });
    afterConfigChange(queryClient);
  };
}

export function useCreateOvertimeVolunteer(unitId: Id) {
  const invalidate = useInvalidateOvertimeVolunteers(unitId);
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (input: OvertimeVolunteerInput) => api.overtimeVolunteers.create(input),
    onSuccess: invalidate,
  });
}

export function useUpdateOvertimeVolunteer(unitId: Id) {
  const invalidate = useInvalidateOvertimeVolunteers(unitId);
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ id, patch }: { id: Id; patch: OvertimeVolunteerPatch }) =>
      api.overtimeVolunteers.update(id, patch),
    onSuccess: invalidate,
  });
}

export function useRemoveOvertimeVolunteer(unitId: Id) {
  const invalidate = useInvalidateOvertimeVolunteers(unitId);
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (id: Id) => api.overtimeVolunteers.remove(id),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Orientation (preceptorships)
// ---------------------------------------------------------------------------

export function usePreceptorships(unitId: Id | undefined) {
  return useQuery({
    queryKey: queryKeys.preceptorships(unitId ?? ''),
    queryFn: () => api.preceptorships.list(unitId as Id),
    enabled: unitId !== undefined,
  });
}

/** An orientation changes which shifts the grid flags, so validation and Generate refresh too. */
function useInvalidatePreceptorships(unitId: Id) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.preceptorships(unitId) });
    afterConfigChange(queryClient);
  };
}

export function useCreatePreceptorship(unitId: Id) {
  const invalidate = useInvalidatePreceptorships(unitId);
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (input: PreceptorshipInput) => api.preceptorships.create(input),
    onSuccess: invalidate,
  });
}

export function useUpdatePreceptorship(unitId: Id) {
  const invalidate = useInvalidatePreceptorships(unitId);
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ id, patch }: { id: Id; patch: PreceptorshipPatch }) =>
      api.preceptorships.update(id, patch),
    onSuccess: invalidate,
  });
}

export function useRemovePreceptorship(unitId: Id) {
  const invalidate = useInvalidatePreceptorships(unitId);
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (id: Id) => api.preceptorships.remove(id),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Rest waivers
// ---------------------------------------------------------------------------

export function useRestWaivers(unitId: Id | undefined) {
  return useQuery({
    queryKey: queryKeys.restWaivers(unitId ?? ''),
    queryFn: () => api.restWaivers.list(unitId as Id),
    enabled: unitId !== undefined,
  });
}

/** A waiver changes which turnarounds the grid flags, so validation and Generate refresh too. */
function useInvalidateRestWaivers(unitId: Id) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.restWaivers(unitId) });
    afterConfigChange(queryClient);
  };
}

export function useCreateRestWaiver(unitId: Id) {
  const invalidate = useInvalidateRestWaivers(unitId);
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (input: RestWaiverInput) => api.restWaivers.create(input),
    onSuccess: invalidate,
  });
}

export function useRemoveRestWaiver(unitId: Id) {
  const invalidate = useInvalidateRestWaivers(unitId);
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ id, reason }: { id: Id; reason: string }) => api.restWaivers.remove(id, reason),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Accommodations
// ---------------------------------------------------------------------------

export function useAvailabilityBlocks(unitId: Id | undefined) {
  return useQuery({
    queryKey: queryKeys.availabilityBlocks(unitId ?? ''),
    queryFn: () => api.availabilityBlocks.list(unitId as Id),
    enabled: unitId !== undefined,
  });
}

/** A block changes which shifts the grid flags and Generate may use, so those refresh too. */
function useInvalidateAvailabilityBlocks(unitId: Id) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.availabilityBlocks(unitId) });
    afterConfigChange(queryClient);
  };
}

export function useCreateAvailabilityBlock(unitId: Id) {
  const invalidate = useInvalidateAvailabilityBlocks(unitId);
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (input: AvailabilityBlockInput) => api.availabilityBlocks.create(input),
    onSuccess: invalidate,
  });
}

export function useUpdateAvailabilityBlock(unitId: Id) {
  const invalidate = useInvalidateAvailabilityBlocks(unitId);
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({
      id,
      patch,
      reason,
    }: {
      id: Id;
      patch: AvailabilityBlockPatch;
      reason: string;
    }) => api.availabilityBlocks.update(id, patch, reason),
    onSuccess: invalidate,
  });
}

export function useRemoveAvailabilityBlock(unitId: Id) {
  const invalidate = useInvalidateAvailabilityBlocks(unitId);
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ id, reason }: { id: Id; reason: string }) =>
      api.availabilityBlocks.remove(id, reason),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Roster import/export
// ---------------------------------------------------------------------------

export function usePickRosterImportFile() {
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (unitId: Id) => api.roster.pickImportFile(unitId),
  });
}

export function useImportRosterRows(unitId: Id | undefined) {
  const invalidate = useInvalidateRoster(unitId);
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (rows: RosterCsvRow[]) => api.roster.importRows(unitId as Id, rows),
    onSuccess: invalidate,
  });
}

export function useExportRosterToFile() {
  return useMutation({ mutationFn: (unitId: Id) => api.roster.exportToFile(unitId) });
}
