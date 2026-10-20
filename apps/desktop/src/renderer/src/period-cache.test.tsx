// @vitest-environment jsdom
/**
 * What each kind of write refreshes, checked against the keys the screens themselves build.
 *
 * The grid said "no violations" after the rules changed because only the edited list
 * refreshed; a time-off approval that lifted shifts from two draft periods refreshed only the
 * one on screen; and Publish once refetched the whole app. These tests seed the real keys the
 * hooks' own factories build — for a period other than the one the write names — and ask
 * whether the write marked them for refetch. They never import the helpers' root lists, so a
 * root missing from `period-cache.ts` fails here rather than passing in both places.
 */

import type { IsoDate } from '@shiftnurse/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as roster from './api.js';
import { queryKeys } from './api.js';
import * as cfg from './api-config.js';
import { configKeys } from './api-config.js';
import * as cost from './api-cost.js';
import { costKeys } from './api-cost.js';
import * as dayof from './api-dayof.js';
import { dayOfKeys } from './api-dayof.js';
import * as demand from './api-demand.js';
import { demandQueryKeys } from './api-demand.js';
import * as exchange from './api-exchange.js';
import { exchangeKeys } from './api-exchange.js';
import { fairnessQueryKeys } from './api-fairness.js';
import * as floatOut from './api-float-out.js';
import { leaveKeys } from './api-leave-balances.js';
import * as bidding from './api-leave-bidding.js';
import { leaveBidKeys } from './api-leave-bidding.js';
import { publishKeys, usePublish } from './api-publish.js';
import * as requests from './api-requests.js';
import { requestKeys, useSaveConflictPolicy } from './api-requests.js';
import * as schedule from './api-schedule.js';
import { scheduleKeys } from './api-schedule.js';
import * as solver from './api-solver.js';
import { solverKeys } from './api-solver.js';
import { type FakeBridge, installFakeBridge } from './test/fake-bridge.js';

// Every method resolves with an object carrying the ids the hooks read.
let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respondDefault({
    id: 'x',
    unitId: 'u1',
    periodId: 'p1',
    holidayId: 'h1',
    nurseIds: [],
    assignment: { periodId: 'p1' },
  });
});
afterEach(() => bridge.uninstall());

const UNIT = 'u1';
const D1 = '2026-11-01' as IsoDate;
const D2 = '2026-11-14' as IsoDate;

type Screens = readonly (readonly [string, readonly unknown[]])[];
type MutationHook = () => { mutateAsync: (v: never) => Promise<unknown> };

const CONFIG_SCREENS: Screens = [
  ["another period's rule badges", scheduleKeys.validation('p2')],
  ["another period's pay-period hours", scheduleKeys.nurseHours('p2', 'n1', '2026-11-03')],
  ['its conflicts list', requestKeys.conflicts('p2')],
  ['its cost strip', costKeys.report('p2')],
  ['its fairness report', fairnessQueryKeys.report('p2')],
  ['its publish alerts', publishKeys.alerts('p2')],
  ['its publish preview', publishKeys.preview('p2')],
  ["Generate's batch for it", solverKeys.current('p2')],
  ["Generate's comparison with its draft", solverKeys.againstDraft('p2')],
  ['its scheduled HPPD', demandQueryKeys.hppd('p2')],
  ['the demand table', demandQueryKeys.demand(UNIT, D1, D2)],
  ['Today', dayOfKeys.today(UNIT)],
  ["the unit's exchanges", exchangeKeys.forUnit(UNIT)],
  ['holiday work priority', requestKeys.holidayWorkPriority(UNIT)],
  ['the dashboard', queryKeys.dashboard(UNIT)],
  ['cover options for a request', requestKeys.coverOptions('p2', 'r1')],
  ['the impact of approving a request', requestKeys.impact('p2', 'r1', 'approved')],
];

const ASSIGNMENT_SCREENS = [
  ["another period's grid", queryKeys.assignments('p2')],
  ["another period's rule badges", scheduleKeys.validation('p2')],
  ["another period's pay-period hours", scheduleKeys.nurseHours('p2', 'n1', '2026-11-03')],
  ['its conflicts list', requestKeys.conflicts('p2')],
  ['its cost strip', costKeys.report('p2')],
  ['its fairness report', fairnessQueryKeys.report('p2')],
  ['its change log', publishKeys.changes('p2')],
  ['its publish alerts', publishKeys.alerts('p2')],
  ["Generate's comparison with its draft", solverKeys.againstDraft('p2')],
  ['cover options for a request', requestKeys.coverOptions('p2', 'r1')],
  ['Today', dayOfKeys.today(UNIT)],
  ['the dashboard', queryKeys.dashboard(UNIT)],
] as const;

