/**
 * Create or edit a bidding round: the season, the bidding window and how many nurses of each
 * role may be off on any one day. The places are the manager's call from what the unit can spare
 * (the leave capacity on this page is the guide); a role left blank has no places and may not win.
 */

import type { Id, IsoDate, NurseRole } from '@shiftnurse/core';
import { type FormEvent, useId, useState } from 'react';
import type { LeaveBidRoundRecord } from '../../../../shared/api.js';
import { useCreateLeaveBidRound, useUpdateLeaveBidRound } from '../../api-leave-bidding.js';
import { DateField } from '../../components/date-field.js';
import { describedBy, Field } from '../../components/field-help.js';
import { Modal } from '../../components/modal.js';
import { errorMessage, INPUT, PRIMARY, SECONDARY } from '../../components/ui.js';

const ROLES: NurseRole[] = ['RN', 'LPN', 'CNA'];

interface Props {
  unitId: Id;
  round: LeaveBidRoundRecord | undefined;
  onClose: () => void;
}

export function BidRoundDialog({ unitId, round, onClose }: Props) {
  const create = useCreateLeaveBidRound(unitId);
  const update = useUpdateLeaveBidRound(unitId);
  const ids = useId();

  const [name, setName] = useState(round?.name ?? '');
  const [coversStart, setCoversStart] = useState<IsoDate | ''>(round?.coversStart ?? '');
  const [coversEnd, setCoversEnd] = useState<IsoDate | ''>(round?.coversEnd ?? '');
  const [opensOn, setOpensOn] = useState<IsoDate | ''>(round?.opensOn ?? '');
  const [closesOn, setClosesOn] = useState<IsoDate | ''>(round?.closesOn ?? '');
  const [places, setPlaces] = useState<Record<NurseRole, string>>({
    RN: round?.offPerDay.RN?.toString() ?? '',
    LPN: round?.offPerDay.LPN?.toString() ?? '',
    CNA: round?.offPerDay.CNA?.toString() ?? '',
  });
  const [limit, setLimit] = useState(round?.maxAwardsPerNurse?.toString() ?? '');

  const placeCounts = ROLES.flatMap((role) =>
    places[role].trim() === '' ? [] : [[role, Number(places[role])] as const],
  );
  const badPlace = placeCounts.find(([, n]) => !Number.isInteger(n) || n < 0);
  const limitNumber = limit.trim() === '' ? undefined : Number(limit);

  const problem = !name.trim()
    ? 'Give the round a name.'
    : !coversStart || !coversEnd
      ? 'Enter the first and last day the round covers.'
      : coversEnd < coversStart
        ? 'The season ends before it starts.'
        : !opensOn || !closesOn
          ? 'Enter when bidding opens and closes.'
          : closesOn < opensOn
            ? 'Bidding closes before it opens.'
            : badPlace
              ? `Places off a day for ${badPlace[0]}s must be a whole number, zero or more.`
              : placeCounts.length === 0
                ? 'Give at least one role a place off a day.'
                : limitNumber !== undefined && (!Number.isInteger(limitNumber) || limitNumber < 1)
                  ? 'The most choices one nurse can win must be a whole number, 1 or more.'
                  : undefined;

  const pending = create.isPending || update.isPending;
  const error = errorMessage(create.error ?? update.error);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (problem || !coversStart || !coversEnd || !opensOn || !closesOn) return;
    const offPerDay = Object.fromEntries(placeCounts) as Partial<Record<NurseRole, number>>;
    if (round) {
      update.mutate(
        {
          id: round.id,
          patch: {
            name: name.trim(),
            coversStart,
            coversEnd,
            opensOn,
            closesOn,
            offPerDay,
            maxAwardsPerNurse: limitNumber ?? null,
          },
        },
        { onSuccess: onClose },
      );
    } else {
      create.mutate(
        {
          unitId,
          name: name.trim(),
          coversStart,
          coversEnd,
          opensOn,
          closesOn,
          offPerDay,
          ...(limitNumber !== undefined ? { maxAwardsPerNurse: limitNumber } : {}),
        },
        { onSuccess: onClose },
      );
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      size="md"
      variant="popup"
      title={round ? 'Edit bidding round' : 'New bidding round'}
      description="A season of prime-time leave that nurses bid for in seniority order."
    >
      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-4">
        <Field id={`${ids}-name`} label="Name">
          <input
            id={`${ids}-name`}
            className={INPUT}
            value={name}
            placeholder="Summer 2027"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <DateField
            id={`${ids}-covers-start`}
            label="Season starts"
            value={coversStart}
            onChange={setCoversStart}
            hint="First day nurses can bid for."
          />
          <DateField
            id={`${ids}-covers-end`}
            label="Season ends"
            value={coversEnd}
            onChange={setCoversEnd}
            hint="Last day nurses can bid for."
          />
          <DateField
            id={`${ids}-opens`}
            label="Bidding opens"
            value={opensOn}
            onChange={setOpensOn}
          />
          <DateField
            id={`${ids}-closes`}
            label="Bidding closes"
            value={closesOn}
            onChange={setClosesOn}
          />
        </div>

        <fieldset className="flex flex-col gap-2 border-0 p-0">
          <legend className="text-sm font-medium text-text">Places off per day</legend>
          <p className="text-xs text-text-muted">
            How many nurses of each role may be off on any one day. Leave a role blank and nobody of
            that role can win.
          </p>
          <div className="grid grid-cols-3 gap-4">
            {ROLES.map((role) => (
              <Field key={role} id={`${ids}-places-${role}`} label={role} compact>
                <input
                  id={`${ids}-places-${role}`}
                  type="number"
                  min={0}
                  step={1}
                  className={INPUT}
                  value={places[role]}
                  onChange={(e) => setPlaces({ ...places, [role]: e.target.value })}
                />
              </Field>
            ))}
          </div>
        </fieldset>

        <Field
          id={`${ids}-limit`}
          label="Most choices one nurse can win (optional)"
          hint="Blank: no limit. With a limit, a nurse's later choices are passed over once they have won that many."
          tip="Contracts often cap prime-time leave at a week or two a nurse so that everyone gets a share. Each pass of the award gives a nurse at most one choice, so a cap only matters past the first passes."
        >
          <input
            id={`${ids}-limit`}
            type="number"
            min={1}
            step={1}
            className={INPUT}
            aria-describedby={describedBy(`${ids}-limit`, { hint: true })}
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
          />
        </Field>

        {problem && (name || coversStart || coversEnd || opensOn || closesOn) ? (
          <p className="text-xs text-text-muted">{problem}</p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={SECONDARY} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={PRIMARY} disabled={pending || !!problem}>
            {pending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
