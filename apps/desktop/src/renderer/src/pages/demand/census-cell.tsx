/**
 * One census grid cell: a click target that expands into an inline editor for projected census
 * (and, for a past date, actual census) plus the per-tier acuity mix. Kept as its own popover
 * rather than a modal so a manager can tab across a week filling in numbers without a dialog
 * stealing focus each time.
 */

import type { AcuityTier, CensusForecast, Id } from '@shiftnurse/core';
import { validateAcuityMix } from '@shiftnurse/core';
import { useEffect, useRef, useState } from 'react';

interface CensusCellProps {
  date: string;
  shiftTypeId: Id;
  unitId: Id;
  existing: CensusForecast | undefined;
  tiers: AcuityTier[];
  isPast: boolean;
  onSaveForecast: (census: number, mix: Record<Id, number>) => void;
  onSaveActual: (census: number, mix: Record<Id, number>) => void;
  saving: boolean;
}

function emptyMix(tiers: AcuityTier[], seed: Record<Id, number> | undefined): Record<Id, number> {
  const mix: Record<Id, number> = {};
  for (const tier of tiers) mix[tier.id] = seed?.[tier.id] ?? 0;
  return mix;
}

export function CensusCell({
  date,
  shiftTypeId,
  existing,
  tiers,
  isPast,
  onSaveForecast,
  onSaveActual,
  saving,
}: CensusCellProps) {
  const [open, setOpen] = useState(false);
  const [census, setCensus] = useState(existing?.projectedCensus ?? 0);
  const [mix, setMix] = useState<Record<Id, number>>(() => emptyMix(tiers, existing?.acuityMix));
  const [actualCensus, setActualCensus] = useState(existing?.actualCensus ?? 0);
  const [actualMix, setActualMix] = useState<Record<Id, number>>(() =>
    emptyMix(tiers, existing?.actualAcuityMix),
  );
  const cellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setCensus(existing?.projectedCensus ?? 0);
    setMix(emptyMix(tiers, existing?.acuityMix));
    setActualCensus(existing?.actualCensus ?? 0);
    setActualMix(emptyMix(tiers, existing?.actualAcuityMix));
  }, [open, existing, tiers]);

  const problems = validateAcuityMix(census, mix);
  const actualProblems = validateAcuityMix(actualCensus, actualMix);

  const label = existing === undefined ? '—' : String(existing.projectedCensus);
  const isForecast = existing?.source === 'forecast';

  return (
    <div ref={cellRef} className="relative">
      <button
        type="button"
        data-testid={`census-cell-${date}-${shiftTypeId}`}
        className={`flex w-full items-center justify-center gap-1 rounded px-2 py-1.5 text-sm
          hover:bg-bg focus-visible:bg-bg ${
            existing === undefined ? 'text-text-muted' : 'text-text'
          }`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>{label}</span>
        {isForecast ? (
          <span
            title="From history/forecast"
            className="inline-block h-1.5 w-1.5 rounded-full bg-accent"
          />
        ) : null}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={`Census for ${date}`}
          className="absolute z-10 mt-1 w-72 rounded-md border border-border bg-surface p-3 shadow-lg"
        >
          <div className="mb-2">
            <label
              htmlFor={`census-${date}-${shiftTypeId}`}
              className="block text-xs font-medium text-text-muted"
            >
              Projected census
            </label>
            <input
              id={`census-${date}-${shiftTypeId}`}
              type="number"
              min={0}
              step={1}
              value={census}
              onChange={(e) => setCensus(Number(e.target.value))}
              className="mt-1 w-full rounded border border-border bg-bg px-2 py-1 text-sm text-text"
            />
          </div>
          <fieldset className="mb-2">
            <legend className="text-xs font-medium text-text-muted">Acuity mix</legend>
            {tiers.map((tier) => (
              <div key={tier.id} className="mt-1 flex items-center justify-between gap-2">
                <label
                  htmlFor={`mix-${date}-${shiftTypeId}-${tier.id}`}
                  className="text-sm text-text"
                >
                  {tier.name}
                </label>
                <input
                  id={`mix-${date}-${shiftTypeId}-${tier.id}`}
                  type="number"
                  min={0}
                  step={1}
                  value={mix[tier.id] ?? 0}
                  onChange={(e) => setMix((m) => ({ ...m, [tier.id]: Number(e.target.value) }))}
                  className="w-20 rounded border border-border bg-bg px-2 py-1 text-sm text-text"
                />
              </div>
            ))}
          </fieldset>
          {problems.length > 0 ? (
            <p className="mb-2 text-xs text-danger">{problems.join('; ')}</p>
          ) : null}
          <button
            type="button"
            disabled={problems.length > 0 || saving}
            className="w-full rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white
              disabled:opacity-50"
            onClick={() => {
              onSaveForecast(census, mix);
              setOpen(false);
            }}
          >
            Save forecast
          </button>

          {isPast ? (
            <div className="mt-3 border-t border-border pt-3">
              <div className="mb-2">
                <label
                  htmlFor={`actual-${date}-${shiftTypeId}`}
                  className="block text-xs font-medium text-text-muted"
                >
                  Actual census
                </label>
                <input
                  id={`actual-${date}-${shiftTypeId}`}
                  type="number"
                  min={0}
                  step={1}
                  value={actualCensus}
                  onChange={(e) => setActualCensus(Number(e.target.value))}
                  className="mt-1 w-full rounded border border-border bg-bg px-2 py-1 text-sm text-text"
                />
              </div>
              <fieldset className="mb-2">
                <legend className="text-xs font-medium text-text-muted">Actual mix</legend>
                {tiers.map((tier) => (
                  <div key={tier.id} className="mt-1 flex items-center justify-between gap-2">
                    <label
                      htmlFor={`actual-mix-${date}-${shiftTypeId}-${tier.id}`}
                      className="text-sm text-text"
                    >
                      {tier.name}
                    </label>
                    <input
                      id={`actual-mix-${date}-${shiftTypeId}-${tier.id}`}
                      type="number"
                      min={0}
                      step={1}
                      value={actualMix[tier.id] ?? 0}
                      onChange={(e) =>
                        setActualMix((m) => ({ ...m, [tier.id]: Number(e.target.value) }))
                      }
                      className="w-20 rounded border border-border bg-bg px-2 py-1 text-sm text-text"
                    />
                  </div>
                ))}
              </fieldset>
              {actualProblems.length > 0 ? (
                <p className="mb-2 text-xs text-danger">{actualProblems.join('; ')}</p>
              ) : null}
              <button
                type="button"
                disabled={actualProblems.length > 0 || saving || existing === undefined}
                title={existing === undefined ? 'Save a forecast first' : undefined}
                className="w-full rounded-md border border-border px-3 py-1.5 text-sm font-medium
                  text-text disabled:opacity-50"
                onClick={() => {
                  onSaveActual(actualCensus, actualMix);
                  setOpen(false);
                }}
              >
                Record actual
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className="mt-2 w-full text-center text-xs text-text-muted underline"
            onClick={() => setOpen(false)}
          >
            Close
          </button>
        </div>
      ) : null}
    </div>
  );
}
