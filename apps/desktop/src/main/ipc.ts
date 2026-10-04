/**
 * Binds the API implementation to `ipcMain`, one handler per channel.
 *
 * Registration is driven by `API_CHANNELS`, the same table the preload script uses to build
 * the renderer's proxy, so a method added to the contract without a handler here fails at
 * type level rather than as a runtime "no handler registered" from inside the UI.
 */

import { ipcMain } from 'electron';
import type { z } from 'zod';
import { API_CHANNELS, channelName, type ShiftNurseApi } from '../shared/api.js';
import { API_SCHEMAS } from '../shared/schemas/index.js';
import { userFacingMessage } from './ipc-errors.js';

type AnyFn = (...args: never[]) => unknown;

/**
 * A failure is logged in full (with its stack, for the log file) and re-thrown in words a
 * manager can act on — see `ipc-errors.ts`.
 *
 * `isTrustedSender` is checked on every call: the navigation guard in `index.ts` is the first
 * line, and this is the second — a frame that is not the app's own page gets nothing. Then the
 * arguments are parsed against `API_SCHEMAS`: the contract's types do not exist at runtime.
 */
export function registerIpc(api: ShiftNurseApi, isTrustedSender: (url: string) => boolean): void {
  for (const [resource, methods] of Object.entries(API_CHANNELS)) {
    const group = api[resource as keyof ShiftNurseApi] as Record<string, AnyFn>;
    const schemas = API_SCHEMAS[resource as keyof ShiftNurseApi] as Record<string, z.ZodType>;
    for (const method of methods) {
      const handler = group[method];
      if (!handler) throw new Error(`API has no implementation for ${resource}.${method}`);
      const schema = schemas[method];
      if (!schema) throw new Error(`API has no argument schema for ${resource}.${method}`);
      const channel = channelName(resource, method);
      ipcMain.handle(channel, async (event, ...args: unknown[]) => {
        const sender = event.senderFrame?.url ?? '';
        if (!isTrustedSender(sender)) {
          throw new Error(`Refused ${channel} from an untrusted page (${sender || 'unknown'})`);
        }
        try {
          // Checked, never transformed: the handler gets exactly what was sent, once it is
          // known to have the contract's shape.
          const parsed = schema.safeParse(args);
          if (!parsed.success) throw new Error(describeRefusal(resource, method, parsed.error));
          // Awaited here so an async handler's rejection is reworded and logged too.
          return await handler(...(args as never[]));
        } catch (err) {
          console.error(`[ipc] ${channel} failed:`, err);
          throw new Error(userFacingMessage(err));
        }
      });
    }
  }
}

/**
 * A refused payload is a bug in the app, not something the manager did, but the message still
 * reaches the screen: name the call and the first field at fault so a support log is useful.
 */
export function describeRefusal(resource: string, method: string, error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return `The app sent ${resource}.${method} something it cannot accept.`;
  const [arg, ...field] = issue.path;
  const where =
    typeof arg === 'number'
      ? [`argument ${arg + 1}`, ...field.map(String)].join(' › ')
      : 'its arguments';
  return `The app sent ${resource}.${method} something it cannot accept: ${where}: ${issue.message}.`;
}
