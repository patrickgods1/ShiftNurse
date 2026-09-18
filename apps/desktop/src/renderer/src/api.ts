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
import type { NurseInput, NursePatch, PreferenceInput } from '../../shared/api.js';

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
  credentials: () => ['credentials'] as const,
  nurseCredentials: (nurseId: Id) => ['nurseCredentials', nurseId] as const,
  preferences: (nurseId: Id) => ['preferences', nurseId] as const,
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
    }
  };
}

export function useCreateNurse(unitId: Id | undefined) {
  const invalidate = useInvalidateRoster(unitId);
  return useMutation({
    mutationFn: (input: NurseInput) => api.nurses.create(input),
    onSuccess: invalidate,
  });
}

export function useUpdateNurse(unitId: Id | undefined) {
  const invalidate = useInvalidateRoster(unitId);
  const queryClient = useQueryClient();
  return useMutation({
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
    },
  });
}

function useInvalidateNurseCredentials(nurseId: Id | undefined) {
  const queryClient = useQueryClient();
  return () => {
    if (nurseId !== undefined) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.nurseCredentials(nurseId) });
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
    mutationFn: (preferences: PreferenceInput[]) =>
      api.preferences.replace(nurseId as Id, preferences),
    onSuccess: () => {
      if (nurseId !== undefined) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.preferences(nurseId) });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Roster import/export
// ---------------------------------------------------------------------------

export function usePickRosterImportFile() {
  return useMutation({ mutationFn: (unitId: Id) => api.roster.pickImportFile(unitId) });
}

export function useImportRosterRows(unitId: Id | undefined) {
  const invalidate = useInvalidateRoster(unitId);
  return useMutation({
    mutationFn: (rows: RosterCsvRow[]) => api.roster.importRows(unitId as Id, rows),
    onSuccess: invalidate,
  });
}

export function useExportRosterToFile() {
  return useMutation({ mutationFn: (unitId: Id) => api.roster.exportToFile(unitId) });
}
