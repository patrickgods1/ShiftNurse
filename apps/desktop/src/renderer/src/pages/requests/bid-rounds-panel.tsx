/**
 * Requests › Bid rounds: seniority bidding for a season of prime-time leave.
 *
 * The manager sets up a round (the season, the places off a day per role), enters each nurse's
 * ranked choices, and awards the round once. The award is one decision with a record: it approves
 * every awarded week as PTO and writes a reason for every choice not awarded, so the table shown
 * afterwards is what to read to a nurse who asks why.
 */

import type { Id, Nurse } from '@shiftnurse/core';
import { useState } from 'react';
import type { LeaveBidAwardResult, LeaveBidRoundRecord } from '../../../../shared/api.js';
import {
  useAwardLeaveBidRound,
  useCloseLeaveBidRound,
  useLeaveBidRounds,
  useLeaveBids,
} from '../../api-leave-bidding.js';
import { AsyncState } from '../../components/async-state.js';
import { useConfirm } from '../../components/confirm.js';
import { LabelWithTip } from '../../components/field-help.js';
import { errorMessage, PRIMARY, SECONDARY, SMALL } from '../../components/ui.js';
import { formatDate, periodRange } from '../../format.js';
import { BidEntryDialog } from './bid-entry-dialog.js';
import { BidResult } from './bid-result.js';
import { BidRoundDialog } from './bid-round-dialog.js';

const STATUS_LABEL = { open: 'Open', closed: 'Closed', awarded: 'Awarded' } as const;

const SENIORITY_TIP =
  'Nurses are served by seniority date, then employee number. Each gets their highest-ranked ' +
  'choice that still has a place for their role. Everyone gets a first choice before anyone gets ' +
  'a second: the award goes round in passes, one choice a nurse a pass.';

interface Props {
  unitId: Id;
  nurses: readonly Nurse[];
}

