import { memo, useMemo } from 'react';

/**
 * Non-numeric encodings for fast-changing data.
 *
 * A price updating 40 times a second is not readable as digits, which is why
 * real trading screens lean on shape and length instead: a sparkline for trend,
 * a bar for magnitude, an arrow for direction. The digits are still there for
 * the moment you need the exact number.
 *
 * These live in the demo, not the library — `tickwork` is not a charting
 * library, and a 30-line inline SVG does not need to be in your bundle.
 */

const UP = '#21c07a';
const DOWN = '#ef5350';
const FLAT = '#8b98a9';

interface SparklineProps {
  points: readonly number[];
  width?: number;
  height?: number;
}

function buildPath(points: readonly number[], width: number, height: number): string {
  if (points.length === 0) return '';

  const padding = 2;
  const usableHeight = height - padding * 2;
  let min = points[0] as number;
  let max = min;
  for (const value of points) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const span = max - min;

  // A flat series would divide by zero; draw it down the middle instead.
  const y = (value: number): number =>
    span === 0 ? height / 2 : padding + usableHeight - ((value - min) / span) * usableHeight;
  const x = (index: number): number =>
    points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;

  return points
    .map((value, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(value).toFixed(1)}`)
    .join(' ');
}

/**
 * Memoized on `points`, which the market only re-samples every 250ms. So while
 * the row around it re-renders 40 times a second, this subtree is skipped —
 * the same trick the library uses for rows, applied one level down.
 */
export const Sparkline = memo(function Sparkline({
  points,
  width = 84,
  height = 22,
}: SparklineProps) {
  const path = useMemo(() => buildPath(points, width, height), [points, width, height]);

  if (path === '') return <span className="demo-muted">—</span>;

  const first = points[0] as number;
  const last = points[points.length - 1] as number;
  const stroke = last > first ? UP : last < first ? DOWN : FLAT;

  return (
    <svg
      className="demo-sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Trend: ${last > first ? 'up' : last < first ? 'down' : 'flat'} over the last ${points.length} samples`}
    >
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
});

interface ChangeProps {
  /** Percentage change. */
  value: number;
  /**
   * Percentage change that fills the bar. Fixed, deliberately — see below.
   * 3% is a large intraday move for a large-cap, so the bar stays informative
   * instead of sitting at full width.
   */
  scale?: number;
}

/**
 * Direction arrow, magnitude bar, and the number.
 *
 * The bar scale is a fixed constant rather than normalised against the largest
 * value on screen, and that is a design consequence of fine-grained rendering:
 * a row that had to know its neighbours' values could not render independently,
 * and every tick anywhere would re-render every row — exactly what the library
 * exists to avoid. Fixed scale keeps rows independent.
 *
 * The arrow matters for more than decoration: colour alone fails for the ~8% of
 * men with red–green colour blindness.
 */
export const ChangeCell = memo(function ChangeCell({ value, scale = 3 }: ChangeProps) {
  const up = value >= 0;
  const magnitude = Math.min(Math.abs(value) / scale, 1);

  return (
    <span className={`demo-change ${up ? 'demo-up' : 'demo-down'}`}>
      <span className="demo-arrow" aria-hidden="true">
        {up ? '▲' : '▼'}
      </span>
      <span className="demo-change-value">
        {up ? '+' : '−'}
        {Math.abs(value).toFixed(2)}%
      </span>
      <span className="demo-bar-track" aria-hidden="true">
        <span
          className={`demo-bar-fill ${up ? 'is-up' : 'is-down'}`}
          style={{ width: `${(magnitude * 100).toFixed(1)}%` }}
        />
      </span>
    </span>
  );
});

/** Spread as a share of price — a thin bar is a tight market. */
export const SpreadCell = memo(function SpreadCell({ bid, ask }: { bid: number; ask: number }) {
  const mid = (bid + ask) / 2;
  const basisPoints = mid === 0 ? 0 : ((ask - bid) / mid) * 10_000;
  return (
    <span className="demo-spread" title={`${basisPoints.toFixed(1)} bps`}>
      {basisPoints.toFixed(1)}
    </span>
  );
});
