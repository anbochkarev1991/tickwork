import { act, render, renderHook, screen } from '@testing-library/react';
import { memo } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRealtimeKeys, useRealtimeMetrics, useRealtimeValue } from '../hooks';
import { createManualScheduler } from '../scheduler';
import { createRealtimeStore } from '../store';
import type { RealtimeStore } from '../types';

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

afterEach(() => {
  vi.useRealTimers();
});

describe('useRealtimeValue', () => {
  it('reads the current value and updates when its key changes', () => {
    const { scheduler, store } = setup();
    store.ingest(quote('AAPL', 100));
    scheduler.flush();

    const { result } = renderHook(() => useRealtimeValue(store, 'AAPL'));
    expect(result.current).toEqual(quote('AAPL', 100));

    act(() => {
      store.ingest(quote('AAPL', 101));
      scheduler.flush();
    });

    expect(result.current).toEqual(quote('AAPL', 101));
  });

  it('returns undefined for a key that does not exist yet, then fills in', () => {
    const { scheduler, store } = setup();
    const { result } = renderHook(() => useRealtimeValue(store, 'AAPL'));

    expect(result.current).toBeUndefined();

    act(() => {
      store.ingest(quote('AAPL', 1));
      scheduler.flush();
    });

    expect(result.current).toEqual(quote('AAPL', 1));
  });

  it('follows the key when the key prop changes', () => {
    const { scheduler, store } = setup();
    store.ingestMany([quote('AAPL', 1), quote('MSFT', 2)]);
    scheduler.flush();

    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useRealtimeValue(store, key),
      {
        initialProps: { key: 'AAPL' },
      },
    );
    expect(result.current).toEqual(quote('AAPL', 1));

    rerender({ key: 'MSFT' });
    expect(result.current).toEqual(quote('MSFT', 2));

    // And it now tracks MSFT, not AAPL.
    act(() => {
      store.ingest(quote('MSFT', 3));
      scheduler.flush();
    });
    expect(result.current).toEqual(quote('MSFT', 3));
  });

  it('unsubscribes on unmount', () => {
    const { scheduler, store } = setup();
    const subscribe = vi.spyOn(store, 'subscribe');
    const { unmount } = renderHook(() => useRealtimeValue(store, 'AAPL'));

    const unsubscribe = subscribe.mock.results[0]?.value as () => void;
    expect(typeof unsubscribe).toBe('function');

    unmount();

    // No listeners left: a flush must not try to render an unmounted component.
    expect(() => {
      store.ingest(quote('AAPL', 1));
      scheduler.flush();
    }).not.toThrow();
  });
});

describe('useRealtimeKeys', () => {
  it('tracks additions and removals', () => {
    const { scheduler, store } = setup();
    const { result } = renderHook(() => useRealtimeKeys(store));

    expect(result.current).toEqual([]);

    act(() => {
      store.ingestMany([quote('AAPL', 1), quote('MSFT', 1)]);
      scheduler.flush();
    });
    expect(result.current).toEqual(['AAPL', 'MSFT']);

    act(() => {
      store.remove('AAPL');
    });
    expect(result.current).toEqual(['MSFT']);
  });

  it('returns a stable reference across value-only updates', () => {
    const { scheduler, store } = setup();
    store.ingest(quote('AAPL', 1));
    scheduler.flush();

    const { result } = renderHook(() => useRealtimeKeys(store));
    const first = result.current;

    act(() => {
      store.ingest(quote('AAPL', 2));
      scheduler.flush();
    });

    expect(result.current).toBe(first);
  });
});

