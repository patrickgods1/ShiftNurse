/**
 * Publishing through the IPC handlers: what the preview promises, what the publish writes in its
 * one transaction (version, status, ledger, audit), and that it refuses in words a republish that
 * has no reason or nothing new. The backup is Electron's (`backups.ts` reads `app.getPath`), so it
 * is stubbed here; what matters is that its failure never turns a committed publish into an error.
 */

import { addDays, isoDate } from '@shiftnurse/core';
import { auditHistoryFor, getPeriod, ledgerSince, recentAudit } from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createBackup = vi.hoisted(() => vi.fn());
vi.mock('../backups.js', () => ({ createBackup }));

import { outputInput, publishApi } from './publish.js';
import { scheduleApi } from './schedule.js';
import { type Fixture, openFixture } from './test-fixture.js';

let f: Fixture;

beforeEach(() => {
  f = openFixture();
  createBackup.mockReset();
  createBackup.mockResolvedValue({ fileName: 'publish-x.sqlite', path: '/tmp/publish-x.sqlite' });
});

afterEach(() => {
  f.handle.close();
});

const api = () => publishApi(f.handle.db);
const grid = () => scheduleApi(f.handle.db);
const draft = () => f.seeded.draftPeriodId;

function placeNight(nurseId = f.rns[0]!.id, offset = 1, reason?: string) {
  return grid().createAssignment(
    {
      periodId: draft(),
      nurseId,
      shiftTypeId: f.night.id,
      date: addDays(f.seeded.draftStart, offset),
    },
    reason,
  );
}

describe('previewing a publish', () => {
  it('counts every shift as new on a first publish and says there is something to publish', () => {
    placeNight();
    placeNight(f.rns[1]!.id, 2);
    const preview = api().preview(draft());
    expect(preview.latestVersion).toBeUndefined();
    expect(preview.diff.added).toBe(2);
    expect(preview.nothingToPublish).toBe(false);
  });

  it('says there is nothing to publish once the last version matches the grid', async () => {
    placeNight();
    await api().publish(draft());
    expect(api().preview(draft()).nothingToPublish).toBe(true);
  });

  it('says so when the period does not exist', () => {
    expect(() => api().preview('no-period')).toThrow(/unknown period/i);
  });
});

describe('publishing a schedule', () => {
  it('freezes version 1, flips the period to published and books the ledger', async () => {
    placeNight(f.rns[0]!.id, 1);
    placeNight(f.rns[0]!.id, 2);
    const outcome = await api().publish(draft());

    expect(outcome.version.version).toBe(1);
    expect(outcome.period.status).toBe('published');
    expect(getPeriod(f.handle.db, draft())?.status).toBe('published');
    expect(api().versions(draft())).toHaveLength(1);
    // Only Ann was scheduled, so only Ann has a ledger row; two nights by hand count.
    expect(outcome.ledgerEntries).toBe(1);
    const rows = ledgerSince(f.handle.db, f.seeded.unitId, f.seeded.draftStart).filter(
      (l) => l.periodId === draft(),
    );
    expect(rows.map((r) => [r.nurseId, r.nightShifts])).toEqual([[f.rns[0]!.id, 2]]);
    expect(auditHistoryFor(f.handle.db, 'schedule_version', outcome.version.id)[0]).toMatchObject({
      action: 'publish',
      actor: 'manager',
    });
  });

  it('takes the publish backup after the commit, named for the period and version', async () => {
    placeNight();
    const outcome = await api().publish(draft());
    expect(createBackup).toHaveBeenCalledTimes(1);
    expect(createBackup.mock.calls[0]![1]).toBe('publish');
    expect(createBackup.mock.calls[0]![2]).toBe(`${outcome.period.name}-v1`);
    expect(outcome.backup).toMatchObject({ fileName: 'publish-x.sqlite' });
  });

  it('still reports a published schedule when the backup cannot be written', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    createBackup.mockRejectedValue(new Error('disk full'));
    placeNight();
    const outcome = await api().publish(draft());
    expect(outcome.backup).toBeUndefined();
    expect(getPeriod(f.handle.db, draft())?.status).toBe('published');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    log.mockRestore();
  });

  it('refuses to republish without a reason, and writes nothing', async () => {
    placeNight();
    await api().publish(draft());
    placeNight(f.rns[1]!.id, 3, 'Added a night');
    const audits = recentAudit(f.handle.db, 1000).length;
    await expect(api().publish(draft())).rejects.toThrow(/requires a reason/i);
    expect(api().versions(draft())).toHaveLength(1);
    expect(recentAudit(f.handle.db, 1000).length).toBe(audits);
  });

  it('refuses to republish an unchanged schedule', async () => {
    placeNight();
    await api().publish(draft());
    await expect(api().publish(draft(), 'Just in case')).rejects.toThrow(
      /nothing has changed since version 1/i,
    );
    expect(createBackup).toHaveBeenCalledTimes(1);
  });

  it('republishes a changed schedule as version 2 under the stated reason', async () => {
    placeNight();
    await api().publish(draft());
    placeNight(f.rns[1]!.id, 4, 'Census spike');
    const outcome = await api().publish(draft(), 'Added a night for the census spike');
    expect(outcome.version.version).toBe(2);
    expect(outcome.diff.added).toBe(1);
    expect(
      api()
        .versions(draft())
        .map((v) => v.version),
    ).toEqual([1, 2]);
    expect(auditHistoryFor(f.handle.db, 'schedule_version', outcome.version.id)[0]!.reason).toBe(
      'Added a night for the census spike',
    );
  });

  it('says so when publishing a period that does not exist, and takes no backup', async () => {
    await expect(api().publish('no-period')).rejects.toThrow(/unknown period/i);
    expect(createBackup).not.toHaveBeenCalled();
  });
});

describe('the change log and what exports render', () => {
  it('lists a reasoned edit to a published schedule in the change log', async () => {
    const shift = placeNight();
    await api().publish(draft());
    expect(api().changes(draft())).toEqual([]);
    grid().deleteAssignment(shift.id, 'Ann is out sick');
    const [change] = api().changes(draft());
    expect(change).toMatchObject({ reason: 'Ann is out sick' });
    expect(api().preview(draft()).pendingChanges).toHaveLength(1);
  });

  it('hands exports the grid, the unit and the version they are printing', async () => {
    placeNight();
    await api().publish(draft());
    const input = outputInput(f.handle.db, draft());
    expect(input.ctx.status).toBe('published');
    expect(input.ctx.version?.version).toBe(1);
    expect(input.ctx.unit.id).toBe(f.seeded.unitId);
    expect(input.schedule.assignments()).toHaveLength(1);
    expect(api().alerts(draft())).toEqual(input.ctx.alerts);
  });

  it('keeps an isoDate-keyed period start for the export header', () => {
    expect(outputInput(f.handle.db, draft()).schedule.period.startDate).toBe(
      isoDate(f.seeded.draftStart),
    );
  });
});
