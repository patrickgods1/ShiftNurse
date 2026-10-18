/**
 * One census grid cell: a click target that expands into an inline editor for projected census
 * (and, for a past date, actual census) plus the per-tier acuity mix. Kept as its own popover
 * rather than a modal so a manager can tab across a week filling in numbers without a dialog
 * stealing focus each time.
 */

import type { AcuityTier, CensusForecast, Id } from '@shiftnurse/core';
import { validateAcuityMix } from '@shiftnurse/core';
import { useEffect, useRef, useState } from 'react';
import { PRIMARY } from '../../components/ui.js';
import { usePanelFocus } from '../../components/use-panel-focus.js';
import { numberFieldProblem, numberFieldText, parseIntegerField } from '../../field-values.js';

interface CensusCellProps {
  date: string;
  shiftTypeId: Id;
  existing: CensusForecast | undefined;
  tiers: AcuityTier[];
  isPast: boolean;
  onSaveForecast: (census: number, mix: Record<Id, number>) => void;
  onSaveActual: (census: number, mix: Record<Id, number>) => void;
  saving: boolean;
}

type MixText = Record<Id, string>;

const COUNT = { min: 0, integer: true } as const;
const TIER_COUNT = { ...COUNT, allowBlank: true } as const;

function mixText(tiers: AcuityTier[], seed: Record<Id, number> | undefined): MixText {
  const mix: MixText = {};
  for (const tier of tiers) mix[tier.id] = numberFieldText(seed?.[tier.id] ?? 0);
  return mix;
}

/** A blank tier counts as 0 for the sum and stays blank on screen. */
function mixNumbers(tiers: AcuityTier[], text: MixText): Record<Id, number> {
  const mix: Record<Id, number> = {};
  for (const tier of tiers) mix[tier.id] = parseIntegerField(text[tier.id] ?? '') ?? 0;
  return mix;
}

/**
 * Each field's own problem first (blank, fractional, negative); the mix-versus-census check only
 * runs once every field parses, so it never judges a number the manager has not finished typing.
 */
function problemsFor(
  censusText: string,
  text: MixText,
  tiers: AcuityTier[],
): { census: string | undefined; tiers: Map<Id, string>; mix: string[] } {
  const census = numberFieldProblem(censusText, COUNT);
  const tierProblems = new Map<Id, string>();
  for (const tier of tiers) {
    const p = numberFieldProblem(text[tier.id] ?? '', TIER_COUNT);
    if (p !== undefined) tierProblems.set(tier.id, p);
  }
  const mix =
    census === undefined && tierProblems.size === 0
      ? validateAcuityMix(parseIntegerField(censusText) ?? 0, mixNumbers(tiers, text), tiers)
      : [];
  return { census, tiers: tierProblems, mix };
}