const LEAVE_SCREENS = [
  ...ASSIGNMENT_SCREENS,
  ['the request queue', queryKeys.timeOff(UNIT)],
  ['a leave balance check', leaveKeys.check('n1', 'pto', D1, D2, 24)],
  ["a bid round's bids", leaveBidKeys.bids('round-1')],
] as const;

const hooks: [string, MutationHook, unknown][] = [
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
  ['saving pay settings', () => cost.useSavePaySettings(UNIT), {}],
  ['saving the cancellation policy', () => dayof.useSaveCancellationPolicy(UNIT), {}],
];

const assignmentHooks: [string, MutationHook, unknown][] = [
  ['adding a shift on the grid', () => schedule.useCreateAssignment('p1', UNIT), {}],
  ['dragging a shift to another day', () => schedule.useMoveAssignment('p1', UNIT), {}],
  [
    'swapping two nurses',
    () => schedule.useSwapAssignments('p1', UNIT),
    { firstId: 'a1', secondId: 'a2' },
  ],
  [
    'editing a shift',
    () => schedule.useUpdateAssignment('p1', UNIT),
    { assignmentId: 'a1', patch: {} },
  ],
  ['deleting a shift', () => schedule.useDeleteAssignment('p1', UNIT), { assignmentId: 'a1' }],
  [
    'locking a shift',
    () => schedule.useSetLocked('p1', UNIT),
    { assignmentId: 'a1', locked: true },
  ],
  [
    'saving a Generate variation',
    () => solver.useSaveCandidate('p1', UNIT),
    { batchId: 'b1', index: 0 },
  ],
  ['backfilling a call-off', () => dayof.useBackfill(UNIT), { callOffId: 'c1', nurseId: 'n2' }],
  [
    'sending a nurse home for low census',
    () => dayof.useCancelForCensus(UNIT),
    { periodId: 'p1', date: D1, shiftTypeId: 'st', role: 'RN', volunteers: [], nurseId: 'n1' },
  ],
  ['recording a holdover', () => dayof.useRecordHoldover(UNIT), {}],
  ['approving a shift exchange', () => exchange.useApproveExchange(UNIT, 'p1'), { id: 'x' }],
  ['floating a nurse to another unit', () => floatOut.useFloatNurse(UNIT), { periodId: 'p1' }],
  // Deactivating lifts the nurse's draft shifts from every period, so every grid changes.
  ['deactivating a nurse', () => roster.useDeactivateNurse(UNIT), 'x'],
];

const leaveHooks: [string, MutationHook, unknown][] = [
  ['approving time off', () => requests.useApproveTimeOff(UNIT, 'p1'), { id: 'x' }],
  [
    'approving time off with cover',
    () => requests.useApproveAndCover(UNIT, 'p1'),
    { id: 'x', covers: [] },
  ],
  ['denying time off', () => requests.useDenyTimeOff(UNIT, 'p1'), { id: 'x', reason: 'Short' }],
  ['cancelling time off', () => requests.useCancelTimeOff(UNIT, 'p1'), { id: 'x' }],
  [
    'withdrawing an approval',
    () => requests.useWithdrawApproval(UNIT, 'p1'),
    { id: 'x', reason: 'Needed' },
  ],
  ['entering a time-off request', () => requests.useCreateTimeOff(UNIT, 'p1'), {}],
  [
    'resolving a conflict',
    () => requests.useResolveConflict(UNIT, 'p1'),
    { resolutionId: 'r', reason: 'Fair' },
  ],
  ['auto-resolving conflicts', () => requests.useAutoResolve(UNIT, 'p1'), undefined],
  ['awarding a leave bid round', () => bidding.useAwardLeaveBidRound(UNIT), 'round-1'],
];

/** Seeds every screen's key, runs the write once, and returns the screens left un-invalidated. */
async function seedThenRun(
  useHook: MutationHook,
  vars: unknown,
  screens: Screens,
  queryClient = new QueryClient(),
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  for (const [, key] of screens) queryClient.setQueryData(key, { seeded: true });
  const { result } = renderHook(useHook, { wrapper });
  await act(async () => {
    await result.current.mutateAsync(vars as never).catch(() => undefined);
  });
  return screens
    .filter(([, key]) => !queryClient.getQueryState(key)?.isInvalidated)
    .map(([name]) => name);
}

