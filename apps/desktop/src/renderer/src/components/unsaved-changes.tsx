/**
 * One guard for every form that holds edits until Save. Settings tabs unmount the panel they
 * leave, so switching from Rules to Pay used to throw away a half-edited rule set without a
 * word; leaving the page or closing the window did the same.
 *
 * A form calls `useUnsavedChanges('Rules', dirty)`. Anything about to unmount forms — a Settings
 * tab switch — awaits `useConfirmDiscard()`; route changes and window close/reload are guarded
 * by `NavigationGuard`. The window case ends in main (`will-prevent-unload`), because Electron
 * cancels an unload the page blocks without showing anything.
 */

import { useBlocker } from '@tanstack/react-router';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
} from 'react';
import { useConfirm } from './confirm.js';

type Registry = Map<string, string>;

const UnsavedContext = createContext<{ current: Registry } | undefined>(undefined);

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const registry = useRef<Registry>(new Map());
  return <UnsavedContext.Provider value={registry}>{children}</UnsavedContext.Provider>;
}

function useRegistry(): { current: Registry } {
  const registry = useContext(UnsavedContext);
  if (!registry) throw new Error('useUnsavedChanges must be used within UnsavedChangesProvider');
  return registry;
}

/** Declare that this form holds unsaved edits, under a name the confirmation can quote. */
export function useUnsavedChanges(label: string, dirty: boolean): void {
  const registry = useRegistry();
  const id = useId();
  useEffect(() => {
    if (dirty) registry.current.set(id, label);
    else registry.current.delete(id);
    return () => {
      registry.current.delete(id);
    };
  }, [registry, id, label, dirty]);
}

/** "Rules" / "Rules and Solver" / "Rules, Solver and Unit". */
export function listLabels(labels: readonly string[]): string {
  const unique = [...new Set(labels)];
  if (unique.length <= 1) return unique.join('');
  return `${unique.slice(0, -1).join(', ')} and ${unique.at(-1)}`;
}

/** Resolves true when nothing is unsaved, or when the manager chooses to discard it. */
export function useConfirmDiscard(): () => Promise<boolean> {
  const registry = useRegistry();
  const confirm = useConfirm();
  return useCallback(async () => {
    const labels = [...registry.current.values()];
    if (labels.length === 0) return true;
    return confirm({
      title: `Discard unsaved changes to ${listLabels(labels)}?`,
      description: 'Your edits have not been saved. Leaving now loses them.',
      confirmLabel: 'Discard changes',
    });
  }, [registry, confirm]);
}

/** Mounted once inside the router: guards page changes and the window itself. */
export function NavigationGuard() {
  const registry = useRegistry();
  const confirmDiscard = useConfirmDiscard();
  useBlocker({
    shouldBlockFn: async () => !(await confirmDiscard()),
    enableBeforeUnload: () => registry.current.size > 0,
  });
  return null;
}
