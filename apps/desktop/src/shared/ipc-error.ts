/**
 * Electron rejects a failed `ipcRenderer.invoke` with the main process's message wrapped as
 * `Error invoking remote method '<channel>': Error: <message>`. Every error the UI shows comes
 * through that wrapper, so without this a nurse manager reads the channel name before the
 * reason. The preload strips it once, for every call.
 */

const WRAPPER = /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/;

export function stripIpcPrefix(message: string): string {
  return message.replace(WRAPPER, '');
}
