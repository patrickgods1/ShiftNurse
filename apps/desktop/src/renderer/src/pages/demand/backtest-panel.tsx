/**
 * Compares recorded forecasts against what the same simple model would have said from prior
 * history alone. This is the honesty check on the forecaster: if the model would have done
 * better than what the manager actually entered, hand-editing is hurting, not helping.
 */

import type { BacktestResult, ErrorSummary, ShiftType } from '@shiftnurse/core';

interface BacktestPanelProps {
  result: BacktestResult;
  shiftTypesById: Map<string, ShiftType>;
}

function SummaryCard({ title, summary }: { title: string; summary: ErrorSummary }) {
  return (
    <div className="rounded-md border border-border bg-surface p-4">
      <p className="text-sm font-medium text-text-muted">{title}</p>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
        <dt className="text-text-muted">Samples</dt>
        <dd className="text-text">{summary.samples}</dd>
        <dt className="text-text-muted">MAE</dt>
        <dd className="text-text">{summary.meanAbsoluteError.toFixed(1)}</dd>
        <dt className="text-text-muted">MAPE</dt>
        <dd className="text-text">{summary.meanAbsolutePercentageError.toFixed(1)}%</dd>
        <dt className="text-text-muted">Bias</dt>
        <dd className="text-text">
          {summary.bias >= 0 ? '+' : ''}
          {summary.bias.toFixed(1)}
        </dd>
      </dl>
    </div>
  );
}

export function BacktestPanel({ result, shiftTypesById }: BacktestPanelProps) {
  const modelBeatsRecorded =
    result.model.samples > 0 &&
    result.recorded.samples > 0 &&
    result.model.meanAbsoluteError < result.recorded.meanAbsoluteError;

  const byShiftType = Object.entries(result.byShiftType);

  return (
    <div data-testid="backtest-panel">
      <div className="grid grid-cols-2 gap-4">
        <SummaryCard title="Recorded forecasts" summary={result.recorded} />
        <SummaryCard title="Model (from history alone)" summary={result.model} />
      </div>

      {result.recorded.samples > 0 && result.model.samples > 0 ? (
        <p className="mt-3 text-sm text-text-muted">
          {modelBeatsRecorded
            ? 'The model beats the recorded forecasts here — manual edits are hurting more than helping.'
            : 'The recorded forecasts beat the model — manual edits are earning their keep; the model needs work.'}{' '}
          Bias: "+" means a forecast ran high.
        </p>
      ) : (
        <p className="mt-3 text-sm text-text-muted">
          Not enough recorded actuals yet to compare recorded forecasts against the model.
        </p>
      )}

      {byShiftType.length > 0 ? (
        <table className="mt-4 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-text-muted">
              <th className="px-3 py-2 font-medium">Shift</th>
              <th className="px-3 py-2 font-medium">Recorded MAE</th>
              <th className="px-3 py-2 font-medium">Recorded MAPE</th>
              <th className="px-3 py-2 font-medium">Recorded bias</th>
              <th className="px-3 py-2 font-medium">Model MAE</th>
              <th className="px-3 py-2 font-medium">Model MAPE</th>
              <th className="px-3 py-2 font-medium">Model bias</th>
            </tr>
          </thead>
          <tbody>
            {byShiftType.map(([shiftTypeId, entry]) => (
              <tr key={shiftTypeId} className="border-b border-border last:border-0">
                <td className="px-3 py-2 text-text">
                  {shiftTypesById.get(shiftTypeId)?.name ?? shiftTypeId}
                </td>
                <td className="px-3 py-2 text-text">
                  {entry.recorded.meanAbsoluteError.toFixed(1)}
                </td>
                <td className="px-3 py-2 text-text">
                  {entry.recorded.meanAbsolutePercentageError.toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-text">
                  {entry.recorded.bias >= 0 ? '+' : ''}
                  {entry.recorded.bias.toFixed(1)}
                </td>
                <td className="px-3 py-2 text-text">{entry.model.meanAbsoluteError.toFixed(1)}</td>
                <td className="px-3 py-2 text-text">
                  {entry.model.meanAbsolutePercentageError.toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-text">
                  {entry.model.bias >= 0 ? '+' : ''}
                  {entry.model.bias.toFixed(1)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
