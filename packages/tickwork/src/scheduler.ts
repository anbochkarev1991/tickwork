/**
 * Flush scheduling. `tickwork` never renders on the data thread's schedule — it
 * renders on the *paint* schedule. Everything that decides "when do we flush?"
 * lives here so it can be swapped out (and made deterministic in tests).
 */

/** Cancels a scheduled task. Safe to call more than once. */
export type CancelScheduledTask = () => void;

export interface Scheduler {
  /**
   * Run `task` at the next opportunity. Implementations must be idempotent per
   * call: one `schedule()` runs `task` exactly once.
   */
  schedule: (task: () => void) => CancelScheduledTask;
}

const FALLBACK_FRAME_MS = 16;

/**
 * The default scheduler: one flush per animation frame.
 *
 * Two properties matter here.
 * 1. It is *paint aligned* — we commit state right before the browser paints,
 *    so React never renders a frame that will not be shown.
 * 2. It *pauses in background tabs* — browsers stop firing rAF, so a hidden tab
 *    stops rendering entirely while updates keep coalescing in memory. When the
 *    tab is shown again a single flush catches it up to the latest value.
 *
 * `requestAnimationFrame` is looked up at call time (not module load) so that
 * test mocks and non-DOM environments both work.
 */
export const rafScheduler: Scheduler = {
  schedule(task) {
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf === 'function') {
      const handle = raf(() => task());
      return () => {
        globalThis.cancelAnimationFrame?.(handle);
      };
    }
    // Non-DOM environment (SSR, workers, older jsdom): degrade to a timer.
    const handle = setTimeout(task, FALLBACK_FRAME_MS);
    return () => clearTimeout(handle);
  },
};

/**
 * Flush at most once every `intervalMs`, on a timer instead of a frame. Useful
 * when you want a slower cadence than the display refresh rate (a 4Hz ticker in
 * a sidebar, say) or when there is no rAF at all.
 */
export function createTimeoutScheduler(intervalMs: number): Scheduler {
  return {
    schedule(task) {
      const handle = setTimeout(task, intervalMs);
      return () => clearTimeout(handle);
    },
  };
}

export interface ManualScheduler extends Scheduler {
  /** Number of flushes currently queued (0 or 1 in practice). */
  readonly pending: number;
  /** Run every queued task now. Returns how many ran. */
  flush: () => number;
}

/**
 * A scheduler you drive by hand. Exported because it is genuinely useful in
 * tests — yours as well as ours — when you want to assert on exactly what one
 * flush produced without touching timers.
 */
export function createManualScheduler(): ManualScheduler {
  let tasks: (() => void)[] = [];

  return {
    schedule(task) {
      tasks.push(task);
      return () => {
        tasks = tasks.filter((candidate) => candidate !== task);
      };
    },
    get pending() {
      return tasks.length;
    },
    flush() {
      const queued = tasks;
      tasks = [];
      for (const task of queued) task();
      return queued.length;
    },
  };
}
