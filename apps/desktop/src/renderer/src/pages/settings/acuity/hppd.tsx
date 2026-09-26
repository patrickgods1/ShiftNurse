/** The unit's HPPD budget: a soft target the demand math reports against, never a constraint. */

import { useEffect, useState } from 'react';
import { useHppdTarget, useSetHppdTarget } from '../../../api-config.js';

export function HppdSection({ unitId }: { unitId: string }) {
  const hppdQuery = useHppdTarget(unitId);
  const setHppd = useSetHppdTarget();
  const [value, setValue] = useState('');

  // Sync the input from the loaded target once, and again whenever a fresh save comes back —
  // but never overwrite what the manager is mid-typing.
  useEffect(() => {
    if (hppdQuery.data !== undefined) {
      setValue(String(hppdQuery.data.targetHours));
    }
  }, [hppdQuery.data]);

  const parsed = Number(value);
  const valid = value !== '' && Number.isFinite(parsed) && parsed > 0;

  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold text-text">HPPD target</h2>
      <form
        className="flex max-w-sm flex-col gap-2 rounded-md border border-border bg-surface p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          setHppd.mutate({ unitId, targetHours: parsed });
        }}
      >
        <label className="flex flex-col gap-1 text-sm text-text">
          Target nursing hours per patient day
          <input
            type="number"
            required
            min={0.01}
            step={0.1}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="rounded-md border border-border bg-bg px-2 py-1 text-text"
          />
        </label>
        <p className="text-xs text-text-muted">
          A soft budget target, e.g. 8.5 — it informs the objective function and dashboard, but it
          never becomes a hard constraint the way a patient ratio or coverage floor does.
        </p>
        <div className="mt-1 flex justify-end">
          <button
            type="submit"
            disabled={!valid}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90
              disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </form>
    </section>
  );
}