describe('fine-grained rendering', () => {
  interface Counters {
    parent: number;
    rows: Record<string, number>;
  }

  function renderList(store: RealtimeStore<Quote>) {
    const counters: Counters = { parent: 0, rows: {} };

    // `memo` is load-bearing, not decoration: without it, a change to the key
    // set re-renders every row as an ordinary React child, undoing the
    // fine-grained subscriptions. `LiveTableRow` is memoized for this reason.
    const Row = memo(function Row({ symbol }: { symbol: string }) {
      counters.rows[symbol] = (counters.rows[symbol] ?? 0) + 1;
      const value = useRealtimeValue(store, symbol);
      return <li data-testid={symbol}>{value?.price ?? '—'}</li>;
    });

    function List() {
      counters.parent += 1;
      const keys = useRealtimeKeys(store);
      return (
        <ul>
          {keys.map((key) => (
            <Row key={key} symbol={key} />
          ))}
        </ul>
      );
    }

    render(<List />);
    return counters;
  }

  it('re-renders only the row whose value changed', () => {
    const { scheduler, store } = setup();
    store.ingestMany([quote('AAPL', 1), quote('MSFT', 1), quote('NVDA', 1)]);
    scheduler.flush();

    const counters = renderList(store);
    expect(counters).toEqual({ parent: 1, rows: { AAPL: 1, MSFT: 1, NVDA: 1 } });

    act(() => {
      store.ingest(quote('AAPL', 2));
      scheduler.flush();
    });

    expect(counters.parent).toBe(1);
    expect(counters.rows).toEqual({ AAPL: 2, MSFT: 1, NVDA: 1 });
    expect(screen.getByTestId('AAPL').textContent).toBe('2');
  });

  it('survives a flood without re-rendering anything extra', () => {
    const { scheduler, store } = setup();
    store.ingestMany([quote('AAPL', 1), quote('MSFT', 1)]);
    scheduler.flush();

    const counters = renderList(store);

    act(() => {
      // 2,000 messages for one symbol, then a single frame.
      for (let price = 0; price < 2_000; price += 1) store.ingest(quote('AAPL', price));
      scheduler.flush();
    });

    expect(counters.rows).toEqual({ AAPL: 2, MSFT: 1 });
    expect(counters.parent).toBe(1);
    expect(screen.getByTestId('AAPL').textContent).toBe('1999');
  });

  it('re-renders the parent only when the key set changes', () => {
    const { scheduler, store } = setup();
    store.ingest(quote('AAPL', 1));
    scheduler.flush();

    const counters = renderList(store);
    expect(counters.parent).toBe(1);

    act(() => {
      store.ingest(quote('AAPL', 2));
      scheduler.flush();
    });
    expect(counters.parent).toBe(1);

    act(() => {
      store.ingest(quote('MSFT', 1));
      scheduler.flush();
    });
    expect(counters.parent).toBe(2);
    // The existing row is untouched by its neighbour appearing.
    expect(counters.rows).toEqual({ AAPL: 2, MSFT: 1 });
  });
});

describe('useRealtimeMetrics', () => {
  it('polls the store on an interval', () => {
    vi.useFakeTimers();
    const { scheduler, store } = setup();
    const { result } = renderHook(() => useRealtimeMetrics(store, 500));

    expect(result.current.ingested).toBe(0);

    store.ingest(quote('AAPL', 1));
    scheduler.flush();

    // Not yet: the panel updates on its own schedule, not the feed's.
    expect(result.current.ingested).toBe(0);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.ingested).toBe(1);
    expect(result.current.size).toBe(1);
  });

  it('reads once and stops when the interval is zero', () => {
    vi.useFakeTimers();
    const { scheduler, store } = setup();
    store.ingest(quote('AAPL', 1));
    scheduler.flush();

    const { result } = renderHook(() => useRealtimeMetrics(store, 0));
    expect(result.current.ingested).toBe(1);

    store.ingest(quote('AAPL', 2));
    scheduler.flush();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(result.current.ingested).toBe(1);
  });

  it('stops polling on unmount', () => {
    vi.useFakeTimers();
    const { store } = setup();
    const getMetrics = vi.spyOn(store, 'getMetrics');
    const { unmount } = renderHook(() => useRealtimeMetrics(store, 100));

    const callsWhileMounted = getMetrics.mock.calls.length;
    unmount();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(getMetrics.mock.calls.length).toBe(callsWhileMounted);
  });
});
