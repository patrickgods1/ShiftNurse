// @vitest-environment jsdom
/**
 * A rule, coverage, roster or pay edit changes the answer to every period's derived views. The
 * grid said "no violations" after the rules changed because only the edited list refreshed; and
 * Publish did the reverse and refetched the whole app. These tests pin both: each configuration
 * hook refreshes the derived roots, and publishing names what it refreshes.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as roster from './api.js';
import * as cfg from './api-config.js';
import * as cost from './api-cost.js';
import { costKeys } from './api-cost.js';
import { demandQueryKeys } from './api-demand.js';
import { publishKeys, usePublish } from './api-publish.js';
import { useSaveConflictPolicy } from './api-requests.js';
import { scheduleKeys } from './api-schedule.js';
import { solverKeys } from './api-solver.js';
import { type FakeBridge, installFakeBridge } from './test/fake-bridge.js';

// Every method resolves with an object carrying the ids the hooks read.
let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respondDefault({ id: 'x', unitId: 'u1', holidayId: 'h1', nurseIds: [] });
});
afterEach(() => bridge.uninstall());

const UNIT = 'u1';
const DERIVED_ROOTS: readonly (readonly string[])[] = [
  ['validation'],
  ['conflicts'],
  ['demand'],
  ['hppd'],
  ['cost', 'report'],
  ['fairness', 'report'],
  ['publish', 'alerts'],
  ['publish', 'preview'],
  ['solver', 'current'],
  ['solver', 'draft'],
  ['dayOf'],
  ['exchange'],
];

const hooks: [string, () => { mutateAsync: (v: never) => Promise<unknown> }, unknown][] = [
  ['creating a shift type', () => cfg.useCreateShiftType(), { unitId: UNIT }],
  ['editing a shift type', () => cfg.useUpdateShiftType(), { id: 'x', patch: {} }],
  ['retiring a shift type', () => cfg.useDeactivateShiftType(), 'x'],
  ['saving a coverage floor', () => cfg.useUpsertCoverage(), { unitId: UNIT }],
  ['deleting a coverage floor', () => cfg.useDeleteCoverage(), { id: 'x', unitId: UNIT }],
  ['adding a holiday', () => cfg.useCreateHoliday(), { unitId: UNIT }],
  ['editing a holiday', () => cfg.useUpdateHoliday(), { id: 'x', unitId: UNIT, patch: {} }],
  ['deleting a holiday', () => cfg.useDeleteHoliday(), { id: 'x', unitId: UNIT }],
  [
    'recording who worked a holiday',
    () => cfg.useRecordHolidayWork(),
    { holidayId: 'h1', nurseIds: [] },
  ],
  ['clearing recorded holiday work', () => cfg.useClearHolidayWork(), 'h1'],
  ['adding a year of holidays', () => cfg.useAddHolidayYear(), { unitId: UNIT, input: {} }],
  ['creating an acuity tier', () => cfg.useCreateAcuityTier(), { unitId: UNIT }],
  ['editing an acuity tier', () => cfg.useUpdateAcuityTier(), { id: 'x', patch: {} }],
  ['deleting an acuity tier', () => cfg.useDeleteAcuityTier(), { id: 'x', unitId: UNIT }],
  ['creating a ratio rule', () => cfg.useCreateRatioRule(), { unitId: UNIT }],
  ['editing a ratio rule', () => cfg.useUpdateRatioRule(), { id: 'x', patch: {} }],
  ['retiring a ratio rule', () => cfg.useDeactivateRatioRule(), 'x'],
  ['setting the HPPD target', () => cfg.useSetHppdTarget(), { unitId: UNIT, targetHours: 7 }],
  ['saving the rule set', () => cfg.useSaveRuleSet(), { unitId: UNIT, name: 'n', configs: [] }],
  ['hiring a nurse', () => roster.useCreateNurse(UNIT), {}],
  ['editing a nurse', () => roster.useUpdateNurse(UNIT), { id: 'x', patch: {} }],
  ['deactivating a nurse', () => roster.useDeactivateNurse(UNIT), 'x'],
  ['importing a roster', () => roster.useImportRosterRows(UNIT), []],
  ['adding a credential to the catalogue', () => roster.useCreateCredential(), {}],
  ['granting a credential', () => roster.useGrantCredential('n1'), {}],
  ['changing a credential expiry', () => roster.useUpdateCredentialExpiry('n1'), { id: 'x' }],
  ['revoking a credential', () => roster.useRevokeCredential('n1'), 'x'],
  ["replacing a nurse's preferences", () => roster.useReplacePreferences('n1'), []],
  ['creating a kept-apart group', () => roster.useCreateIncompatibilityGroup(UNIT), {}],
  ['editing a kept-apart group', () => roster.useUpdateIncompatibilityGroup(UNIT), { id: 'x' }],
  ['removing a kept-apart group', () => roster.useRemoveIncompatibilityGroup(UNIT), { id: 'x' }],
  ['saving the auto-resolve policy', () => useSaveConflictPolicy(UNIT), {}],
  ['creating a pay rate', () => cost.useCreatePayRate(UNIT), {}],
  ['editing a pay rate', () => cost.useUpdatePayRate(UNIT), { id: 'x', patch: {} }],
  ['deleting a pay rate', () => cost.useDeletePayRate(UNIT), 'x'],
  ['creating a differential', () => cost.useCreateDifferential(UNIT), {}],
  ['editing a differential', () => cost.useUpdateDifferential(UNIT), { id: 'x', patch: {} }],
  ['deleting a differential', () => cost.useDeleteDifferential(UNIT), 'x'],
  ['creating an overtime rule', () => cost.useCreateOvertimeRule(UNIT), {}],
  ['editing an overtime rule', () => cost.useUpdateOvertimeRule(UNIT), { id: 'x', patch: {} }],
  ['deleting an overtime rule', () => cost.useDeleteOvertimeRule(UNIT), 'x'],
];

function setup<T>(useHook: () => T) {
  const queryClient = new QueryClient();
  const spy = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(useHook, { wrapper });
  const keys = () =>
    spy.mock.calls.map(
      (call) => (call[0] as { queryKey?: readonly unknown[] } | undefined)?.queryKey,
    );
  return { result, spy, keys };
}

describe('editing configuration', () => {
  it.each(hooks)(
    "after %s, every period's derived views are asked again",
    async (_n, useHook, vars) => {
      const { result, keys } = setup(useHook);
      await act(async () => {
        await result.current.mutateAsync(vars as never);
      });
      const asked = keys().map((k) => JSON.stringify(k));
      for (const root of DERIVED_ROOTS) {
        expect(asked, `missing ${root.join('/')}`).toContain(JSON.stringify(root));
      }
    },
  );
});

describe('publishing', () => {
  it('refreshes the period and the lists it wrote, not every query in the app', async () => {
    const { result, spy, keys } = setup(() => usePublish('p1', UNIT));
    await act(async () => {
      await result.current.mutateAsync(undefined);
    });
    expect(spy.mock.calls.every((call) => call[0]?.queryKey !== undefined)).toBe(true);
    const asked = keys().map((k) => JSON.stringify(k));
    for (const key of [
      ['assignments', 'p1'],
      ['validation', 'p1'],
      ['validation'],
      ['fairness', 'report'],
      ['backups'],
      ['publish', 'versions', 'p1'],
      ['periods', UNIT],
      ['fairness', 'history', UNIT],
      ['fairness', 'trend', UNIT],
      ['dashboard', UNIT],
    ]) {
      expect(asked).toContain(JSON.stringify(key));
    }
  });
});

describe("the roots really reach the screens' own queries", () => {
  it("a coverage edit leaves another period's validation, cost, alerts and Generate batch stale", async () => {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const hook = renderHook(() => cfg.useUpsertCoverage(), { wrapper });
    const seeded = [
      scheduleKeys.validation('p1'),
      costKeys.report('p1'),
      solverKeys.current('p1'),
      solverKeys.againstDraft('p1'),
      publishKeys.alerts('p1'),
      publishKeys.preview('p1'),
      demandQueryKeys.hppd('p1'),
    ];
    for (const key of seeded) queryClient.setQueryData(key, { seeded: true });
    await act(async () => {
      await hook.result.current.mutateAsync({ unitId: UNIT } as never);
    });
    for (const key of seeded) {
      expect(queryClient.getQueryState(key)?.isInvalidated, key.join('/')).toBe(true);
    }
  });
});
