/**
 * The one thing every non-demo setup needs: the unit. Its pay-period length and anchor are
 * asked here because every contracted-hours check is counted per pay period, and moving the
 * calendar after hours have been counted in it would re-judge the past.
 */

import type { UnitInput } from '@shared/api.js';
import { ACUITY_PRESETS, isIsoDate, isoDate, today } from '@shiftnurse/core';
import { type FormEvent, useId, useState } from 'react';
import { errorMessage, INPUT, LABEL, PRIMARY, SECONDARY } from '../components/ui.js';
import { defaultPayPeriodAnchor } from './steps.js';

const UNIT_TYPES = Object.values(ACUITY_PRESETS).map((p) => p.unitType);

interface UnitFormProps {
  submitLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: (input: UnitInput) => void;
  onBack: () => void;
}

export function UnitForm({ submitLabel, pending, error, onSubmit, onBack }: UnitFormProps) {
  const listId = useId();
  const [name, setName] = useState('');
  const [unitType, setUnitType] = useState('Medical-Surgical');
  const [payPeriodDays, setPayPeriodDays] = useState(14);
  const [anchor, setAnchor] = useState<string>(defaultPayPeriodAnchor(today()));
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === '') return setProblem('Give the unit a name.');
    if (!isIsoDate(anchor)) return setProblem('Choose the date a pay period starts on.');
    setProblem(undefined);
    onSubmit({
      name: name.trim(),
      unitType: unitType.trim(),
      payPeriodDays,
      payPeriodAnchor: isoDate(anchor),
    });
  };

  const message = problem ?? errorMessage(error);

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-testid="setup-unit-form">
      <label className={LABEL}>
        Unit name
        <input
          className={INPUT}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. 4 West Medical-Surgical"
          // biome-ignore lint/a11y/noAutofocus: the form's only purpose; focus belongs here.
          autoFocus
        />
      </label>
      <label className={LABEL}>
        Unit type
        <input
          className={INPUT}
          list={listId}
          value={unitType}
          onChange={(e) => setUnitType(e.target.value)}
        />
        <datalist id={listId}>
          {UNIT_TYPES.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <span>Used to suggest patient ratios later. Any wording is fine.</span>
      </label>
      <div className="grid grid-cols-2 gap-4">
        <label className={LABEL}>
          Pay period
          <select
            className={INPUT}
            value={payPeriodDays}
            onChange={(e) => setPayPeriodDays(Number(e.target.value))}
          >
            <option value={7}>Weekly (7 days)</option>
            <option value={14}>Every two weeks (14 days)</option>
          </select>
        </label>
        <label className={LABEL}>
          A pay period starts on
          <input
            type="date"
            className={INPUT}
            value={anchor}
            onChange={(e) => setAnchor(e.target.value)}
          />
        </label>
      </div>
      <p className="text-xs text-text-muted">
        Contracted hours are checked per pay period, so these cannot be changed once schedules
        exist. Any past or future start date works: the calendar repeats from it.
      </p>
      {message !== undefined ? (
        <p role="alert" className="text-sm text-danger">
          {message}
        </p>
      ) : null}
      <div className="flex justify-between">
        <button type="button" className={SECONDARY} onClick={onBack} disabled={pending}>
          Back
        </button>
        <button type="submit" className={PRIMARY} disabled={pending}>
          {pending ? 'Creating…' : submitLabel}
        </button>
      </div>
    </form>
  );
}
