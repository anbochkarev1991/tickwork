import { rafScheduler, type CancelScheduledTask } from './scheduler';
import type {
  CreateRealtimeStoreOptions,
  Listener,
  RealtimeStore,
  RealtimeStoreMetrics,
} from './types';

const EMPTY_KEYS: readonly string[] = Object.freeze([]);

/**
 * A keyed store built for feeds that update faster than a screen can paint.
 *
 * The whole design is three decisions:
 *
 * 1. **Writes are queued, not applied.** `ingest` puts the item in a pending
 *    `Map` keyed by identity. Nothing renders yet.
 * 2. **The queue coalesces.** A second update for the same key overwrites the
 *    first, so the queue can never grow past the number of distinct keys no
 *    matter how hard the feed pushes. Intermediate values are dropped on
 *    purpose — nobody can see a price that was on screen for 0.4ms.
 * 3. **Flushes are scheduled once per frame**, and notify *per key*. A change to
 *    `AAPL` wakes up the component subscribed to `AAPL` and nothing else. The
 *    key-list subscription is separate and only fires when a key is added or
 *    removed.
 */
export function createRealtimeStore<T>(options: CreateRealtimeStoreOptions<T>): RealtimeStore<T> {
  const { getKey, merge, areEqual, initialItems } = options;

  /** Mutable: `setScheduler` swaps the flush cadence while data keeps arriving. */
  let scheduler = options.scheduler ?? rafScheduler;

  /** What subscribers can currently see. */
  const committed = new Map<string, T>();
  /** What the feed has sent since the last flush. At most one entry per key. */
  const pending = new Map<string, T>();

  const keyListeners = new Map<string, Set<Listener>>();
  const keysListeners = new Set<Listener>();

  /**
   * Cached key array. `null` means "the set changed, rebuild on next read".
   * `useSyncExternalStore` calls `getKeys` on every render and will loop
   * forever if we hand back a new array each time, so this cache is not an
   * optimisation — it is a correctness requirement.
   */
  let keysCache: readonly string[] | null = EMPTY_KEYS;

  let cancelFlush: CancelScheduledTask | null = null;
  let disposed = false;

  let ingested = 0;
  let coalesced = 0;
  let applied = 0;
  let flushes = 0;

  if (initialItems) {
    for (const item of initialItems) committed.set(getKey(item), item);
    if (committed.size > 0) keysCache = null;
  }

  function invalidateKeys(): void {
    keysCache = null;
  }

  function notifyKey(key: string): void {
    const listeners = keyListeners.get(key);
    if (!listeners || listeners.size === 0) return;
    // Copy: a listener may subscribe or unsubscribe while we iterate.
    for (const listener of Array.from(listeners)) listener();
  }

  function notifyKeys(): void {
    if (keysListeners.size === 0) return;
    for (const listener of Array.from(keysListeners)) listener();
  }

  function flush(): void {
    cancelFlush = null;
    if (pending.size === 0) return;

    flushes += 1;

    // Collect first, notify after: a listener that ingests (or unsubscribes)
    // must not mutate the map we are walking.
    const changedKeys: string[] = [];
    let keySetChanged = false;

    for (const [key, next] of pending) {
      const isNew = !committed.has(key);
      if (!isNew) {
        const previous = committed.get(key) as T;
        if (previous === next || (areEqual !== undefined && areEqual(previous, next))) {
          // Value is equivalent to what is already on screen — say nothing.
          continue;
        }
      }
      committed.set(key, next);
      if (isNew) keySetChanged = true;
      changedKeys.push(key);
      applied += 1;
    }

    pending.clear();

    if (keySetChanged) invalidateKeys();
    for (const key of changedKeys) notifyKey(key);
    if (keySetChanged) notifyKeys();
  }

  function scheduleFlush(): void {
    if (cancelFlush !== null || disposed) return;
    cancelFlush = scheduler.schedule(flush);
  }

  function queue(item: T): void {
    const key = getKey(item);
    ingested += 1;

    if (merge === undefined) {
      // The common case: newest value wins outright.
      if (pending.has(key)) coalesced += 1;
      pending.set(key, item);
      return;
    }

    const hadPending = pending.has(key);
    if (hadPending) coalesced += 1;
    const previous = hadPending ? pending.get(key) : committed.get(key);
    pending.set(key, merge(previous, item));
  }

  const store: RealtimeStore<T> = {
    ingest(item) {
      queue(item);
      scheduleFlush();
    },

    ingestMany(items) {
      let queued = false;
      for (const item of items) {
        queue(item);
        queued = true;
      }
      if (queued) scheduleFlush();
    },

    getSnapshot(key) {
      return committed.get(key);
    },

    subscribe(key, listener) {
      let listeners = keyListeners.get(key);
      if (listeners === undefined) {
        listeners = new Set();
        keyListeners.set(key, listeners);
      }
      listeners.add(listener);

      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const current = keyListeners.get(key);
        if (current === undefined) return;
        current.delete(listener);
        if (current.size === 0) keyListeners.delete(key);
      };
    },

    getKeys() {
      if (keysCache === null) keysCache = Array.from(committed.keys());
      return keysCache;
    },

    subscribeKeys(listener) {
      keysListeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        keysListeners.delete(listener);
      };
    },

    getAll() {
      return Array.from(committed.values());
    },

    remove(key) {
      pending.delete(key);
      if (!committed.delete(key)) return false;
      invalidateKeys();
      notifyKey(key);
      notifyKeys();
      return true;
    },

    clear() {
      if (committed.size === 0 && pending.size === 0) return;
      const removedKeys = Array.from(committed.keys());
      committed.clear();
      pending.clear();
      invalidateKeys();
      for (const key of removedKeys) notifyKey(key);
      notifyKeys();
    },

    flushNow() {
      cancelFlush?.();
      cancelFlush = null;
      flush();
    },

    setScheduler(next) {
      if (next === scheduler) return;
      // Move any queued flush onto the new cadence rather than dropping it, so
      // changing the display rate never loses an update that was already due.
      const wasScheduled = cancelFlush !== null;
      cancelFlush?.();
      cancelFlush = null;
      scheduler = next;
      if (wasScheduled) scheduleFlush();
    },

    getMetrics(): RealtimeStoreMetrics {
      return {
        ingested,
        coalesced,
        applied,
        flushes,
        size: committed.size,
        pending: pending.size,
      };
    },

    resetMetrics() {
      ingested = 0;
      coalesced = 0;
      applied = 0;
      flushes = 0;
    },

    dispose() {
      disposed = true;
      cancelFlush?.();
      cancelFlush = null;
      pending.clear();
      keyListeners.clear();
      keysListeners.clear();
    },
  };

  return store;
}
