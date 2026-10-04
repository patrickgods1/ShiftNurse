/**
 * A scripted stand-in for `window.shiftnurse`, so a component test can click through a dialog
 * and then assert on exactly what would have crossed IPC. Without it every dialog test
 * re-invents a half-typed mock of a bridge with ~30 resources, and a renamed method is only
 * noticed when a nurse manager clicks the button.
 *
 * `api.ts` captures `window.shiftnurse` once, at import (`export const api = window.shiftnurse`),
 * so swapping the object per test would leave every hook talking to the first one. The proxy
 * assigned here is therefore created once per window and stays put; `installFakeBridge` only
 * points it at a fresh recording. `test/setup.ts` (a vitest setupFile) loads this module before
 * any test file, so plain static imports of components work.
 */

import type { RendererApi } from '../../../shared/api.js';

export interface RecordedCall {
  resource: string;
  method: string;
  args: unknown[];
}

type Resource = keyof RendererApi;
type Method<R extends Resource> = keyof RendererApi[R] & string;
type MethodFn<R extends Resource, M extends Method<R>> = RendererApi[R][M] extends (
  ...args: infer A
) => Promise<infer T>
  ? (...args: A) => T
  : never;

/** What a call resolves to: the value itself, or a function of the call's arguments. */
type Scripted<R extends Resource, M extends Method<R>> =
  | ReturnType<MethodFn<R, M>>
  | MethodFn<R, M>;

/** Scripted values up front: `{ units: { list: [unit] } }`. */
export type Responses = {
  [R in Resource]?: { [M in Method<R>]?: Scripted<R, M> };
};

export interface FakeBridge {
  readonly calls: RecordedCall[];
  respond<R extends Resource, M extends Method<R>>(
    resource: R,
    method: M,
    value: Scripted<R, M>,
  ): void;
  fail<R extends Resource, M extends Method<R>>(resource: R, method: M, error: Error): void;
  callsTo<R extends Resource, M extends Method<R>>(
    resource: R,
    method: M,
  ): Parameters<MethodFn<R, M>>[];
  /** What every call without its own script resolves to (default `undefined`). */
  respondDefault(value: unknown): void;
  /** Forget recorded calls and every scripted response. */
  reset(): void;
  /** Detach: later calls reject loudly instead of recording into a finished test. */
  uninstall(): void;
}

type Outcome = { kind: 'value'; value: unknown } | { kind: 'error'; error: Error };

const keyOf = (resource: string, method: string) => `${resource}.${method}`;

let active: FakeBridge | undefined;
let invoke: ((resource: string, method: string, args: unknown[]) => Promise<unknown>) | undefined;

function stableProxy(): RendererApi {
  const resources = new Map<string, object>();
  return new Proxy({} as RendererApi, {
    get(_target, resource) {
      if (typeof resource !== 'string') return undefined;
      let methods = resources.get(resource);
      if (methods === undefined) {
        methods = new Proxy(
          {},
          {
            get: (_t, method) =>
              typeof method === 'string'
                ? (...args: unknown[]) => {
                    if (invoke === undefined) {
                      return Promise.reject(
                        new Error(
                          `window.shiftnurse.${resource}.${method} called with no fake bridge`,
                        ),
                      );
                    }
                    return invoke(resource, method, args);
                  }
                : undefined,
          },
        );
        resources.set(resource, methods);
      }
      return methods;
    },
  });
}

if (typeof window !== 'undefined' && window.shiftnurse === undefined) {
  window.shiftnurse = stableProxy();
}

export function getActiveBridge(): FakeBridge | undefined {
  return active;
}

export function installFakeBridge(responses?: Responses): FakeBridge {
  if (window.shiftnurse === undefined) window.shiftnurse = stableProxy();
  const calls: RecordedCall[] = [];
  const outcomes = new Map<string, Outcome>();
  let fallback: unknown;

  const bridge: FakeBridge = {
    calls,
    respond(resource, method, value) {
      outcomes.set(keyOf(resource, method), { kind: 'value', value });
    },
    fail(resource, method, error) {
      outcomes.set(keyOf(resource, method), { kind: 'error', error });
    },
    callsTo(resource, method) {
      return calls
        .filter((c) => c.resource === resource && c.method === method)
        .map((c) => c.args) as never;
    },
    respondDefault(value) {
      fallback = value;
    },
    reset() {
      calls.length = 0;
      fallback = undefined;
      outcomes.clear();
    },
    uninstall() {
      if (active === bridge) {
        active = undefined;
        invoke = undefined;
      }
    },
  };

  active = bridge;
  invoke = (resource, method, args) => {
    calls.push({ resource, method, args });
    const outcome = outcomes.get(keyOf(resource, method));
    if (outcome === undefined) return Promise.resolve(fallback);
    if (outcome.kind === 'error') return Promise.reject(outcome.error);
    const { value } = outcome;
    return Promise.resolve(typeof value === 'function' ? value(...args) : value);
  };
  for (const [resource, methods] of Object.entries(responses ?? {})) {
    for (const [method, value] of Object.entries(methods ?? {})) {
      outcomes.set(keyOf(resource, method), { kind: 'value', value });
    }
  }
  return bridge;
}
