import { beforeEach, describe, expect, it, vi } from 'vitest';
import { API_CHANNELS, channelName, type ShiftNurseApi } from '../shared/api.js';

// The one module mock here: ipc.ts imports `ipcMain` from electron, which does not exist under
// plain Node. It only needs to remember the handlers it was given.
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
const handleSpy = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      handleSpy(channel);
      handlers.set(channel, fn);
    },
  },
}));

import { registerIpc } from './ipc.js';

const TRUSTED = 'app://shiftnurse/index.html';
const trusted = (url: string) => url === TRUSTED;
const MARKER = Symbol('result');

type Call = { channel: string; args: unknown[] };
let calls: Call[];

/** Every method in the contract, generated from the table the preload uses. */
function fakeApi(): ShiftNurseApi {
  const api: Record<string, Record<string, unknown>> = {};
  for (const [resource, methods] of Object.entries(API_CHANNELS)) {
    const group: Record<string, unknown> = {};
    for (const method of methods) {
      group[method] = (...args: unknown[]) => {
        calls.push({ channel: channelName(resource, method), args });
        return MARKER;
      };
    }
    api[resource] = group;
  }
  return api as unknown as ShiftNurseApi;
}

const fromPage = { senderFrame: { url: TRUSTED } };

function invoke(resource: string, method: string, event: unknown, ...args: unknown[]) {
  const handler = handlers.get(channelName(resource, method));
  if (!handler) throw new Error(`no handler for ${resource}.${method}`);
  return handler(event, ...args);
}

beforeEach(() => {
  handlers.clear();
  handleSpy.mockClear();
  calls = [];
  vi.restoreAllMocks();
});

describe('registering the app API over IPC', () => {
  it('registers every channel in the contract once, and nothing else', () => {
    registerIpc(fakeApi(), trusted);
    const expected = Object.entries(API_CHANNELS).flatMap(([resource, methods]) =>
      methods.map((method) => channelName(resource, method)),
    );
    const registered = handleSpy.mock.calls.map((c) => c[0] as string);
    expect(registered).toHaveLength(expected.length);
    expect(new Set(registered).size).toBe(registered.length);
    expect([...registered].sort()).toEqual([...expected].sort());
  });

  it('says which method has no implementation', () => {
    const api = fakeApi() as unknown as Record<string, Record<string, unknown>>;
    delete api.cost?.updatePayRate;
    expect(() => registerIpc(api as unknown as ShiftNurseApi, trusted)).toThrow(
      'API has no implementation for cost.updatePayRate',
    );
  });
});

describe('a call arriving over IPC', () => {
  beforeEach(() => {
    registerIpc(fakeApi(), trusted);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('refuses a page that is not the app and never reaches the implementation', async () => {
    const evil = { senderFrame: { url: 'https://evil.example/' } };
    await expect(invoke('units', 'list', evil)).rejects.toThrow(
      'Refused shiftnurse:units.list from an untrusted page (https://evil.example/)',
    );
    await expect(invoke('units', 'list', {})).rejects.toThrow('untrusted page (unknown)');
    expect(calls).toEqual([]);
  });

  it('hands the implementation exactly what was sent and returns its answer', async () => {
    const edit = { hourlyRate: 52.5 };
    await expect(invoke('cost', 'updatePayRate', fromPage, 'rate-1', edit)).resolves.toBe(MARKER);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.channel).toBe('shiftnurse:cost.updatePayRate');
    expect(calls[0]?.args[0]).toBe('rate-1');
    expect(calls[0]?.args[1]).toBe(edit);
    expect(calls[0]?.args).toHaveLength(2);
  });

  it('refuses a rate that is not a number, naming the call and the field', async () => {
    await expect(
      invoke('cost', 'updatePayRate', fromPage, 'rate-1', { hourlyRate: 'x' }),
    ).rejects.toThrow(
      /^The app sent cost\.updatePayRate something it cannot accept: argument 2 › hourlyRate: /,
    );
    expect(calls).toEqual([]);
  });

  it('refuses a move carrying a field it may not have', async () => {
    const move = {
      assignmentId: 'a-1',
      nurseId: 'n-1',
      shiftTypeId: 's-1',
      date: '2026-11-02',
      isLocked: true,
    };
    await expect(invoke('schedule', 'moveAssignment', fromPage, move)).rejects.toThrow(
      /^The app sent schedule\.moveAssignment something it cannot accept: argument 1/,
    );
    expect(calls).toEqual([]);
  });

  it('rewords a database failure for the manager and logs the original', async () => {
    const original = Object.assign(
      new Error('UNIQUE constraint failed: assignment.nurse_id, assignment.date'),
      { code: 'SQLITE_CONSTRAINT_UNIQUE' },
    );
    const api = fakeApi() as unknown as { cost: { updatePayRate: () => never } };
    api.cost.updatePayRate = () => {
      throw original;
    };
    handlers.clear();
    registerIpc(api as unknown as ShiftNurseApi, trusted);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(invoke('cost', 'updatePayRate', fromPage, 'rate-1', {})).rejects.toThrow(
      'That nurse already has that shift on that day.',
    );
    expect(logged).toHaveBeenCalledWith('[ipc] shiftnurse:cost.updatePayRate failed:', original);
  });
});
