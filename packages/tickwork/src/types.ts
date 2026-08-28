import type { Scheduler } from './scheduler';

/** Called when something a subscriber cares about may have changed. */
export type Listener = () => void;

/** Detaches a listener. Idempotent. */
export type Unsubscribe = () => void;

export interface RealtimeStoreMetrics {
  /** Items handed to `ingest` / `ingestMany`. */
  ingested: number;
  /** Items superseded by a newer value before they were ever flushed. */
  coalesced: number;
  /** Items committed to the snapshot and pushed to subscribers. */
  applied: number;
  /** Flushes performed (in the default scheduler: frames that carried data). */
  flushes: number;
  /** Keys currently held. */
  size: number;
  /** Items waiting for the next flush. */
  pending: number;
}

export interface CreateRealtimeStoreOptions<T> {
  /**
   * Extracts the identity of an item. Two items with the same key are the same
   * row, and the newer one wins.
   */
  getKey: (item: T) => string;

  /**
   * Combine an incoming item with what is already known for that key. Use this
   * when your feed sends *partial* updates:
   *
   * ```ts
   * merge: (previous, incoming) => ({ ...previous, ...incoming })
   * ```
   *
   * `previous` is the pending value if one is queued, otherwise the committed
   * value, otherwise `undefined`. Default: the incoming item replaces the old.
   */
  merge?: (previous: T | undefined, incoming: T) => T;

  /**
   * Decide whether a flushed value is actually different. Returning `true`
   * suppresses the notification entirely, so the row does not re-render.
   * Default: reference equality.
   */
  areEqual?: (a: T, b: T) => boolean;

  /** Where flushes come from. Default: {@link rafScheduler}. */
  scheduler?: Scheduler;

  /** Seed data, committed immediately (no flush, no notifications). */
  initialItems?: Iterable<T>;
}

/**
 * Every member is declared as a function property rather than a method: these
 * are standalone functions by design, safe to destructure and to hand straight
 * to `useSyncExternalStore` without binding.
 */
export interface RealtimeStore<T> {
  /** Queue one item for the next flush. Cheap: a `Map.set` and maybe a rAF. */
  ingest: (item: T) => void;

  /** Queue many items. Same cost per item, one scheduling check. */
  ingestMany: (items: Iterable<T>) => void;

  /**
   * Current committed value for `key`, or `undefined`. Stable by reference
   * between flushes — this is what makes it safe for `useSyncExternalStore`.
   */
  getSnapshot: (key: string) => T | undefined;

  /** Subscribe to one key. Fires only when *that* key's value changes. */
  subscribe: (key: string, listener: Listener) => Unsubscribe;

  /**
   * All known keys in insertion order. The same array reference is returned
   * until the *set* of keys changes, so a value-only update never re-renders
   * whoever is rendering the list.
   */
  getKeys: () => readonly string[];

  /** Subscribe to the key *set*. Does not fire on value changes. */
  subscribeKeys: (listener: Listener) => Unsubscribe;

  /** Committed value for every key, as a fresh array. For export/debugging. */
  getAll: () => T[];

  /** Drop a key immediately (synchronously) and notify. */
  remove: (key: string) => boolean;

  /** Drop everything immediately and notify. */
  clear: () => void;

  /**
   * Apply queued updates right now instead of waiting for the scheduler.
   * Useful in tests, on `visibilitychange`, or before reading `getAll()`.
   */
  flushNow: () => void;

  /**
   * Swap the flush cadence while the feed keeps running.
   *
   * The point of decoupling the data rate from the render rate is not only to
   * keep up — it is that you get to *choose* the render rate. Numbers changing
   * 60 times a second are unreadable; the same feed flushed 4 times a second is
   * calm, and no data is lost because the store still coalesces underneath.
   *
   * ```ts
   * store.setScheduler(calm ? createTimeoutScheduler(250) : rafScheduler);
   * ```
   *
   * A flush that was already queued is re-armed on the new scheduler.
   */
  setScheduler: (scheduler: Scheduler) => void;

  /** Counters describing throughput and how much coalescing is happening. */
  getMetrics: () => RealtimeStoreMetrics;

  /** Zero the throughput counters (`size`/`pending` are live values). */
  resetMetrics: () => void;

  /**
   * Cancel pending work, drop every listener, and stop scheduling flushes.
   * Reading (`getSnapshot`, `getKeys`) still works; the store is done ticking.
   */
  dispose: () => void;
}
