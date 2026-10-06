/**
 * Enter one nurse's ranked choices for a round. v1 is manager-entered: the manager transcribes
 * the nurse's sheet. Entering again for the same nurse replaces their bid — one sheet each — so
 * the dialog opens on what is already recorded. Rank is the row's position; nobody types it, so a
 * gap or a repeat cannot happen here.
 */

import type { Id, IsoDate, LeaveBidChoice, Nurse } from '@shiftnurse/core';
import { type FormEvent, useId, useState } from 'react';
import type { LeaveBidRecord, LeaveBidRoundRecord } from '../../../../shared/api.js';
import { useSubmitLeaveBid } from '../../api-leave-bidding.js';
import { DateField } from '../../components/date-field.js';
import { Field } from '../../components/field-help.js';
import { Modal } from '../../components/modal.js';
import { errorMessage, INPUT, PRIMARY, SECONDARY, SMALL } from '../../components/ui.js';
import { formatDate } from '../../format.js';

interface Row {
  startDate: IsoDate | '';
  endDate: IsoDate | '';
}

interface Props {
  round: LeaveBidRoundRecord;
  nurses: readonly Nurse[];
  bids: readonly LeaveBidRecord[];
  /** Open on this nurse, or on a blank form. */
  nurseId?: Id;
  onClose: () => void;
}

export function BidEntryDialog({ round, nurses, bids, nurseId: initialNurse, onClose }: Props) {
  const submit = useSubmitLeaveBid(round.id);
  const ids = useId();
  const [nurseId, setNurseId] = useState<string>(initialNurse ?? '');
  const rowsFor = (id: string): Row[] =>
    bids
      .find((b) => b.nurseId === id)
      ?.choices.map((c) => ({
        startDate: c.startDate,
        endDate: c.endDate,
      })) ?? [{ startDate: '', endDate: '' }];
  const [rows, setRows] = useState<Row[]>(() => rowsFor(initialNurse ?? ''));

  const choices = [...nurses]
    .filter((n) => n.active)
    .sort((a, b) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`));

  const incomplete = rows.some((r) => !r.startDate || !r.endDate);
  const backwards = rows.some((r) => r.startDate && r.endDate && r.endDate < r.startDate);
  const problem = !nurseId
    ? 'Choose a nurse.'
    : incomplete
      ? 'Enter the first and last day of every choice, or remove the empty ones.'
      : backwards
        ? 'A choice ends before it starts.'
        : undefined;
  const error = errorMessage(submit.error);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (problem) return;
    const payload: LeaveBidChoice[] = rows.map((r, i) => ({
      rank: i + 1,
      startDate: r.startDate as IsoDate,
      endDate: r.endDate as IsoDate,
    }));
    submit.mutate({ nurseId, choices: payload }, { onSuccess: onClose });
  };

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      size="md"
      variant="popup"
      title="Enter a nurse’s bid"
      description={`Choices for ${round.name}, best first. They must fall between ${formatDate(round.coversStart)} and ${formatDate(round.coversEnd)}.`}
    >
      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-4">
        <Field id={`${ids}-nurse`} label="Nurse">
          <select
            id={`${ids}-nurse`}
            className={INPUT}
            value={nurseId}
            disabled={initialNurse !== undefined}
            onChange={(e) => {
              setNurseId(e.target.value);
              setRows(rowsFor(e.target.value));
            }}
          >
            <option value="">Choose a nurse…</option>
            {choices.map((n) => (
              <option key={n.id} value={n.id}>
                {n.lastName}, {n.firstName}
              </option>
            ))}
          </select>
        </Field>

        {rows.map((row, i) => (
          // Rows are only ever appended or removed from the end of a short list; position is rank.
          // biome-ignore lint/suspicious/noArrayIndexKey: the row's position is its rank
          <div key={i} className="grid grid-cols-[auto_1fr_1fr_auto] items-end gap-3">
            <span className="pb-2 text-sm font-medium text-text">Choice {i + 1}</span>
            <DateField
              id={`${ids}-start-${i}`}
              label={`Choice ${i + 1} first day`}
              value={row.startDate}
              min={round.coversStart}
              max={round.coversEnd}
              onChange={(v) => setRow(i, { startDate: v })}
            />
            <DateField
              id={`${ids}-end-${i}`}
              label={`Choice ${i + 1} last day`}
              value={row.endDate}
              min={round.coversStart}
              max={round.coversEnd}
              onChange={(v) => setRow(i, { endDate: v })}
            />
            <button
              type="button"
              className={`${SMALL} mb-1`}
              disabled={rows.length === 1}
              onClick={() => setRows(rows.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </div>
        ))}
        <div>
          <button
            type="button"
            className={SMALL}
            onClick={() => setRows([...rows, { startDate: '', endDate: '' }])}
          >
            Add a choice
          </button>
        </div>

        {problem && nurseId ? <p className="text-xs text-text-muted">{problem}</p> : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={SECONDARY} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={PRIMARY} disabled={submit.isPending || !!problem}>
            {submit.isPending ? 'Saving…' : 'Save bid'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
