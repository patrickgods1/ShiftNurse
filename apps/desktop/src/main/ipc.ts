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

/**
 * `isTrustedSender` is checked on every call: the navigation guard in `index.ts` is the first
 * line, and this is the second — a frame that is not the app's own page gets nothing.
 */
export function registerIpc(api: ShiftNurseApi, isTrustedSender: (url: string) => boolean): void {
  for (const [resource, methods] of Object.entries(API_CHANNELS)) {
    const group = api[resource as keyof ShiftNurseApi] as Record<string, AnyFn>;
    for (const method of methods) {
      const handler = group[method];
      if (!handler) throw new Error(`API has no implementation for ${resource}.${method}`);
      const channel = channelName(resource, method);
      ipcMain.handle(channel, (event, ...args: unknown[]) => {
        const sender = event.senderFrame?.url ?? '';
        if (!isTrustedSender(sender)) {
          throw new Error(`Refused ${channel} from an untrusted page (${sender || 'unknown'})`);
        }
        return handler(...(args as never[]));
      });
    }
  }
}
