import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManualScheduler, createTimeoutScheduler, rafScheduler } from '../scheduler';
import { installRafMock, type RafMock } from './raf-mock';

let raf: RafMock | null = null;

afterEach(() => {
  raf?.restore();
  raf = null;
  vi.useRealTimers();
});

describe('rafScheduler', () => {
  it('runs the task on the next frame', () => {
    raf = installRafMock();
    const task = vi.fn();

    rafScheduler.schedule(task);
    expect(task).not.toHaveBeenCalled();

    raf.frame();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('cancels a scheduled task', () => {
    raf = installRafMock();
    const task = vi.fn();

    const cancel = rafScheduler.schedule(task);
    cancel();
    // Cancelling twice must be safe.
    cancel();

    raf.frame();
    expect(task).not.toHaveBeenCalled();
  });

  it('falls back to a timer with no requestAnimationFrame available', () => {
    vi.useFakeTimers();
    const original = globalThis.requestAnimationFrame;
    // @ts-expect-error — simulating a non-DOM environment.
    delete globalThis.requestAnimationFrame;

    try {
      const task = vi.fn();
      const cancel = rafScheduler.schedule(task);

      vi.advanceTimersByTime(20);
      expect(task).toHaveBeenCalledTimes(1);

      cancel();
    } finally {
      globalThis.requestAnimationFrame = original;
    }
  });
});

describe('createTimeoutScheduler', () => {
  it('runs on the configured interval and cancels cleanly', () => {
    vi.useFakeTimers();
    const scheduler = createTimeoutScheduler(100);
    const task = vi.fn();

    scheduler.schedule(task);
    vi.advanceTimersByTime(99);
    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(task).toHaveBeenCalledTimes(1);

    const cancel = scheduler.schedule(task);
    cancel();
    vi.advanceTimersByTime(500);
    expect(task).toHaveBeenCalledTimes(1);
  });
});

describe('createManualScheduler', () => {
  it('queues, reports and flushes tasks', () => {
    const scheduler = createManualScheduler();
    const first = vi.fn();
    const second = vi.fn();

    scheduler.schedule(first);
    scheduler.schedule(second);
    expect(scheduler.pending).toBe(2);

    expect(scheduler.flush()).toBe(2);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(scheduler.pending).toBe(0);

    expect(scheduler.flush()).toBe(0);
  });

  it('cancels an individual task', () => {
    const scheduler = createManualScheduler();
    const task = vi.fn();

    const cancel = scheduler.schedule(task);
    cancel();

    expect(scheduler.pending).toBe(0);
    scheduler.flush();
    expect(task).not.toHaveBeenCalled();
  });
});
