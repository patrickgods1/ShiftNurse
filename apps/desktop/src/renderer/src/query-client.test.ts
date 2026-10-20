// @vitest-environment jsdom
/**
 * What a query shows while its key changes. keepPreviousData keeps a list from flashing a spinner
 * as options change, but on a query that has just been switched off it serves the last key's
 * answer as if it were current; that once crashed the Requests page.
 */

import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createQueryClient, placeholderWhileEnabled } from './query-client.js';

afterEach(cleanup);

describe('placeholder data', () => {
  function setup() {
    const queryClient = createQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    // B never answers, so "while B loads" lasts as long as the test needs.
    const hook = renderHook(
      ({ who }: { who: string | undefined }) =>
        useQuery({
          queryKey: ['placeholder-test', who ?? 'none'],
          queryFn: () =>
            who === 'B' ? new Promise<{ who: string }>(() => {}) : Promise.resolve({ who }),
          enabled: who !== undefined,
          placeholderData: placeholderWhileEnabled(who !== undefined),
        }),
      { wrapper, initialProps: { who: 'A' as string | undefined } },
    );
    return hook;
  }

  it('keeps the last answer up while the next nurse loads', async () => {
    const hook = setup();
    await waitFor(() => expect(hook.result.current.data).toEqual({ who: 'A' }));

    hook.rerender({ who: 'B' });

    expect(hook.result.current.data).toEqual({ who: 'A' });
    expect(hook.result.current.isPlaceholderData).toBe(true);
  });

  it('shows nothing once the query is switched off', async () => {
    const hook = setup();
    await waitFor(() => expect(hook.result.current.data).toEqual({ who: 'A' }));

    hook.rerender({ who: undefined });

    expect(hook.result.current.data).toBeUndefined();
  });
});
