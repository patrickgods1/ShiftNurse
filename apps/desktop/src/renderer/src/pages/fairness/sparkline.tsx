/**
 * A per-nurse score trend, oldest to newest. Deliberately not a chart library — none is
 * installed, and a handful of points scaled into an inline `<svg>` is the whole job. Values
 * are always paired with the numeric score elsewhere in the row, so the sparkline is a
 * secondary, at-a-glance cue rather than the only place the trend is legible.
 */

const WIDTH = 96;
const HEIGHT = 28;
const PADDING = 3;

interface SparklineProps {
  /** 0–100 composite scores, oldest first. */
  values: number[];
}

export function Sparkline({ values }: SparklineProps) {
  if (values.length === 0) {
    return <span className="text-xs text-text-muted">No history</span>;
  }
  if (values.length === 1) {
    return <span className="text-xs text-text-muted">1 period only</span>;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat run (min === max) would divide by zero; draw it as a level line instead.
  const range = max - min || 1;
  const innerWidth = WIDTH - PADDING * 2;
  const innerHeight = HEIGHT - PADDING * 2;

  const points = values.map((value, index) => {
    const x = PADDING + (index / (values.length - 1)) * innerWidth;
    const y = PADDING + innerHeight - ((value - min) / range) * innerHeight;
    return { x, y };
  });

  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(' ');
  const last = points[points.length - 1]!;
  const summary = `Score trend, oldest to newest: ${values.map((v) => v.toFixed(0)).join(', ')}`;

  return (
    <svg
      role="img"
      aria-label={summary}
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="shrink-0"
    >
      <title>{summary}</title>
      <path
        d={path}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={last.x} cy={last.y} r={2.5} fill="var(--color-accent)" />
    </svg>
  );
}
