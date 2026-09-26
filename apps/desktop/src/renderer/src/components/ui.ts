/**
 * The app's shared class strings. One definition each: copies of these had drifted across pages
 * (`w-[420px]` here, `w-[28rem]` there) before they lived in one place.
 */

export const INPUT = 'rounded-md border border-border bg-bg px-2 py-1 text-sm text-text';
export const LABEL = 'flex flex-col gap-1 text-xs text-text-muted';
export const PRIMARY =
  'rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50';
export const SECONDARY =
  'rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text hover:bg-bg disabled:opacity-50';
export const DANGER =
  'rounded-md border border-danger px-3 py-1.5 text-sm text-danger hover:bg-bg disabled:opacity-50';
export const SMALL = 'rounded-md border border-border px-2 py-1 text-xs text-text hover:bg-bg';
export const SMALL_DANGER =
  'rounded-md border border-border px-2 py-1 text-xs text-danger hover:bg-bg';
/** The dimmed backdrop behind every modal. */
export const OVERLAY = 'fixed inset-0 z-50 bg-black/40';
/** A compact centred modal (confirmations, single-field prompts); add a width. */
export const POPUP =
  'fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-surface p-4 shadow-lg';
/** A full centred modal with scrolling; add a width. */
export const DIALOG =
  'fixed z-50 left-1/2 top-1/2 max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-surface p-6 shadow-lg';

export function errorMessage(error: unknown): string | undefined {
  if (error === null || error === undefined) return undefined;
  return error instanceof Error ? error.message : String(error);
}

/** Table header and data cells for the settings tables. */
export const TH = 'px-3 py-2 font-medium';
export const TD = 'px-3 py-2 text-text';
