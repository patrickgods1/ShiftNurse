/**
 * The "Propose from history" flow. A forecaster proposal is not trusted until a manager has
 * looked at every row, so this is a dialog rather than a silent bulk write: rows default
 * ticked, except any that would clobber a manual entry the manager typed by hand, which
 * default unticked with an explicit warning.
 */

import * as Dialog from '@radix-ui/react-dialog';
import type { CensusForecast, CensusProposal, Id, ShiftType } from '@shiftnurse/core';
import { useEffect, useState } from 'react';
import { formatDateWithWeekday } from '../../format.js';

interface ProposeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  proposals: CensusProposal[];
  existing: CensusForecast[];
  shiftTypesById: Map<Id, ShiftType>;
  tierNames: Map<Id, string>;
  onAccept: (accepted: CensusProposal[]) => void;
  accepting: boolean;
}

function proposalKey(p: CensusProposal): string {
  return `${p.date}::${p.shiftTypeId}`;
}

function describeMix(mix: Record<Id, number>, tierNames: Map<Id, string>): string {
  const parts = Object.entries(mix)
    .filter(([, n]) => n > 0)
    .map(([tierId, n]) => `${tierNames.get(tierId) ?? tierId}: ${n}`);
  return parts.length > 0 ? parts.join(', ') : 'no acuity mix';
}

export function ProposeDialog({
  open,
  onOpenChange,
  proposals,
  existing,
  shiftTypesById,
  tierNames,
  onAccept,
  accepting,
}: ProposeDialogProps) {
  const manualKeys = new Set(
    existing.filter((e) => e.source === 'manual').map((e) => `${e.date}::${e.shiftTypeId}`),
  );
  const [checked, setChecked] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    const defaults = new Set(
      existing.filter((e) => e.source === 'manual').map((e) => `${e.date}::${e.shiftTypeId}`),
    );
    setChecked(new Set(proposals.filter((p) => !defaults.has(proposalKey(p))).map(proposalKey)));
  }, [open, proposals, existing]);

  const acceptedCount = checked.size;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          data-testid="propose-dialog"
          className="fixed z-50 left-1/2 top-1/2 max-h-[80vh] w-[720px] max-w-[90vw]
            -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-md border border-border
            bg-surface p-5 shadow-lg"
        >
          <Dialog.Title className="text-lg font-semibold text-text">
            Proposed census from history
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-muted">
            Untick any row you don't want. Rows with a manual entry already are unticked by default.
          </Dialog.Description>

          {proposals.length === 0 ? (
            <p className="mt-4 text-sm text-text-muted">
              No history available yet for this range — nothing to propose.
            </p>
          ) : (
            <table className="mt-4 w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left text-text-muted">
                  <th className="w-8 px-2 py-1.5" />
                  <th className="px-2 py-1.5 font-medium">Date</th>
                  <th className="px-2 py-1.5 font-medium">Shift</th>
                  <th className="px-2 py-1.5 font-medium">Census</th>
                  <th className="px-2 py-1.5 font-medium">Mix</th>
                  <th className="px-2 py-1.5 font-medium">Basis</th>
                </tr>
              </thead>
              <tbody>
                {proposals.map((p) => {
                  const key = proposalKey(p);
                  const wouldOverwriteManual = manualKeys.has(key);
                  const shiftType = shiftTypesById.get(p.shiftTypeId);
                  return (
                    <tr key={key} className="border-b border-border last:border-0 align-top">
                      <td className="px-2 py-1.5">
                        <input
                          type="checkbox"
                          aria-label={`Accept proposal for ${p.date} ${shiftType?.name ?? p.shiftTypeId}`}
                          checked={checked.has(key)}
                          onChange={(e) =>
                            setChecked((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(key);
                              else next.delete(key);
                              return next;
                            })
                          }
                        />
                      </td>
                      <td className="px-2 py-1.5 text-text">{formatDateWithWeekday(p.date)}</td>
                      <td className="px-2 py-1.5 text-text">{shiftType?.name ?? p.shiftTypeId}</td>
                      <td className="px-2 py-1.5 text-text">{p.projectedCensus}</td>
                      <td className="px-2 py-1.5 text-text">
                        {describeMix(p.acuityMix, tierNames)}
                      </td>
                      <td className="px-2 py-1.5 text-text-muted">
                        <div>
                          {p.basis.samples} sample{p.basis.samples === 1 ? '' : 's'}, weekday avg{' '}
                          {p.basis.weekdayAverage.toFixed(1)}
                          {p.basis.seasonalSamples > 0
                            ? `, seasonal index ${p.basis.seasonalIndex.toFixed(2)}`
                            : ''}
                        </div>
                        {wouldOverwriteManual ? (
                          <div className="mt-0.5 text-warn">would overwrite manual entry</div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              disabled={acceptedCount === 0 || accepting}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white
                disabled:opacity-50"
              onClick={() => onAccept(proposals.filter((p) => checked.has(proposalKey(p))))}
            >
              Accept {acceptedCount} proposal{acceptedCount === 1 ? '' : 's'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
