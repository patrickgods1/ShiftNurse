/**
 * What an award did, nurse by nurse in the order they were served. A denial's reason is core's
 * sentence, shown word for word: it is what the manager reads to the nurse and quotes if the
 * denial is grieved, so the screen never rewords it.
 */

import type { LeaveBidAwardResult } from '../../../../shared/api.js';
import { periodRange } from '../../format.js';

export function BidResult({ result }: { result: LeaveBidAwardResult }) {
  return (
    <section
      aria-labelledby="bid-result-heading"
      className="mt-4 rounded-md border border-border bg-surface p-4"
      data-testid="bid-result"
    >
      <h3 id="bid-result-heading" className="text-sm font-semibold text-text">
        Awarded: {result.awards.length} won, {result.denials.length} not awarded
      </h3>
      <p className="mb-3 text-xs text-text-muted">
        In seniority order. Each award is now approved PTO, and the nurse is off any draft shifts on
        those days.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-xs text-text-muted">
              <th className="px-2 py-1 font-medium">Order</th>
              <th className="px-2 py-1 font-medium">Nurse</th>
              <th className="px-2 py-1 font-medium">Awarded</th>
              <th className="px-2 py-1 font-medium">Not awarded</th>
            </tr>
          </thead>
          <tbody>
            {result.order.map((entry, i) => {
              const awards = result.awards.filter((a) => a.nurseId === entry.nurseId);
              const denials = result.denials.filter((d) => d.nurseId === entry.nurseId);
              return (
                <tr key={entry.nurseId} className="border-t border-border align-top">
                  <td className="whitespace-nowrap px-2 py-2 text-text-muted">{i + 1}</td>
                  <td className="px-2 py-2 font-medium text-text">{entry.nurseName}</td>
                  <td className="px-2 py-2">
                    {awards.length === 0 ? (
                      <span className="text-text-muted">None</span>
                    ) : (
                      <ul className="flex flex-col gap-1">
                        {awards.map((a) => (
                          <li key={`${a.bidId}-${a.rank}`}>
                            Choice {a.rank}: {periodRange(a)}
                            {a.liftedShifts > 0 ? (
                              <span className="ml-1 text-xs text-text-muted">
                                ({a.liftedShifts} draft shift{a.liftedShifts === 1 ? '' : 's'} taken
                                off)
                              </span>
                            ) : null}
                            {a.stillRostered > 0 ? (
                              <span className="ml-1 text-xs text-warn">
                                ({a.stillRostered} published shift
                                {a.stillRostered === 1 ? '' : 's'} still rostered)
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    {denials.length === 0 ? (
                      <span className="text-text-muted">—</span>
                    ) : (
                      <ul className="flex flex-col gap-1">
                        {denials.map((d) => (
                          <li key={`${d.bidId}-${d.rank}`} data-testid="bid-denial">
                            {d.reason}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
