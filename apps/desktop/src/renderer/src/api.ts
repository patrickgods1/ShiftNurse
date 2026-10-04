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
  IncompatibilityGroupInput,
  IncompatibilityGroupPatch,
  NurseInput,
  NursePatch,
  PreferenceInput,
} from '../../shared/api.js';
import { invalidateUnitDerived, invalidateUnitDerivedAnyUnit } from './period-cache.js';

export const api = window.shiftnurse;

export const queryKeys = {
  units: () => ['units'] as const,
  dashboard: (unitId: Id) => ['dashboard', unitId] as const,
  nurses: (unitId: Id) => ['nurses', unitId] as const,
  nurse: (id: Id) => ['nurse', id] as const,
  shiftTypes: (unitId: Id) => ['shiftTypes', unitId] as const,
  periods: (unitId: Id) => ['periods', unitId] as const,
  assignments: (periodId: Id) => ['assignments', periodId] as const,
  timeOff: (unitId: Id, status?: TimeOffStatus) => ['timeOff', unitId, status ?? 'all'] as const,
  appInfo: () => ['appInfo'] as const,
  update: () => ['update'] as const,
  credentials: () => ['credentials'] as const,
  nurseCredentials: (nurseId: Id) => ['nurseCredentials', nurseId] as const,
  preferences: (nurseId: Id) => ['preferences', nurseId] as const,
  incompatibility: (unitId: Id) => ['incompatibility', unitId] as const,
};

export function useUnits() {
  return useQuery({ queryKey: queryKeys.units(), queryFn: () => api.units.list() });
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
      // Who is on the roster, and with what contract, feeds every schedule check.
      invalidateUnitDerived(queryClient, unitId);
    } else {
      void queryClient.invalidateQueries({ queryKey: queryKeys.nurses('').slice(0, 1) });
      invalidateUnitDerivedAnyUnit(queryClient);
    }
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
      invalidateUnitDerivedAnyUnit(queryClient);
    },
  });
}

function useInvalidateNurseCredentials(nurseId: Id | undefined) {
  const queryClient = useQueryClient();
  return () => {
    if (nurseId !== undefined) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.nurseCredentials(nurseId) });
      // A credential decides who may fill a requirement, in every period.
      invalidateUnitDerivedAnyUnit(queryClient);
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
        invalidateUnitDerivedAnyUnit(queryClient);
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
      invalidateUnitDerived(queryClient, unitId);
    } else {
      invalidateUnitDerivedAnyUnit(queryClient);
    }
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