function Problem({ id, children }: { id: string; children: string | undefined }) {
  return children === undefined ? null : (
    <p id={id} className="mt-0.5 text-xs text-danger">
      {children}
    </p>
  );
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
  const [census, setCensus] = useState(numberFieldText(existing?.projectedCensus ?? 0));
  const [mix, setMix] = useState<MixText>(() => mixText(tiers, existing?.acuityMix));
  const [actualCensus, setActualCensus] = useState(numberFieldText(existing?.actualCensus ?? 0));
  const [actualMix, setActualMix] = useState<MixText>(() =>
    mixText(tiers, existing?.actualAcuityMix),
  );
  const cellRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  usePanelFocus(popoverRef, open, () => setOpen(false));

  // Seed the drafts only as the editor opens: a background refetch changes `existing`'s identity,
  // and re-seeding then would wipe what the manager is in the middle of typing.
  const wasOpen = useRef(false);
  useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opening) return;
    setCensus(numberFieldText(existing?.projectedCensus ?? 0));
    setMix(mixText(tiers, existing?.acuityMix));
    setActualCensus(numberFieldText(existing?.actualCensus ?? 0));
    setActualMix(mixText(tiers, existing?.actualAcuityMix));
  }, [open, existing, tiers]);

  const forecast = problemsFor(census, mix, tiers);
  const actual = problemsFor(actualCensus, actualMix, tiers);
  const forecastInvalid =
    forecast.census !== undefined || forecast.tiers.size > 0 || forecast.mix.length > 0;
  const actualInvalid =
    actual.census !== undefined || actual.tiers.size > 0 || actual.mix.length > 0;

  const label = existing === undefined ? '—' : String(existing.projectedCensus);
  const isForecast = existing?.source === 'forecast';
  const inputClass = 'rounded border border-border bg-bg px-2 py-1 text-sm text-text';

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
          ref={popoverRef}
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
              onChange={(e) => setCensus(e.target.value)}
              className={`mt-1 w-full ${inputClass}`}
            />
            <Problem id={`census-${date}-${shiftTypeId}-problem`}>{forecast.census}</Problem>
          </div>
          <fieldset className="mb-2">
            <legend className="text-xs font-medium text-text-muted">Acuity mix</legend>
            {tiers.map((tier) => (
              <div key={tier.id} className="mt-1">
                <div className="flex items-center justify-between gap-2">
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
                    value={mix[tier.id] ?? ''}
                    onChange={(e) => setMix((m) => ({ ...m, [tier.id]: e.target.value }))}
                    className={`w-20 ${inputClass}`}
                  />
                </div>
                <Problem id={`mix-${date}-${shiftTypeId}-${tier.id}-problem`}>
                  {forecast.tiers.get(tier.id)}
                </Problem>
              </div>
            ))}
          </fieldset>
          {forecast.mix.length > 0 ? (
            <p className="mb-2 text-xs text-danger">{forecast.mix.join('; ')}</p>
          ) : null}
          <button
            type="button"
            disabled={forecastInvalid || saving}
            className={`${PRIMARY} w-full`}
            onClick={() => {
              onSaveForecast(parseIntegerField(census) ?? 0, mixNumbers(tiers, mix));
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
                  onChange={(e) => setActualCensus(e.target.value)}
                  className={`mt-1 w-full ${inputClass}`}
                />
                <Problem id={`actual-${date}-${shiftTypeId}-problem`}>{actual.census}</Problem>
              </div>
              <fieldset className="mb-2">
                <legend className="text-xs font-medium text-text-muted">Actual mix</legend>
                {tiers.map((tier) => (
                  <div key={tier.id} className="mt-1">
                    <div className="flex items-center justify-between gap-2">
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
                        value={actualMix[tier.id] ?? ''}
                        onChange={(e) => setActualMix((m) => ({ ...m, [tier.id]: e.target.value }))}
                        className={`w-20 ${inputClass}`}
                      />
                    </div>
                    <Problem id={`actual-mix-${date}-${shiftTypeId}-${tier.id}-problem`}>
                      {actual.tiers.get(tier.id)}
                    </Problem>
                  </div>
                ))}
              </fieldset>
              {actual.mix.length > 0 ? (
                <p className="mb-2 text-xs text-danger">{actual.mix.join('; ')}</p>
              ) : null}
              <button
                type="button"
                disabled={actualInvalid || saving || existing === undefined}
                className="w-full rounded-md border border-border px-3 py-1.5 text-sm font-medium
                  text-text disabled:opacity-50"
                onClick={() => {
                  onSaveActual(parseIntegerField(actualCensus) ?? 0, mixNumbers(tiers, actualMix));
                  setOpen(false);
                }}
              >
                Record actual
              </button>
              {existing === undefined ? (
                // A recorded actual against an invented forecast would score as a perfect forecast
                // in the back-test, so the requirement stays; the reason is visible, not a tooltip.
                <p className="mt-1 text-xs text-text-muted">
                  Enter the forecast for this shift first; the back-test compares the two.
                </p>
              ) : null}
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
