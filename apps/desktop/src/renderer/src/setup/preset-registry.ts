/**
 * How a step of the assisted guide tells its Continue button what one-click starting point it
 * can apply. It lives in a module of its own because the guide's steps import components (the
 * state-law picker) that must register a preset themselves; keeping the context beside the steps
 * would make those components import it back, a cycle. Outside the guide the context is
 * undefined and registering is a no-op, so the same component works unchanged in Settings.
 */

import { createContext, useContext, useEffect, useRef } from 'react';

/** A step's starting point, offered to the guide's Continue button. */
export interface RegisteredPreset {
  /** The card's title, which is also the label its typed values register as unsaved. */
  title: () => string;
  label: () => string;
  disabled: () => boolean;
  run: () => Promise<unknown>;
}

/** Steps register their preset here so Continue can apply it on a step left empty. `undefined` outside the guide. */
export const PresetRegistry = createContext<
  ((preset: RegisteredPreset | undefined) => void) | undefined
>(undefined);

/**
 * Registers `preset` with the guide for as long as the caller is mounted; a no-op when there is no
 * guide (context undefined) or `enabled` is false. The registry holds one preset, so a step with
 * two candidates enables only the one that should own Continue.
 */
export function useRegisterPreset(preset: RegisteredPreset, enabled = true): void {
  const register = useContext(PresetRegistry);
  // Continue reads the preset when pressed, so it must see the current render's closures, while
  // the effect runs once per `register` identity rather than on every render.
  const latest = useRef(preset);
  latest.current = preset;
  // The guide's Continue label and behaviour follow `disabled`, but the guide does not re-render
  // when a step's local input changes; re-registering when it flips is what tells it to.
  const isDisabled = preset.disabled();
  // biome-ignore lint/correctness/useExhaustiveDependencies: isDisabled only triggers re-registering.
  useEffect(() => {
    if (!enabled) return;
    register?.({
      title: () => latest.current.title(),
      label: () => latest.current.label(),
      disabled: () => latest.current.disabled(),
      run: () => latest.current.run(),
    });
    return () => register?.(undefined);
  }, [register, enabled, isDisabled]);
}
