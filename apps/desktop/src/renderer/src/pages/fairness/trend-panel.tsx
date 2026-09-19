/**
 * The unit's Gini coefficient of nurse scores, one point per ledger period, oldest to newest.
 * A rising line means the schedule is concentrating burden on fewer nurses even if any single
 * period still looks fine in isolation — that drift is the thing a per-period report can't show
 * on its own.
 */

import type { FairnessTrendPoint } from '../../../../shared/api.js';
import { formatDate } from '../../format.js';

const WIDTH = 560;
const HEIGHT = 160;
const PADDING_X = 32;
const PADDING_Y = 16;

interface TrendPanelProps {
  points: FairnessTrendPoint[];
}

export function TrendPanel({ points }: TrendPanelProps) {
  if (points.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-surface p-8 text-center text-sm text-text-muted">
        No history yet — import past schedules to seed the ledger.
      </div>
    );
  }

  if (points.length === 1) {
    const only = points[0]!;
    return (
      <div className="rounded-md border border-border bg-surface p-4 text-sm text-text">
        Only one period on record ({formatDate(only.periodStart)}): Gini {only.gini.toFixed(2)}.
        Import more history to see a trend.
      </div>
    );
  }

  const innerWidth = WIDTH - PADDING_X * 2;
  const innerHeight = HEIGHT - PADDING_Y * 2;
  // Gini is always 0–1 by construction (see packages/core/src/fairness/distribution.ts), so the
  // y-axis domain is fixed rather than fit to the data — a chart that rescales per period would
  // make a stable Gini look like it's moving.
  const coords = points.map((point, index) => {
    const x = PADDING_X + (index / (points.length - 1)) * innerWidth;
    const y = PADDING_Y + innerHeight - point.gini * innerHeight;
    return { x, y, point };
  });
  const path = coords
    .map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
    .join(' ');

  // Label every point when there are few, else thin to first/middle/last so labels don't
  // collide — the same "selective direct labels" rule as any other mark.
  const labelEvery = points.length <= 6 ? 1 : Math.ceil(points.length / 4);

  return (
    <div>
      <svg
        role="img"
        aria-label={`Unit fairness Gini by period, oldest to newest: ${points
          .map((p) => `${formatDate(p.periodStart)} ${p.gini.toFixed(2)}`)
          .join('; ')}`}
        width={WIDTH}
        height={HEIGHT + 20}
        viewBox={`0 0 ${WIDTH} ${HEIGHT + 20}`}
        className="max-w-full"
      >
        <line
          x1={PADDING_X}
          y1={PADDING_Y + innerHeight}
          x2={WIDTH - PADDING_X}
          y2={PADDING_Y + innerHeight}
          stroke="var(--color-border)"
          strokeWidth={1}
        />
        <path
          d={path}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {coords.map(({ x, y, point }, index) => (
          <g key={point.periodId}>
            <circle cx={x} cy={y} r={3} fill="var(--color-accent)">
              <title>
                {formatDate(point.periodStart)}: Gini {point.gini.toFixed(2)}
              </title>
            </circle>
            {index % labelEvery === 0 || index === coords.length - 1 ? (
              <text
                x={x}
                y={HEIGHT + 14}
                textAnchor="middle"
                className="fill-text-muted"
                fontSize={10}
              >
                {formatDate(point.periodStart)}
              </text>
            ) : null}
          </g>
        ))}
      </svg>
      {/* Same data as the chart, for screen readers and anyone who wants exact figures without
          hovering each point. */}
      <table className="sr-only">
        <caption>Unit fairness Gini by period</caption>
        <thead>
          <tr>
            <th scope="col">Period start</th>
            <th scope="col">Gini</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.periodId}>
              <td>{formatDate(point.periodStart)}</td>
              <td>{point.gini.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
