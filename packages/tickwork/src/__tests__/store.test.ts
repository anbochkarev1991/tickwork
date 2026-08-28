import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManualScheduler } from '../scheduler';
import { createRealtimeStore } from '../store';
import { installRafMock, type RafMock } from './raf-mock';

interface Quote {
  symbol: string;
  price: number;
}

const quote = (symbol: string, price: number): Quote => ({ symbol, price });

function setup() {
  const scheduler = createManualScheduler();
  const store = createRealtimeStore<Quote>({ getKey: (item) => item.symbol, scheduler });
  return { scheduler, store };
}

let raf: RafMock | null = null;

afterEach(() => {
  raf?.restore();
  raf = null;
});

describe('createRealtimeStore — write path', () => {
  it('does not expose an ingested value until the flush lands', () => {
    const { scheduler, store } = setup();

    store.ingest(quote('AAPL', 100));

    expect(store.getSnapshot('AAPL')).toBeUndefined();
    expect(store.getKeys()).toEqual([]);
    expect(store.getMetrics().pending).toBe(1);

    scheduler.flush();

    expect(store.getSnapshot('AAPL')).toEqual(quote('AAPL', 100));
    expect(store.getKeys()).toEqual(['AAPL']);
  });

  it('coalesces to the newest value per key and drops the intermediates', () => {
    const { scheduler, store } = setup();
    const listener = vi.fn();
    store.subscribe('AAPL', listener);

    for (let price = 1; price <= 100; price += 1) store.ingest(quote('AAPL', price));

    expect(store.getMetrics().pending).toBe(1);

    scheduler.flush();

    expect(store.getSnapshot('AAPL')).toEqual(quote('AAPL', 100));
    // One notification for one hundred messages.
    expect(listener).toHaveBeenCalledTimes(1);

    const metrics = store.getMetrics();
    expect(metrics.ingested).toBe(100);
    expect(metrics.coalesced).toBe(99);
    expect(metrics.applied).toBe(1);
    expect(metrics.flushes).toBe(1);
  });

  it('schedules exactly one flush no matter how many items arrive first', () => {
    const { scheduler, store } = setup();

    for (let index = 0; index < 500; index += 1) {
      store.ingest(quote(`SYM${index % 25}`, index));
    }

    expect(scheduler.pending).toBe(1);

    scheduler.flush();

    expect(store.getMetrics().flushes).toBe(1);
    expect(store.getKeys()).toHaveLength(25);
    expect(scheduler.pending).toBe(0);
  });

  it('bounds queued work by key count, not message count (backpressure)', () => {
    const { store } = setup();

    // No flush at all: a hidden tab, or a scheduler that never fires.
    for (let index = 0; index < 10_000; index += 1) {
      store.ingest(quote(`SYM${index % 50}`, index));
    }

    const metrics = store.getMetrics();
    expect(metrics.ingested).toBe(10_000);
    expect(metrics.pending).toBe(50);
    expect(metrics.coalesced).toBe(9_950);
  });

  it('ingestMany queues a batch with a single scheduling call', () => {
    const { scheduler, store } = setup();

    store.ingestMany([quote('AAPL', 1), quote('MSFT', 2), quote('AAPL', 3)]);

    expect(scheduler.pending).toBe(1);
    scheduler.flush();

    expect(store.getSnapshot('AAPL')).toEqual(quote('AAPL', 3));
    expect(store.getSnapshot('MSFT')).toEqual(quote('MSFT', 2));
  });

  it('ingestMany with nothing in it does not schedule a flush', () => {
    const { scheduler, store } = setup();
    store.ingestMany([]);
    expect(scheduler.pending).toBe(0);
  });

  it('merges partial updates against the newest known value', () => {
    const scheduler = createManualScheduler();
    interface Partial {
      symbol: string;
      price?: number;
      volume?: number;
    }
    const store = createRealtimeStore<Partial>({
      getKey: (item) => item.symbol,
      merge: (previous, incoming) => ({ ...previous, ...incoming }),
      scheduler,
    });

    store.ingest({ symbol: 'AAPL', price: 100, volume: 5 });
    scheduler.flush();
    // A delta with no volume must not erase the volume we already have.
    store.ingest({ symbol: 'AAPL', price: 101 });
    scheduler.flush();

    expect(store.getSnapshot('AAPL')).toEqual({ symbol: 'AAPL', price: 101, volume: 5 });
  });

  it('merges pending values against each other between two flushes', () => {
    const scheduler = createManualScheduler();
    interface Partial {
      symbol: string;
      bid?: number;
      ask?: number;
    }
    const store = createRealtimeStore<Partial>({
      getKey: (item) => item.symbol,
      merge: (previous, incoming) => ({ ...previous, ...incoming }),
      scheduler,
    });

    store.ingest({ symbol: 'AAPL', bid: 1 });
    store.ingest({ symbol: 'AAPL', ask: 2 });
    scheduler.flush();

    expect(store.getSnapshot('AAPL')).toEqual({ symbol: 'AAPL', bid: 1, ask: 2 });
    expect(store.getMetrics().coalesced).toBe(1);
  });

  it('seeds initial items without notifying anyone', () => {
    const scheduler = createManualScheduler();
    const listener = vi.fn();
    const store = createRealtimeStore<Quote>({
      getKey: (item) => item.symbol,
      scheduler,
      initialItems: [quote('AAPL', 1), quote('MSFT', 2)],
    });
    store.subscribeKeys(listener);

    expect(store.getKeys()).toEqual(['AAPL', 'MSFT']);
    expect(store.getSnapshot('MSFT')).toEqual(quote('MSFT', 2));
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('createRealtimeStore — subscriptions', () => {
  it('notifies only the listener for the key that changed', () => {
    const { scheduler, store } = setup();
    const onApple = vi.fn();
    const onMsft = vi.fn();
    store.subscribe('AAPL', onApple);
    store.subscribe('MSFT', onMsft);

    store.ingestMany([quote('AAPL', 1), quote('MSFT', 1)]);
    scheduler.flush();
    expect(onApple).toHaveBeenCalledTimes(1);
    expect(onMsft).toHaveBeenCalledTimes(1);

    store.ingest(quote('AAPL', 2));
    scheduler.flush();

    expect(onApple).toHaveBeenCalledTimes(2);
    expect(onMsft).toHaveBeenCalledTimes(1);
  });

  it('supports several listeners on one key and detaches only the one asked for', () => {
    const { scheduler, store } = setup();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = store.subscribe('AAPL', first);
    store.subscribe('AAPL', second);

    store.ingest(quote('AAPL', 1));
    scheduler.flush();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    unsubscribeFirst();
    // Double unsubscribe must be harmless.
    unsubscribeFirst();

    store.ingest(quote('AAPL', 2));
    scheduler.flush();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('fires the key-set listener only when the set of keys changes', () => {
    const { scheduler, store } = setup();
    const onKeys = vi.fn();
    store.subscribeKeys(onKeys);

    store.ingest(quote('AAPL', 1));
    scheduler.flush();
    expect(onKeys).toHaveBeenCalledTimes(1);

    // Value-only updates: the key set is identical, so the list must not move.
    store.ingest(quote('AAPL', 2));
    scheduler.flush();
    store.ingest(quote('AAPL', 3));
    scheduler.flush();
    expect(onKeys).toHaveBeenCalledTimes(1);

    store.ingest(quote('MSFT', 1));
    scheduler.flush();
    expect(onKeys).toHaveBeenCalledTimes(2);
  });

  it('unsubscribing from the key list stops notifications', () => {
    const { scheduler, store } = setup();
    const onKeys = vi.fn();
    const unsubscribe = store.subscribeKeys(onKeys);
    unsubscribe();
    unsubscribe();

    store.ingest(quote('AAPL', 1));
    scheduler.flush();

    expect(onKeys).not.toHaveBeenCalled();
  });

  it('tolerates listeners that subscribe or unsubscribe mid-notification', () => {
    const { scheduler, store } = setup();
    const late = vi.fn();
    const other = vi.fn();
    const unsubscribeOther = store.subscribe('AAPL', other);

    store.subscribe('AAPL', () => {
      unsubscribeOther();
      store.subscribe('AAPL', late);
    });

    store.ingest(quote('AAPL', 1));
    expect(() => scheduler.flush()).not.toThrow();
    // Added during the notification: not called for the notification in flight.
    expect(late).not.toHaveBeenCalled();

    store.ingest(quote('AAPL', 2));
    scheduler.flush();
    expect(late).toHaveBeenCalledTimes(1);
  });
});

describe('createRealtimeStore — snapshot stability', () => {
  it('returns the same key array until the key set changes', () => {
    const { scheduler, store } = setup();

    const empty = store.getKeys();
    expect(store.getKeys()).toBe(empty);

    store.ingest(quote('AAPL', 1));
    scheduler.flush();
    const oneKey = store.getKeys();
    expect(oneKey).not.toBe(empty);
    expect(store.getKeys()).toBe(oneKey);

    // A hundred value updates: still the very same array reference.
    for (let price = 0; price < 100; price += 1) {
      store.ingest(quote('AAPL', price));
      scheduler.flush();
    }
    expect(store.getKeys()).toBe(oneKey);

    store.ingest(quote('MSFT', 1));
    scheduler.flush();
    expect(store.getKeys()).not.toBe(oneKey);
  });

  it('returns the same value reference until that value changes', () => {
    const { scheduler, store } = setup();
    store.ingest(quote('AAPL', 1));
    scheduler.flush();

    const first = store.getSnapshot('AAPL');
    expect(store.getSnapshot('AAPL')).toBe(first);

    store.ingest(quote('MSFT', 1));
    scheduler.flush();
    expect(store.getSnapshot('AAPL')).toBe(first);

    store.ingest(quote('AAPL', 2));
    scheduler.flush();
    expect(store.getSnapshot('AAPL')).not.toBe(first);
  });

  it('suppresses the notification when the same reference is re-ingested', () => {
    const { scheduler, store } = setup();
    const listener = vi.fn();
    store.subscribe('AAPL', listener);

    const item = quote('AAPL', 1);
    store.ingest(item);
    scheduler.flush();
    expect(listener).toHaveBeenCalledTimes(1);

    store.ingest(item);
    scheduler.flush();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getMetrics().applied).toBe(1);
  });

  it('honours areEqual to suppress no-op updates', () => {
    const scheduler = createManualScheduler();
    const store = createRealtimeStore<Quote>({
      getKey: (item) => item.symbol,
      areEqual: (a, b) => a.price === b.price,
      scheduler,
    });
    const listener = vi.fn();
    store.subscribe('AAPL', listener);

    store.ingest(quote('AAPL', 100));
    scheduler.flush();
    expect(listener).toHaveBeenCalledTimes(1);

    const before = store.getSnapshot('AAPL');
    store.ingest(quote('AAPL', 100));
    scheduler.flush();

    expect(listener).toHaveBeenCalledTimes(1);
    // The old object is kept, so React sees no change at all.
    expect(store.getSnapshot('AAPL')).toBe(before);

    store.ingest(quote('AAPL', 101));
    scheduler.flush();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('createRealtimeStore — removal and lifecycle', () => {
  it('removes a key synchronously and notifies both subscriptions', () => {
    const { scheduler, store } = setup();
    const onApple = vi.fn();
    const onKeys = vi.fn();

    store.ingest(quote('AAPL', 1));
    scheduler.flush();
    store.subscribe('AAPL', onApple);
    store.subscribeKeys(onKeys);

    expect(store.remove('AAPL')).toBe(true);

    expect(store.getSnapshot('AAPL')).toBeUndefined();
    expect(store.getKeys()).toEqual([]);
    expect(onApple).toHaveBeenCalledTimes(1);
    expect(onKeys).toHaveBeenCalledTimes(1);

    expect(store.remove('AAPL')).toBe(false);
    expect(onKeys).toHaveBeenCalledTimes(1);
  });

  it('removes queued values along with the committed one', () => {
    const { scheduler, store } = setup();
    store.ingest(quote('AAPL', 1));
    scheduler.flush();
    store.ingest(quote('AAPL', 2));

    store.remove('AAPL');
    scheduler.flush();

    expect(store.getSnapshot('AAPL')).toBeUndefined();
    expect(store.getKeys()).toEqual([]);
  });

  it('clears everything and notifies every known key', () => {
    const { scheduler, store } = setup();
    const onApple = vi.fn();
    const onKeys = vi.fn();

    store.ingestMany([quote('AAPL', 1), quote('MSFT', 1)]);
    scheduler.flush();
    store.subscribe('AAPL', onApple);
    store.subscribeKeys(onKeys);

    store.clear();

    expect(store.getKeys()).toEqual([]);
    expect(store.getAll()).toEqual([]);
    expect(onApple).toHaveBeenCalledTimes(1);
    expect(onKeys).toHaveBeenCalledTimes(1);

    // Clearing an empty store is a no-op.
    store.clear();
    expect(onKeys).toHaveBeenCalledTimes(1);
  });

  it('exposes every committed value through getAll', () => {
    const { scheduler, store } = setup();
    store.ingestMany([quote('AAPL', 1), quote('MSFT', 2)]);
    scheduler.flush();

    expect(store.getAll()).toEqual([quote('AAPL', 1), quote('MSFT', 2)]);
  });

  it('flushNow applies immediately and cancels the scheduled flush', () => {
    const { scheduler, store } = setup();
    const listener = vi.fn();
    store.subscribe('AAPL', listener);

    store.ingest(quote('AAPL', 1));
    store.flushNow();

    expect(store.getSnapshot('AAPL')).toEqual(quote('AAPL', 1));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(scheduler.pending).toBe(0);

    // Nothing queued: flushing again changes nothing.
    store.flushNow();
    expect(store.getMetrics().flushes).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('resets throughput counters but keeps live ones', () => {
    const { scheduler, store } = setup();
    store.ingest(quote('AAPL', 1));
    scheduler.flush();
    store.ingest(quote('AAPL', 2));

    store.resetMetrics();

    expect(store.getMetrics()).toEqual({
      ingested: 0,
      coalesced: 0,
      applied: 0,
      flushes: 0,
      size: 1,
      pending: 1,
    });
  });

  it('dispose stops scheduling and drops listeners', () => {
    const { scheduler, store } = setup();
    const listener = vi.fn();
    const onKeys = vi.fn();
    store.subscribe('AAPL', listener);
    store.subscribeKeys(onKeys);

    store.ingest(quote('AAPL', 1));
    store.dispose();

    expect(scheduler.pending).toBe(0);

    store.ingest(quote('AAPL', 2));
    expect(scheduler.pending).toBe(0);

    store.flushNow();
    expect(listener).not.toHaveBeenCalled();
    expect(onKeys).not.toHaveBeenCalled();
  });
});

describe('createRealtimeStore — swapping the scheduler', () => {
  it('moves a queued flush onto the new scheduler instead of dropping it', () => {
    const fast = createManualScheduler();
    const calm = createManualScheduler();
    const store = createRealtimeStore<Quote>({ getKey: (item) => item.symbol, scheduler: fast });
    const listener = vi.fn();
    store.subscribe('AAPL', listener);

    store.ingest(quote('AAPL', 1));
    expect(fast.pending).toBe(1);

    store.setScheduler(calm);

    // The old scheduler is disarmed, the new one is armed, the update survives.
    expect(fast.pending).toBe(0);
    expect(calm.pending).toBe(1);
    expect(store.getSnapshot('AAPL')).toBeUndefined();

    calm.flush();
    expect(store.getSnapshot('AAPL')).toEqual(quote('AAPL', 1));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not arm the new scheduler when nothing is queued', () => {
    const fast = createManualScheduler();
    const calm = createManualScheduler();
    const store = createRealtimeStore<Quote>({ getKey: (item) => item.symbol, scheduler: fast });

    store.setScheduler(calm);

    expect(calm.pending).toBe(0);
    expect(fast.pending).toBe(0);
  });

  it('routes later ingests through the new scheduler', () => {
    const fast = createManualScheduler();
    const calm = createManualScheduler();
    const store = createRealtimeStore<Quote>({ getKey: (item) => item.symbol, scheduler: fast });

    store.setScheduler(calm);
    store.ingest(quote('AAPL', 1));

    expect(fast.pending).toBe(0);
    expect(calm.pending).toBe(1);

    // The old scheduler firing must not apply anything.
    fast.flush();
    expect(store.getSnapshot('AAPL')).toBeUndefined();

    calm.flush();
    expect(store.getSnapshot('AAPL')).toEqual(quote('AAPL', 1));
  });

  it('setting the same scheduler is a no-op', () => {
    const scheduler = createManualScheduler();
    const store = createRealtimeStore<Quote>({ getKey: (item) => item.symbol, scheduler });

    store.ingest(quote('AAPL', 1));
    store.setScheduler(scheduler);

    // Still exactly one queued flush, not re-armed into two.
    expect(scheduler.pending).toBe(1);
    expect(scheduler.flush()).toBe(1);
    expect(store.getMetrics().flushes).toBe(1);
  });

  it('coalesces harder at a slower cadence without losing the latest value', () => {
    const scheduler = createManualScheduler();
    const store = createRealtimeStore<Quote>({ getKey: (item) => item.symbol, scheduler });
    const listener = vi.fn();
    store.subscribe('AAPL', listener);

    // A "60fps" stretch: one flush per 10 messages.
    for (let batch = 0; batch < 6; batch += 1) {
      for (let index = 0; index < 10; index += 1) store.ingest(quote('AAPL', batch * 10 + index));
      scheduler.flush();
    }
    expect(listener).toHaveBeenCalledTimes(6);
    expect(store.getSnapshot('AAPL')).toEqual(quote('AAPL', 59));

    listener.mockClear();
    store.resetMetrics();

    // The same 60 messages at a calmer cadence: one notification, same value.
    const calm = createManualScheduler();
    store.setScheduler(calm);
    for (let index = 60; index < 120; index += 1) store.ingest(quote('AAPL', index));
    calm.flush();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot('AAPL')).toEqual(quote('AAPL', 119));
    expect(store.getMetrics().coalesced).toBe(59);
  });

  it('does not resurrect a disposed store', () => {
    const fast = createManualScheduler();
    const calm = createManualScheduler();
    const store = createRealtimeStore<Quote>({ getKey: (item) => item.symbol, scheduler: fast });

    store.ingest(quote('AAPL', 1));
    store.dispose();
    store.setScheduler(calm);

    expect(calm.pending).toBe(0);
  });
});

describe('createRealtimeStore — default rAF scheduler', () => {
  it('flushes once per frame regardless of how many messages arrived', () => {
    raf = installRafMock();
    const store = createRealtimeStore<Quote>({ getKey: (item) => item.symbol });
    const listener = vi.fn();
    store.subscribe('AAPL', listener);

    for (let price = 0; price < 250; price += 1) store.ingest(quote('AAPL', price));

    expect(raf.pending).toBe(1);
    expect(listener).not.toHaveBeenCalled();

    raf.frame();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot('AAPL')).toEqual(quote('AAPL', 249));
    expect(raf.pending).toBe(0);

    store.ingest(quote('AAPL', 999));
    expect(raf.pending).toBe(1);
    raf.frame();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('accumulates without rendering while frames are not being served', () => {
    raf = installRafMock();
    const store = createRealtimeStore<Quote>({ getKey: (item) => item.symbol });
    const listener = vi.fn();
    store.subscribe('AAPL', listener);

    // A backgrounded tab: rAF never fires.
    for (let price = 0; price < 5_000; price += 1) store.ingest(quote('AAPL', price));

    expect(listener).not.toHaveBeenCalled();
    expect(store.getMetrics().pending).toBe(1);

    // Tab visible again: one frame catches up to the latest value.
    raf.frame();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot('AAPL')).toEqual(quote('AAPL', 4_999));
  });

  it('falls back to a timer when requestAnimationFrame is unavailable', () => {
    vi.useFakeTimers();
    const originalRequest = globalThis.requestAnimationFrame;
    // @ts-expect-error — simulating a non-DOM environment.
    delete globalThis.requestAnimationFrame;

    try {
      const store = createRealtimeStore<Quote>({ getKey: (item) => item.symbol });
      store.ingest(quote('AAPL', 1));
      expect(store.getSnapshot('AAPL')).toBeUndefined();

      vi.advanceTimersByTime(20);
      expect(store.getSnapshot('AAPL')).toEqual(quote('AAPL', 1));
    } finally {
      globalThis.requestAnimationFrame = originalRequest;
      vi.useRealTimers();
    }
  });
});
