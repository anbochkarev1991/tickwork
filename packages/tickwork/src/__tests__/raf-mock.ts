/**
 * A hand-rolled `requestAnimationFrame` mock.
 *
 * Deliberately not `vi.useFakeTimers({ toFake: ['requestAnimationFrame'] })`:
 * driving frames explicitly means every test states exactly how many frames
 * elapsed, which is the whole point when the thing under test is "one flush per
 * frame".
 */
export interface RafMock {
  /** Run every callback queued for the next frame. Returns how many ran. */
  frame(timestamp?: number): number;
  /** Callbacks waiting for a frame. */
  readonly pending: number;
  restore(): void;
}

export function installRafMock(): RafMock {
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;

  const queued = new Map<number, FrameRequestCallback>();
  let nextHandle = 1;
  let clock = 0;

  globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    const handle = nextHandle;
    nextHandle += 1;
    queued.set(handle, callback);
    return handle;
  };

  globalThis.cancelAnimationFrame = (handle: number): void => {
    queued.delete(handle);
  };

  return {
    frame(timestamp?: number): number {
      clock = timestamp ?? clock + 16;
      // Snapshot first: a callback may queue the next frame.
      const batch = Array.from(queued.values());
      queued.clear();
      for (const callback of batch) callback(clock);
      return batch.length;
    },
    get pending(): number {
      return queued.size;
    },
    restore(): void {
      globalThis.requestAnimationFrame = originalRequest;
      globalThis.cancelAnimationFrame = originalCancel;
    },
  };
}
