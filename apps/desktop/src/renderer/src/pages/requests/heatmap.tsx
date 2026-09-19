/**
 * The overlapping-requests calendar: one cell per day, darker the more nurses are off.
 *
 * Approved and pending are told apart by *form*, not just hue — approved fills the cell,
 * pending draws a dashed ring — because "how many people have I already let go" and "how many
 * are asking" are different questions and a manager scanning for the dangerous weekend needs
 * both at a glance without a legend lookup. One hue (the accent) carries magnitude; the
 * numbers are printed in the cell so nobody has to judge a shade.
 */

import type { IsoDate } from '@shiftnurse/core';
import { weekdayOf } from '@shiftnurse/core';
import { formatDateWithWeekday } from '../../format.js';
import { describeDay, type HeatmapDay, weeksOf } from './heatmap-data.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface HeatmapProps {
  days: readonly HeatmapDay[];
  selectedDate: IsoDate | undefined;
  onSelectDate: (date: IsoDate | undefined) => void;
}

export function RequestHeatmap({ days, selectedDate, onSelectDate }: HeatmapProps) {
  const max = Math.max(1, ...days.map((d) => d.approved + d.pending));
  const weeks = weeksOf(days, weekdayOf);
  return (
    <div data-testid="request-heatmap">
      <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-text-muted">
        {WEEKDAYS.map((w) => (
          <div key={w}>{w}</div>
        ))}
      </div>
      {weeks.map((week) => (
        <div key={week[0]!.date} className="mt-1 grid grid-cols-7 gap-1">
          {week.map((cell) =>
            cell.day === undefined ? (
              <div key={cell.date} aria-hidden="true" />
            ) : (
              <DayCell
                key={cell.date}
                day={cell.day}
                max={max}
                selected={cell.date === selectedDate}
                onClick={() => onSelectDate(cell.date === selectedDate ? undefined : cell.date)}
              />
            ),
          )}
        </div>
      ))}
      <div className="mt-2 flex items-center gap-4 text-[11px] text-text-muted">
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm bg-accent/70" aria-hidden="true" />
          approved
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-3 w-3 rounded-sm border-2 border-dashed border-accent"
            aria-hidden="true"
          />
          pending
        </span>
        <span>darker = more nurses off · click a day to filter the queue</span>
      </div>
    </div>
  );
}

function DayCell({
  day,
  max,
  selected,
  onClick,
}: {
  day: HeatmapDay;
  max: number;
  selected: boolean;
  onClick: () => void;
}) {
  const total = day.approved + day.pending;
  // Approved drives the fill; the floor keeps a single approval visible, the cap keeps the
  // printed numbers legible on the darkest cell.
  const fill = day.approved === 0 ? 0 : 0.2 + 0.6 * (day.approved / max);
  const label = `${formatDateWithWeekday(day.date)}: ${describeDay(day)}`;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      title={label}
      onClick={onClick}
      className={`relative flex h-12 flex-col items-start justify-between rounded-md border p-1 text-left
        ${selected ? 'ring-2 ring-accent ring-offset-1 ring-offset-surface' : ''}
        ${day.pending > 0 ? 'border-2 border-dashed border-accent' : 'border-border'}`}
      style={{
        backgroundColor: `color-mix(in oklab, var(--color-accent) ${Math.round(fill * 100)}%, var(--color-surface))`,
      }}
    >
      <span className="text-[10px] text-text-muted">{day.date.slice(8)}</span>
      {total > 0 ? (
        <span className="text-xs font-semibold text-text">
          {day.approved > 0 ? day.approved : ''}
          {day.approved > 0 && day.pending > 0 ? ' + ' : ''}
          {day.pending > 0 ? `${day.pending}?` : ''}
        </span>
      ) : null}
    </button>
  );
}