describe('editing configuration', () => {
  it.each(hooks)(
    "after %s, every period's derived screens are asked again",
    async (_n, useHook, vars) => {
      expect(await seedThenRun(useHook, vars, CONFIG_SCREENS)).toEqual([]);
    },
  );
});

describe('writing assignments', () => {
  it.each(assignmentHooks)(
    'after %s, the screens of every period refresh, not only the one on screen',
    async (_n, useHook, vars) => {
      expect(await seedThenRun(useHook, vars, ASSIGNMENT_SCREENS)).toEqual([]);
    },
  );

  it("a published Friday-night edit refreshes the next schedule's rule badges", async () => {
    const left = await seedThenRun(
      () => schedule.useUpdateAssignment('p1', UNIT),
      { assignmentId: 'a1', patch: {}, reason: 'Swapped at the nurse’s request' },
      [["the next period's rule badges", scheduleKeys.validation('p2')]],
    );
    expect(left).toEqual([]);
  });
});

describe('deciding leave', () => {
  it.each(leaveHooks)(
    'after %s, both schedules a request straddles refresh, and the leave checks too',
    async (_n, useHook, vars) => {
      expect(await seedThenRun(useHook, vars, LEAVE_SCREENS)).toEqual([]);
    },
  );

  it('refused time-off approval still refreshes every period', async () => {
    bridge.fail('timeOff', 'approve', new Error('Refused'));
    const left = await seedThenRun(
      () => requests.useApproveTimeOff(UNIT, 'p1'),
      { id: 'x' },
      LEAVE_SCREENS,
    );
    expect(left).toEqual([]);
  });
});

describe('publishing', () => {
  it('refreshes every period and the lists publishing wrote, not the whole app', async () => {
    const queryClient = new QueryClient();
    const untouched: Screens = [
      ["the unit's roster", queryKeys.nurses(UNIT)],
      ['the coverage floors', configKeys.coverage(UNIT)],
    ];
    for (const [, key] of untouched) queryClient.setQueryData(key, { seeded: true });
    const left = await seedThenRun(
      () => usePublish('p1', UNIT),
      { acknowledged: 0 },
      [
        ...ASSIGNMENT_SCREENS,
        ["the period's versions", publishKeys.versions('p1')],
        ['the backup list', publishKeys.backups()],
        ['the period list', queryKeys.periods(UNIT)],
        ['fairness history', fairnessQueryKeys.history(UNIT)],
        ['the fairness trend', fairnessQueryKeys.trend(UNIT)],
      ],
      queryClient,
    );
    expect(left).toEqual([]);
    for (const [name, key] of untouched) {
      expect(queryClient.getQueryState(key)?.isInvalidated, name).toBe(false);
    }
  });
});

describe("the roots really reach the screens' own queries", () => {
  it("a coverage edit marks another period's validation, cost, alerts and Generate batch for refetch", async () => {
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

describe('one cache entry per resource', () => {
  it('adding an acuity tier refreshes the tiers the Demand page and Today read', async () => {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const t1 = { id: 't1', unitId: UNIT, tier: 1 };
    const t2 = { id: 't2', unitId: UNIT, tier: 2 };
    bridge.respond('acuity', 'tiers', [t1] as never);
    const { result } = renderHook(
      () => ({ tiers: cfg.useAcuityTiers(UNIT), create: cfg.useCreateAcuityTier() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.tiers.data).toHaveLength(1));
    bridge.respond('acuity', 'tiers', [t1, t2] as never);
    await act(async () => {
      await result.current.create.mutateAsync({ unitId: UNIT } as never);
    });
    await waitFor(() => expect(result.current.tiers.data).toHaveLength(2));
    expect(bridge.callsTo('acuity', 'tiers')).toHaveLength(2);
  });

  it("saving a census forecast does not refetch the unit's HPPD target", async () => {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    queryClient.setQueryData(configKeys.hppdTarget(UNIT), { seeded: true });
    queryClient.setQueryData(demandQueryKeys.hppd('p1'), { seeded: true });
    const { result } = renderHook(() => demand.useUpsertCensus(UNIT, D1, D2), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({} as never);
    });
    expect(queryClient.getQueryState(configKeys.hppdTarget(UNIT))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(demandQueryKeys.hppd('p1'))?.isInvalidated).toBe(true);
  });
});
