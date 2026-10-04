/**
 * The app's one transient notice, for outcomes with nowhere else to appear: a settings save that
 * failed, a request decision refused. Dialogs and panels that show their error inline keep doing
 * so; everything else reaches the manager here, because a failed save with nothing on screen
 * reads as a saved one.
 *
 * The query client lives outside React (`main.tsx` builds it at module level, and its
 * `MutationCache` needs a handler), so `toastBus` lets non-React code raise a toast; the provider
 * subscribes. A toast raised before the provider mounts is dropped: the app mounts both together.
 * Errors stay longer than info because they are read, not glanced at, and a pointer resting on a
 * toast or focus inside it holds the timer so one cannot vanish mid-read.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { PRIMARY, SECONDARY } from './ui.js';

export interface ToastOptions {
  message: string;
  tone?: 'info' | 'error';
  action?: { label: string; onClick: () => void };
  /** Overrides the default (info 6 s, error 10 s). */
  durationMs?: number;
}

export interface ToastApi {
  show(toast: ToastOptions): string;
  dismiss(id: string): void;
}

const MAX_TOASTS = 3;
const INFO_MS = 6_000;
const ERROR_MS = 10_000;

type Listener = (toast: ToastOptions) => void;
const listeners = new Set<Listener>();

/** For code outside React (the query client's mutation cache). */
export const toastBus = {
  emit(toast: ToastOptions): void {
    for (const listener of listeners) listener(toast);
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
};

interface Entry extends ToastOptions {
  id: string;
}

const ToastContext = createContext<ToastApi | undefined>(undefined);

interface Store {
  toasts: Entry[];
  dismiss: (id: string) => void;
  /** Outlets currently mounted, oldest first; only the first draws, so two never double-announce. */
  outlets: string[];
  setOutlet: (id: string, mounted: boolean) => void;
}
const StoreContext = createContext<Store | undefined>(undefined);

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (value === undefined) throw new Error('useToast must be used inside <ToastProvider>');
  return value;
}

let counter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Entry[]>([]);
  const [outlets, setOutlets] = useState<string[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const show = useCallback((toast: ToastOptions) => {
    counter += 1;
    const id = `toast-${counter}`;
    // The oldest goes: a burst of failures must not bury the page.
    setToasts((current) => [...current, { ...toast, id }].slice(-MAX_TOASTS));
    return id;
  }, []);

  useEffect(() => toastBus.subscribe((toast) => void show(toast)), [show]);

  const setOutlet = useCallback((id: string, mounted: boolean) => {
    setOutlets((current) =>
      mounted ? [...current.filter((o) => o !== id), id] : current.filter((o) => o !== id),
    );
  }, []);

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  const store = useMemo(
    () => ({ toasts, dismiss, outlets, setOutlet }),
    [toasts, dismiss, outlets, setOutlet],
  );

  return (
    <ToastContext.Provider value={api}>
      <StoreContext.Provider value={store}>
        {children}
        {/* Radix sets pointer-events: none on body while a modal is open; pointer-events is
            inherited, so an explicit auto here keeps a toast clickable above a dialog. */}
        {outlets.length === 0 ? (
          <ToastStack
            toasts={toasts}
            onDismiss={dismiss}
            className="fixed bottom-4 right-4 z-[60] w-[360px] max-w-[calc(100vw-2rem)]"
          />
        ) : null}
      </StoreContext.Provider>
    </ToastContext.Provider>
  );
}

function ToastStack({
  toasts,
  onDismiss,
  className,
}: {
  toasts: Entry[];
  onDismiss: (id: string) => void;
  className: string;
}) {
  return (
    <div className={`pointer-events-auto flex flex-col gap-2 ${className}`}>
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

/**
 * Renders the live toasts in place. A modal dialog aria-hides everything outside it, so the
 * global region is silent to assistive tech while one is open; mounting an outlet inside the
 * dialog announces them there. While any outlet is mounted the global region steps aside.
 */
export function ToastOutlet({ className = 'mt-3' }: { className?: string }) {
  const store = useContext(StoreContext);
  if (store === undefined) throw new Error('ToastOutlet must be used inside <ToastProvider>');
  const id = useId();
  const { setOutlet } = store;
  useEffect(() => {
    setOutlet(id, true);
    return () => setOutlet(id, false);
  }, [id, setOutlet]);
  if (store.outlets[0] !== id) return null;
  return <ToastStack toasts={store.toasts} onDismiss={store.dismiss} className={className} />;
}

function ToastItem({ toast, onDismiss }: { toast: Entry; onDismiss: (id: string) => void }) {
  const isError = toast.tone === 'error';
  const duration = toast.durationMs ?? (isError ? ERROR_MS : INFO_MS);
  const [paused, setPaused] = useState(false);
  // Time left survives a pause: resuming restarts the remainder, not the whole duration.
  const remaining = useRef(duration);
  const startedAt = useRef(0);

  useEffect(() => {
    if (paused) return;
    startedAt.current = Date.now();
    const timer = setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
    };
  }, [paused, onDismiss, toast.id]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: handlers only pause the timer and take Escape from the buttons inside
    <div
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      className={`flex flex-col gap-2 rounded-md border bg-surface p-3 text-sm text-text shadow-lg ${
        isError ? 'border-danger' : 'border-border'
      }`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onDismiss(toast.id);
      }}
    >
      <p className={isError ? 'text-danger' : undefined}>{toast.message}</p>
      <div className="flex justify-end gap-2">
        {toast.action ? (
          <button
            type="button"
            className={PRIMARY}
            onClick={() => {
              toast.action?.onClick();
              onDismiss(toast.id);
            }}
          >
            {toast.action.label}
          </button>
        ) : null}
        <button
          type="button"
          className={SECONDARY}
          aria-label="Dismiss"
          onClick={() => onDismiss(toast.id)}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
