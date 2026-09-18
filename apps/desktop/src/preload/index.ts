/**
 * The bridge between the sandboxed renderer and the main process.
 *
 * Builds `window.shiftnurse` from the channel table in the shared contract: every entry
 * becomes a function that forwards its arguments over `ipcRenderer.invoke`. Nothing else is
 * exposed — no raw `ipcRenderer`, no `require` — so the surface the UI can reach is exactly
 * the contract and nothing more.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { API_CHANNELS, channelName, type RendererApi } from '../shared/api.js';

function buildApi(): RendererApi {
  const api: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {};
  for (const [resource, methods] of Object.entries(API_CHANNELS)) {
    api[resource] = {};
    for (const method of methods) {
      const channel = channelName(resource, method);
      api[resource][method] = (...args) => ipcRenderer.invoke(channel, ...args);
    }
  }
  return api as unknown as RendererApi;
}

contextBridge.exposeInMainWorld('shiftnurse', buildApi());
