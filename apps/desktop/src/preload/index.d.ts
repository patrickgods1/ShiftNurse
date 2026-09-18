import type { RendererApi } from '../shared/api.js';

declare global {
  interface Window {
    /** Installed by the preload script. The only route from the renderer to data. */
    shiftnurse: RendererApi;
  }
}
