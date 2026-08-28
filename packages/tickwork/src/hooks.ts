import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { RealtimeStore, RealtimeStoreMetrics } from './types';

/**
 * Subscribe to exactly one key.
 *
 * This is the hook that makes the whole thing fast. Each row calls it with its
 * own key, so a tick for `MSFT` re-renders one `<tr>` — not the table, not the
 * page. React's `useSyncExternalStore` handles tearing and concurrent
 * rendering; the store's per-key listener sets handle the fan-out.
 */
export function useRealtimeValue<T>(store: RealtimeStore<T>, key: string): T | undefined {
  const subscribe = useCallback(
    (onStoreChange: () => void) => store.subscribe(key, onStoreChange),
    [store, key],
  );
  const getSnapshot = useCallback(() => store.getSnapshot(key), [store, key]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Subscribe to the *set* of keys, in insertion order.
 *
 * Renders when a row appears or disappears, and never when a value changes.
 * The returned array is reference-stable between those events, so it is safe as
 * a dependency and safe to render from.
 */
export function useRealtimeKeys<T>(store: RealtimeStore<T>): readonly string[] {
  return useSyncExternalStore(store.subscribeKeys, store.getKeys, store.getKeys);
}

/**
 * Poll the store's throughput counters on an interval.
 *
 * Deliberately *not* a subscription: at 5k updates/sec you want to see the
 * numbers a few times a second, not to re-render a stats panel 5,000 times.
 * Pass `intervalMs = 0` to read once and stop.
 */
export function useRealtimeMetrics<T>(
  store: RealtimeStore<T>,
  intervalMs = 500,
): RealtimeStoreMetrics {
  const [metrics, setMetrics] = useState(() => store.getMetrics());

  useEffect(() => {
    setMetrics(store.getMetrics());
    if (intervalMs <= 0) return;
    const handle = setInterval(() => setMetrics(store.getMetrics()), intervalMs);
    return () => clearInterval(handle);
  }, [store, intervalMs]);

  return metrics;
}

/**
 * Keeps a mutable ref pointing at the newest value it was given.
 *
 * Used internally so long-lived callbacks (socket handlers, timers) can read
 * current props without being re-created — and therefore without tearing down
 * a live connection every time a parent re-renders.
 */
export function useLatestRef<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
