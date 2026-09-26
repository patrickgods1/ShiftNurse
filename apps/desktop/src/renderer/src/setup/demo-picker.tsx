/**
 * The list of realistic demo units. Each differs in what real units differ in — shift pattern,
 * skill mix, whether ratios are law, how nights and weekends are paid — so a manager can explore
 * the one that looks most like their own. The list comes from main (`setup.demos`), the single
 * definition of what each demo contains.
 */

import { useDemos, useLoadDemo } from '../api-setup.js';
import { AsyncState } from '../components/async-state.js';
import { errorMessage, SECONDARY } from '../components/ui.js';

const CARD =
  'flex flex-col gap-2 rounded-lg border border-border bg-surface p-5 text-left hover:border-accent disabled:opacity-50';

export function DemoPicker({ onBack }: { onBack: () => void }) {
  const demosQuery = useDemos();
  const loadDemo = useLoadDemo();

  if (demosQuery.isPending) return <AsyncState status="loading" label="Loading demo units" />;
  if (demosQuery.isError) {
    return (
      <AsyncState status="error" label="Could not list the demo units" error={demosQuery.error} />
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="setup-demo-list">
      <ul className="grid gap-4">
        {demosQuery.data.map((demo) => {
          const loading = loadDemo.isPending && loadDemo.variables === demo.id;
          return (
            <li key={demo.id}>
              <button
                type="button"
                className={`${CARD} w-full`}
                data-testid={`setup-demo-${demo.id}`}
                data-demo-id={demo.id}
                onClick={() => loadDemo.mutate(demo.id)}
                disabled={loadDemo.isPending}
              >
                <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
                  {demo.setting}
                </span>
                <span className="font-semibold">
                  {loading ? `Loading ${demo.name}…` : demo.name}
                </span>
                <span className="text-sm text-text-muted">{demo.summary}</span>
                <ul className="mt-1 list-disc pl-5 text-sm text-text">
                  {demo.highlights.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </button>
            </li>
          );
        })}
      </ul>
      {loadDemo.isError ? (
        <p role="alert" className="text-sm text-danger">
          The demo could not be loaded: {errorMessage(loadDemo.error)}
        </p>
      ) : null}
      <p className="text-xs text-text-muted">
        Every demo is fictional: invented staff, six months of history and a schedule ready to
        generate. When you are ready for real data, use Settings › Unit › Start over.
      </p>
      <div>
        <button type="button" className={SECONDARY} onClick={onBack} disabled={loadDemo.isPending}>
          Back
        </button>
      </div>
    </div>
  );
}
