import { useEffect, useState } from 'react';

/**
 * Counts row renders. Incremented from inside a cell renderer, which runs
 * exactly once per row render — the cheapest honest way to compare "messages
 * arriving" against "rows actually re-rendered".
 */
export const rowRenderCounter = { count: 0 };

export interface FrameStats {
  fps: number;
  /** Longest gap between frames in the last sample. Jank, in milliseconds. */
  worstFrameMs: number;
}

/**
 * Measures real frame pacing with a `requestAnimationFrame` loop. When the main
 * thread is busy re-rendering a whole table thousands of times a second, this
 * loop gets starved — which is precisely what makes the number meaningful.
 */
export function useFrameStats(sampleMs = 500): FrameStats {
  const [stats, setStats] = useState<FrameStats>({ fps: 0, worstFrameMs: 0 });

  useEffect(() => {
    let handle = 0;
    let frames = 0;
    let worst = 0;
    let windowStart = performance.now();
    let last = windowStart;
    let cancelled = false;

    const loop = (now: number): void => {
      const delta = now - last;
      last = now;
      frames += 1;
      if (delta > worst) worst = delta;

      const elapsed = now - windowStart;
      if (elapsed >= sampleMs) {
        setStats({
          fps: Math.round((frames * 1000) / elapsed),
          worstFrameMs: Math.round(worst),
        });
        frames = 0;
        worst = 0;
        windowStart = now;
      }
      if (!cancelled) handle = requestAnimationFrame(loop);
    };

    handle = requestAnimationFrame(loop);
    return () => {
      cancelled = true;
      cancelAnimationFrame(handle);
    };
  }, [sampleMs]);

  return stats;
}

/** Turns a monotonically increasing counter into a per-second rate. */
export function useRatePerSecond(read: () => number, intervalMs = 500): number {
  const [rate, setRate] = useState(0);

  useEffect(() => {
    let lastValue = read();
    let lastTime = performance.now();

    const handle = setInterval(() => {
      const value = read();
      const now = performance.now();
      const seconds = (now - lastTime) / 1000;
      if (seconds > 0) setRate(Math.max(0, Math.round((value - lastValue) / seconds)));
      lastValue = value;
      lastTime = now;
    }, intervalMs);

    return () => clearInterval(handle);
    // `read` closes over stable refs in this app; re-subscribing on every render
    // would reset the measurement window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs]);

  return rate;
}

/** Reads a live value on an interval. For levels, where a rate makes no sense. */
export function usePolledValue(read: () => number, intervalMs = 500): number {
  const [value, setValue] = useState(read);

  useEffect(() => {
    const handle = setInterval(() => setValue(read()), intervalMs);
    return () => clearInterval(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs]);

  return value;
}