export function BidRoundsPanel({ unitId, nurses }: Props) {
  const rounds = useLeaveBidRounds(unitId);
  const [selectedId, setSelectedId] = useState<Id | undefined>(undefined);
  const [editing, setEditing] = useState<'new' | LeaveBidRoundRecord | undefined>(undefined);
  // The award's table is not stored (its reasons are in the audit log), so it is kept while the
  // page is open, per round.
  const [results, setResults] = useState<Record<Id, LeaveBidAwardResult>>({});

  const list = rounds.data ?? [];
  const selected = list.find((r) => r.id === selectedId) ?? list[0];

  return (
    <section aria-labelledby="bid-rounds-heading" data-testid="bid-rounds-panel">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h2 id="bid-rounds-heading" className="text-sm font-semibold text-text">
            <LabelWithTip label="Bid rounds" tip={SENIORITY_TIP} />
          </h2>
          <p className="text-sm text-text-muted">
            Nurses rank the leave they want for a season; the award goes in seniority order. A
            nurse’s choice that cannot be given is passed over, with the reason written down.
          </p>
        </div>
        <button
          type="button"
          className={PRIMARY}
          data-testid="new-bid-round"
          onClick={() => setEditing('new')}
        >
          New round
        </button>
      </div>

      {rounds.isPending ? (
        <AsyncState status="loading" label="Loading bid rounds" />
      ) : rounds.isError ? (
        <AsyncState status="error" label="Could not load bid rounds" error={rounds.error} />
      ) : list.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-sm text-text-muted">
          No bid rounds yet.
        </p>
      ) : (
        <>
          <ul className="mb-4 flex flex-wrap gap-2" aria-label="Bid rounds">
            {list.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  aria-pressed={selected?.id === r.id}
                  className={`rounded-md border border-border px-3 py-1.5 text-sm ${
                    selected?.id === r.id ? 'bg-accent text-white' : 'bg-surface text-text'
                  }`}
                  onClick={() => setSelectedId(r.id)}
                >
                  {r.name} · {STATUS_LABEL[r.status]}
                </button>
              </li>
            ))}
          </ul>
          {selected ? (
            <RoundDetail
              key={selected.id}
              unitId={unitId}
              round={selected}
              nurses={nurses}
              result={results[selected.id]}
              onEdit={() => setEditing(selected)}
              onAwarded={(result) => setResults((prev) => ({ ...prev, [selected.id]: result }))}
            />
          ) : null}
        </>
      )}

      {editing !== undefined ? (
        <BidRoundDialog
          unitId={unitId}
          round={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
    </section>
  );
}

interface DetailProps {
  unitId: Id;
  round: LeaveBidRoundRecord;
  nurses: readonly Nurse[];
  result: LeaveBidAwardResult | undefined;
  onEdit: () => void;
  onAwarded: (result: LeaveBidAwardResult) => void;
}

function RoundDetail({ unitId, round, nurses, result, onEdit, onAwarded }: DetailProps) {
  const bids = useLeaveBids(round.id);
  const close = useCloseLeaveBidRound(unitId);
  const award = useAwardLeaveBidRound(unitId);
  const confirm = useConfirm();
  const [entering, setEntering] = useState<'new' | Id | undefined>(undefined);
  const nameOf = new Map(nurses.map((n) => [n.id, `${n.firstName} ${n.lastName}`]));
  const bidList = bids.data ?? [];

  const places = Object.entries(round.offPerDay)
    .map(([role, n]) => `${n} ${role}${n === 1 ? '' : 's'}`)
    .join(', ');

  const onAward = async () => {
    const ok = await confirm({
      title: `Award ${round.name} in seniority order?`,
      description:
        `${bidList.length} nurse${bidList.length === 1 ? ' has' : 's have'} bid. Each awarded ` +
        'week becomes approved PTO and comes off draft schedules. A round can be awarded once.',
      confirmLabel: 'Award in seniority order',
      danger: false,
    });
    if (ok) award.mutate(round.id, { onSuccess: onAwarded });
  };

  return (
    <div data-testid="bid-round-detail">
      <div className="mb-3 flex items-start justify-between gap-4 rounded-md border border-border bg-surface p-4">
        <div className="text-sm">
          <div className="font-medium text-text">
            {round.name} · {STATUS_LABEL[round.status]}
          </div>
          <div className="mt-1 text-xs text-text-muted">
            Covers {periodRange({ startDate: round.coversStart, endDate: round.coversEnd })} ·
            bidding {formatDate(round.opensOn)} to {formatDate(round.closesOn)}
          </div>
          <div className="mt-1 text-xs text-text-muted">
            Places off a day: {places || 'none'}
            {round.maxAwardsPerNurse !== undefined
              ? ` · at most ${round.maxAwardsPerNurse} choice${round.maxAwardsPerNurse === 1 ? '' : 's'} a nurse`
              : ''}
          </div>
        </div>
        {round.status !== 'awarded' ? (
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={SMALL} onClick={onEdit}>
              Edit
            </button>
            {round.status === 'open' ? (
              <>
                <button
                  type="button"
                  className={SECONDARY}
                  data-testid="enter-bid"
                  onClick={() => setEntering('new')}
                >
                  Enter a bid
                </button>
                <button
                  type="button"
                  className={SECONDARY}
                  disabled={close.isPending}
                  onClick={() => close.mutate(round.id)}
                >
                  Close bidding
                </button>
              </>
            ) : null}
            <button
              type="button"
              className={PRIMARY}
              data-testid="award-round"
              disabled={bidList.length === 0 || award.isPending}
              onClick={() => void onAward()}
            >
              Award in seniority order
            </button>
          </div>
        ) : null}
      </div>

      {bids.isPending ? (
        <AsyncState status="loading" label="Loading bids" />
      ) : bids.isError ? (
        <AsyncState status="error" label="Could not load bids" error={bids.error} />
      ) : bidList.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-sm text-text-muted">
          No bids entered yet.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border bg-surface">
          {bidList.map((bid) => (
            <li key={bid.id} className="flex items-start justify-between gap-4 p-3">
              <div className="min-w-0 text-sm">
                <div className="font-medium text-text">
                  {nameOf.get(bid.nurseId) ?? bid.nurseId}
                </div>
                <ol className="mt-1 text-xs text-text-muted">
                  {bid.choices.map((c) => (
                    <li key={c.rank}>
                      {c.rank}. {periodRange(c)}
                    </li>
                  ))}
                </ol>
              </div>
              {round.status === 'open' ? (
                <button type="button" className={SMALL} onClick={() => setEntering(bid.nurseId)}>
                  Change bid
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {close.error || award.error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {errorMessage(close.error ?? award.error)}
        </p>
      ) : null}

      {result ? <BidResult result={result} /> : null}

      {entering !== undefined ? (
        <BidEntryDialog
          round={round}
          nurses={nurses}
          bids={bidList}
          {...(entering === 'new' ? {} : { nurseId: entering })}
          onClose={() => setEntering(undefined)}
        />
      ) : null}
    </div>
  );
}
