/**
 * Binds the API implementation to `ipcMain`, one handler per channel.
 *
 * Registration is driven by `API_CHANNELS`, the same table the preload script uses to build
 * the renderer's proxy, so a method added to the contract without a handler here fails at
 * type level rather than as a runtime "no handler registered" from inside the UI.
 */

import { ipcMain } from 'electron';
import { API_CHANNELS, channelName, type ShiftNurseApi } from '../shared/api.js';

type AnyFn = (...args: never[]) => unknown;

export function registerIpc(api: ShiftNurseApi): void {
  for (const [resource, methods] of Object.entries(API_CHANNELS)) {
    const group = api[resource as keyof ShiftNurseApi] as Record<string, AnyFn>;
    for (const method of methods) {
      const handler = group[method];
      if (!handler) throw new Error(`API has no implementation for ${resource}.${method}`);
      ipcMain.handle(channelName(resource, method), (_event, ...args: unknown[]) =>
        handler(...(args as never[])),
      );
    }
  }
}
