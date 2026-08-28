import { act, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeBackoffDelay,
  useWebSocketFeed,
  type SocketFactory,
  type UseWebSocketFeedOptions,
} from '../use-web-socket-feed';
import { MockWebSocket, mockSocketFactory } from './mock-websocket';

interface Quote {
  symbol: string;
  price: number;
}

const URL = 'wss://example.test/ticks';

const parseQuote = (raw: unknown): Quote | Quote[] | null => {
  if (typeof raw !== 'string') return null;
  const value: unknown = JSON.parse(raw);
  return value as Quote | Quote[];
};

function renderFeed(overrides: Partial<UseWebSocketFeedOptions<Quote>> = {}) {
  const options: UseWebSocketFeedOptions<Quote> = {
    url: URL,
    parse: parseQuote,
    socketFactory: mockSocketFactory,
    ...overrides,
  };
  return renderHook((props: UseWebSocketFeedOptions<Quote>) => useWebSocketFeed(props), {
    initialProps: options,
  });
}

beforeEach(() => {
  MockWebSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useWebSocketFeed — connecting', () => {
  it('connects on mount and reports open once the socket opens', () => {
    const onOpen = vi.fn();
    const { result } = renderFeed({ onOpen });

    expect(MockWebSocket.count).toBe(1);
    expect(MockWebSocket.current.url).toBe(URL);
    expect(result.current.status).toBe('connecting');

    act(() => {
      MockWebSocket.current.serverOpen();
    });

    expect(result.current.status).toBe('open');
    expect(result.current.attempt).toBe(0);
    expect(onOpen).toHaveBeenCalledWith({ attempt: 0, reconnected: false });
  });

  it('stays idle when there is no url, and connects when one arrives', () => {
    const { result, rerender } = renderFeed({ url: null });

    expect(MockWebSocket.count).toBe(0);
    expect(result.current.status).toBe('closed');

    rerender({ url: URL, parse: parseQuote, socketFactory: mockSocketFactory });

    expect(MockWebSocket.count).toBe(1);
    expect(result.current.status).toBe('connecting');
  });

  it('replaces the socket when the url changes', () => {
    const { rerender } = renderFeed();
    const first = MockWebSocket.current;
    act(() => {
      first.serverOpen();
    });

    rerender({
      url: 'wss://example.test/other',
      parse: parseQuote,
      socketFactory: mockSocketFactory,
    });

    expect(first.closeCalls).toHaveLength(1);
    expect(first.listenerCount).toBe(0);
    expect(MockWebSocket.count).toBe(2);
    expect(MockWebSocket.current.url).toBe('wss://example.test/other');
  });

  it('waits for connect() when autoConnect is false', () => {
    const { result } = renderFeed({ autoConnect: false });

    expect(MockWebSocket.count).toBe(0);
    expect(result.current.status).toBe('closed');

    act(() => {
      result.current.connect();
    });

    expect(MockWebSocket.count).toBe(1);
    expect(result.current.status).toBe('connecting');
  });

  it('does not recreate the socket when unrelated options change', () => {
    const { rerender } = renderFeed({ onItem: vi.fn() });
    act(() => {
      MockWebSocket.current.serverOpen();
    });

    rerender({
      url: URL,
      parse: parseQuote,
      socketFactory: mockSocketFactory,
      onItem: vi.fn(),
    });

    expect(MockWebSocket.count).toBe(1);
  });

  it('schedules a reconnect when the socket factory throws', () => {
    const failing: SocketFactory = () => {
      throw new Error('nope');
    };
    const onError = vi.fn();
    const { result } = renderFeed({ socketFactory: failing, onError });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('reconnecting');
    expect(result.current.attempt).toBe(1);
  });

  it('accepts a real WebSocket from a socket factory', () => {
    // Type-level assertion: the structural WebSocketLike must not force a cast.
    const factory: SocketFactory = (url, protocols) => new WebSocket(url, protocols);
    expect(typeof factory).toBe('function');
  });
});

describe('useWebSocketFeed — messages and parsing', () => {
  it('hands every parsed item to onItem', () => {
    const onItem = vi.fn();
    renderFeed({ onItem });
    act(() => {
      MockWebSocket.current.serverOpen();
    });

    act(() => {
      MockWebSocket.current.serverMessage(JSON.stringify({ symbol: 'AAPL', price: 1 }));
      MockWebSocket.current.serverMessage(JSON.stringify({ symbol: 'AAPL', price: 2 }));
    });

    expect(onItem).toHaveBeenCalledTimes(2);
    expect(onItem).toHaveBeenLastCalledWith({ symbol: 'AAPL', price: 2 });
  });

  it('treats an array payload as a batch', () => {
    const onItem = vi.fn();
    const { result } = renderFeed({ onItem });
    act(() => {
      MockWebSocket.current.serverOpen();
    });

    act(() =>
      MockWebSocket.current.serverMessage(
        JSON.stringify([
          { symbol: 'AAPL', price: 1 },
          { symbol: 'MSFT', price: 2 },
        ]),
      ),
    );

    expect(onItem).toHaveBeenCalledTimes(2);
    const metrics = result.current.getMetrics();
    expect(metrics.received).toBe(1);
    expect(metrics.parsed).toBe(2);
  });

  it('drops malformed messages without crashing and reports them', () => {
    const onItem = vi.fn();
    const onParseError = vi.fn();
    const { result } = renderFeed({ onItem, onParseError });
    act(() => {
      MockWebSocket.current.serverOpen();
    });

    act(() => {
      MockWebSocket.current.serverMessage('{"symbol": "AAPL", "pri');
      MockWebSocket.current.serverMessage('<html>502 Bad Gateway</html>');
    });

    expect(onItem).not.toHaveBeenCalled();
    expect(onParseError).toHaveBeenCalledTimes(2);
    expect(result.current.getMetrics().dropped).toBe(2);
    // Still connected: one bad frame is not a connection problem.
    expect(result.current.status).toBe('open');
  });

  it('drops messages the parser rejects by returning null or undefined', () => {
    const onItem = vi.fn();
    const { result } = renderFeed({
      onItem,
      parse: (raw) => (raw === 'keep' ? { symbol: 'AAPL', price: 1 } : null),
    });
    act(() => {
      MockWebSocket.current.serverOpen();
    });

    act(() => {
      MockWebSocket.current.serverMessage('skip');
      MockWebSocket.current.serverMessage('keep');
    });

    expect(onItem).toHaveBeenCalledTimes(1);
    expect(result.current.getMetrics().dropped).toBe(1);
  });

  it('drops empty slots inside a batch', () => {
    const onItem = vi.fn();
    const { result } = renderFeed({
      onItem,
      parse: () => [{ symbol: 'AAPL', price: 1 }, null] as unknown as Quote[],
    });
    act(() => {
      MockWebSocket.current.serverOpen();
    });
    act(() => {
      MockWebSocket.current.serverMessage('anything');
    });

    expect(onItem).toHaveBeenCalledTimes(1);
    expect(result.current.getMetrics().dropped).toBe(1);
  });

  it('does not re-render the component for incoming messages', () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useWebSocketFeed<Quote>({
        url: URL,
        parse: parseQuote,
        socketFactory: mockSocketFactory,
      });
    });

    act(() => {
      MockWebSocket.current.serverOpen();
    });
    const rendersAfterOpen = renders;

    act(() => {
      for (let index = 0; index < 500; index += 1) {
        MockWebSocket.current.serverMessage(JSON.stringify({ symbol: 'AAPL', price: index }));
      }
    });

    expect(renders).toBe(rendersAfterOpen);
    expect(result.current.getMetrics().received).toBe(500);
  });

  it('tracks the time of the last message', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { result } = renderFeed();
    act(() => {
      MockWebSocket.current.serverOpen();
    });

    vi.setSystemTime(new Date('2026-01-01T00:00:05Z'));
    act(() => {
      MockWebSocket.current.serverMessage(JSON.stringify({ symbol: 'A', price: 1 }));
    });

    expect(result.current.getLastMessageAt()).toBe(Date.parse('2026-01-01T00:00:05Z'));
  });

  it('sends on the live socket and refuses when there is none', () => {
    const { result } = renderFeed();

    expect(result.current.send('early')).toBe(false);

    act(() => {
      MockWebSocket.current.serverOpen();
    });

    expect(result.current.send('hello')).toBe(true);
    expect(MockWebSocket.current.sent).toEqual(['hello']);
  });

  it('reports socket errors without tearing anything down', () => {
    const onError = vi.fn();
    const { result } = renderFeed({ onError });
    act(() => {
      MockWebSocket.current.serverOpen();
    });

    act(() => {
      MockWebSocket.current.serverError();
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('open');
    expect(result.current.getMetrics().errors).toBe(1);
  });
});

describe('useWebSocketFeed — reconnection', () => {
  it('backs off exponentially and caps the delay', () => {
    const { result } = renderFeed();
    act(() => {
      MockWebSocket.current.serverOpen();
    });

    const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];

    expectedDelays.forEach((delay, index) => {
      act(() => {
        MockWebSocket.current.serverClose();
      });

      expect(result.current.status).toBe('reconnecting');
      expect(result.current.attempt).toBe(index + 1);

      // One millisecond early: still waiting.
      act(() => {
        vi.advanceTimersByTime(delay - 1);
      });
      expect(MockWebSocket.count).toBe(index + 1);

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(MockWebSocket.count).toBe(index + 2);
    });
  });

  it('resets the backoff after a successful reconnect', () => {
    const onReconnect = vi.fn();
    const { result } = renderFeed({ onReconnect });
    act(() => {
      MockWebSocket.current.serverOpen();
    });

    act(() => {
      MockWebSocket.current.serverClose();
    });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    act(() => {
      MockWebSocket.current.serverClose();
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(result.current.attempt).toBe(2);

    act(() => {
      MockWebSocket.current.serverOpen();
    });

    expect(result.current.status).toBe('open');
    expect(result.current.attempt).toBe(0);
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(onReconnect).toHaveBeenCalledWith({ attempt: 2 });

    // The next failure starts from one second again.
    act(() => {
      MockWebSocket.current.serverClose();
    });
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(MockWebSocket.count).toBe(3);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(MockWebSocket.count).toBe(4);
  });

  it('does not fire onReconnect for the first successful connection', () => {
    const onReconnect = vi.fn();
    renderFeed({ onReconnect });
    act(() => {
      MockWebSocket.current.serverOpen();
    });
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('counts reconnects in its metrics', () => {
    const { result } = renderFeed();
    act(() => {
      MockWebSocket.current.serverOpen();
    });
    act(() => {
      MockWebSocket.current.serverClose();
    });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    act(() => {
      MockWebSocket.current.serverOpen();
    });

    const metrics = result.current.getMetrics();
    expect(metrics.opens).toBe(2);
    expect(metrics.reconnects).toBe(1);
  });

  it('stays closed when reconnection is disabled', () => {
    const onClose = vi.fn();
    const { result } = renderFeed({ reconnect: false, onClose });
    act(() => {
      MockWebSocket.current.serverOpen();
    });

    act(() => {
      MockWebSocket.current.serverClose();
    });

    expect(result.current.status).toBe('closed');
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(MockWebSocket.count).toBe(1);
  });

  it('gives up after maxAttempts', () => {
    const onGiveUp = vi.fn();
    const { result } = renderFeed({ reconnect: { maxAttempts: 2 }, onGiveUp });
    act(() => {
      MockWebSocket.current.serverOpen();
    });

    act(() => {
      MockWebSocket.current.serverClose();
    });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(MockWebSocket.count).toBe(2);

    act(() => {
      MockWebSocket.current.serverClose();
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(MockWebSocket.count).toBe(3);

    act(() => {
      MockWebSocket.current.serverClose();
    });

    expect(result.current.status).toBe('closed');
    expect(onGiveUp).toHaveBeenCalledWith({ attempts: 2 });

    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(MockWebSocket.count).toBe(3);
  });

  it('honours a custom backoff configuration', () => {
    renderFeed({ reconnect: { initialDelayMs: 100, factor: 3, maxDelayMs: 500 } });
    act(() => {
      MockWebSocket.current.serverOpen();
    });

    act(() => {
      MockWebSocket.current.serverClose();
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(MockWebSocket.count).toBe(2);

    act(() => {
      MockWebSocket.current.serverClose();
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(MockWebSocket.count).toBe(3);

    act(() => {
      MockWebSocket.current.serverClose();
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(MockWebSocket.count).toBe(4);
  });

  it('disconnect() closes for good, connect() starts over', () => {
    const { result } = renderFeed();
    act(() => {
      MockWebSocket.current.serverOpen();
    });

    act(() => {
      result.current.disconnect();
    });

    expect(result.current.status).toBe('closed');
    expect(MockWebSocket.current.closeCalls).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(MockWebSocket.count).toBe(1);

    act(() => {
      result.current.connect();
    });

    expect(MockWebSocket.count).toBe(2);
    expect(result.current.status).toBe('connecting');
  });
});

describe('useWebSocketFeed — heartbeat', () => {
  const heartbeat = { timeoutMs: 10_000, intervalMs: 4_000 };

  it('sends keepalives on an interval while open', () => {
    renderFeed({ heartbeat });
    act(() => {
      MockWebSocket.current.serverOpen();
    });

    act(() => {
      vi.advanceTimersByTime(8_000);
    });

    expect(MockWebSocket.current.sent).toEqual(['ping', 'ping']);
  });

  it('supports a dynamic keepalive payload', () => {
    let counter = 0;
    renderFeed({
      heartbeat: {
        ...heartbeat,
        message: () => {
          counter += 1;
          return `ping-${counter}`;
        },
      },
    });
    act(() => {
      MockWebSocket.current.serverOpen();
    });
    act(() => {
      vi.advanceTimersByTime(8_000);
    });

    expect(MockWebSocket.current.sent).toEqual(['ping-1', 'ping-2']);
  });

  it('reconnects when no message arrives within the timeout', () => {
    const onHeartbeatTimeout = vi.fn();
    const { result } = renderFeed({ heartbeat, onHeartbeatTimeout });
    act(() => {
      MockWebSocket.current.serverOpen();
    });
    const dead = MockWebSocket.current;

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(onHeartbeatTimeout).toHaveBeenCalledTimes(1);
    expect(dead.closeCalls).toHaveLength(1);
    expect(dead.listenerCount).toBe(0);
    expect(result.current.status).toBe('reconnecting');
    expect(result.current.attempt).toBe(1);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(MockWebSocket.count).toBe(2);
  });

  it('every message resets the watchdog', () => {
    const onHeartbeatTimeout = vi.fn();
    const { result } = renderFeed({ heartbeat, onHeartbeatTimeout });
    act(() => {
      MockWebSocket.current.serverOpen();
    });

    for (let round = 0; round < 5; round += 1) {
      act(() => {
        vi.advanceTimersByTime(9_000);
      });
      act(() => {
        MockWebSocket.current.serverMessage(JSON.stringify({ symbol: 'A', price: 1 }));
      });
    }

    expect(onHeartbeatTimeout).not.toHaveBeenCalled();
    expect(result.current.status).toBe('open');

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onHeartbeatTimeout).toHaveBeenCalledTimes(1);
  });

  it('ignores a heartbeat with a non-positive timeout', () => {
    const { result } = renderFeed({ heartbeat: { timeoutMs: 0, intervalMs: 1_000 } });
    act(() => {
      MockWebSocket.current.serverOpen();
    });

    act(() => {
      vi.advanceTimersByTime(120_000);
    });

    expect(result.current.status).toBe('open');
    expect(MockWebSocket.current.sent).toEqual([]);
  });
});

describe('useWebSocketFeed — cleanup', () => {
  it('closes the socket and detaches every listener on unmount', () => {
    const { unmount } = renderFeed();
    act(() => {
      MockWebSocket.current.serverOpen();
    });
    const socket = MockWebSocket.current;

    unmount();

    expect(socket.closeCalls).toHaveLength(1);
    expect(socket.readyState).toBe(3);
    expect(socket.listenerCount).toBe(0);
  });

  it('never reconnects after unmount', () => {
    const { unmount } = renderFeed({ heartbeat: { timeoutMs: 5_000 } });
    act(() => {
      MockWebSocket.current.serverOpen();
    });

    unmount();
    act(() => {
      vi.advanceTimersByTime(120_000);
    });

    expect(MockWebSocket.count).toBe(1);
  });

  it('cancels a pending reconnect timer on unmount', () => {
    const { unmount } = renderFeed();
    act(() => {
      MockWebSocket.current.serverOpen();
    });
    act(() => {
      MockWebSocket.current.serverClose();
    });

    unmount();
    act(() => {
      vi.advanceTimersByTime(120_000);
    });

    expect(MockWebSocket.count).toBe(1);
  });
});

describe('useWebSocketFeed — hostile transports', () => {
  it('adopts a socket that is already open', () => {
    const onOpen = vi.fn();
    const { result } = renderFeed({
      onOpen,
      socketFactory: (url) => {
        const socket = new MockWebSocket(url);
        // A pooled connection: open before we ever attach a listener.
        socket.readyState = 1;
        return socket;
      },
    });

    expect(result.current.status).toBe('open');
    expect(onOpen).toHaveBeenCalledWith({ attempt: 0, reconnected: false });
  });

  it('reconnects instead of hanging when handed a dead socket', () => {
    const { result } = renderFeed({
      socketFactory: (url) => {
        const socket = new MockWebSocket(url);
        socket.readyState = 3;
        return socket;
      },
    });

    expect(result.current.status).toBe('reconnecting');
    expect(result.current.attempt).toBe(1);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(MockWebSocket.count).toBe(2);
  });

  it('reports a send that throws instead of propagating it', () => {
    const onError = vi.fn();
    const { result } = renderFeed({ onError });
    act(() => {
      MockWebSocket.current.serverOpen();
    });
    MockWebSocket.current.sendShouldThrow = true;

    expect(result.current.send('boom')).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(result.current.getMetrics().errors).toBe(1);
    expect(result.current.status).toBe('open');
  });

  it('survives a close that throws during teardown', () => {
    const { unmount } = renderFeed();
    act(() => {
      MockWebSocket.current.serverOpen();
    });
    MockWebSocket.current.closeShouldThrow = true;

    expect(() => unmount()).not.toThrow();
  });

  it('stops trying when the url is taken away mid-connection', () => {
    const { result, rerender } = renderFeed();
    act(() => {
      MockWebSocket.current.serverOpen();
    });

    rerender({ url: null, parse: parseQuote, socketFactory: mockSocketFactory });

    expect(result.current.status).toBe('closed');
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(MockWebSocket.count).toBe(1);
  });
});

describe('useWebSocketFeed — StrictMode', () => {
  it('connects even though StrictMode mounts, tears down, and mounts again', () => {
    const { result } = renderHook(
      (props: UseWebSocketFeedOptions<Quote>) => useWebSocketFeed(props),
      {
        initialProps: {
          url: URL,
          parse: parseQuote,
          socketFactory: mockSocketFactory,
        } satisfies UseWebSocketFeedOptions<Quote>,
        wrapper: StrictMode,
      },
    );

    // Two sockets get built (one per mount pass); the first is closed cleanly
    // and the survivor is the one we are listening to.
    const survivor = MockWebSocket.current;
    expect(result.current.status).toBe('connecting');

    act(() => {
      survivor.serverOpen();
    });

    expect(result.current.status).toBe('open');

    const onItem = vi.fn();
    act(() => {
      survivor.serverMessage(JSON.stringify({ symbol: 'AAPL', price: 1 }));
    });
    expect(result.current.getMetrics().received).toBe(1);
    expect(onItem).not.toHaveBeenCalled();

    for (const socket of MockWebSocket.instances) {
      if (socket !== survivor) expect(socket.readyState).toBe(3);
    }
  });

  it('still reconnects after a StrictMode remount', () => {
    const { result } = renderHook(
      (props: UseWebSocketFeedOptions<Quote>) => useWebSocketFeed(props),
      {
        initialProps: {
          url: URL,
          parse: parseQuote,
          socketFactory: mockSocketFactory,
        } satisfies UseWebSocketFeedOptions<Quote>,
        wrapper: StrictMode,
      },
    );

    act(() => {
      MockWebSocket.current.serverOpen();
    });
    const countAfterOpen = MockWebSocket.count;

    act(() => {
      MockWebSocket.current.serverClose();
    });
    expect(result.current.status).toBe('reconnecting');

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(MockWebSocket.count).toBe(countAfterOpen + 1);
  });

  it('closes every socket it opened when a StrictMode tree unmounts', () => {
    const { unmount } = renderHook(
      (props: UseWebSocketFeedOptions<Quote>) => useWebSocketFeed(props),
      {
        initialProps: {
          url: URL,
          parse: parseQuote,
          socketFactory: mockSocketFactory,
        } satisfies UseWebSocketFeedOptions<Quote>,
        wrapper: StrictMode,
      },
    );
    act(() => {
      MockWebSocket.current.serverOpen();
    });

    unmount();
    act(() => {
      vi.advanceTimersByTime(120_000);
    });

    for (const socket of MockWebSocket.instances) {
      expect(socket.readyState).toBe(3);
      expect(socket.listenerCount).toBe(0);
    }
  });
});

describe('computeBackoffDelay', () => {
  it('doubles from one second and caps at thirty', () => {
    const schedule = [1, 2, 3, 4, 5, 6, 7, 8].map((attempt) => computeBackoffDelay(attempt));
    expect(schedule).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });

  it('treats attempt 0 like the first attempt', () => {
    expect(computeBackoffDelay(0)).toBe(1_000);
  });

  it('respects a custom curve', () => {
    const options = { initialDelayMs: 250, factor: 4, maxDelayMs: 5_000 };
    expect([1, 2, 3, 4].map((attempt) => computeBackoffDelay(attempt, options))).toEqual([
      250, 1_000, 4_000, 5_000,
    ]);
  });

  it('only ever jitters downwards, never past the cap', () => {
    const options = { jitter: 0.5, random: () => 1 };
    // random() === 1 → the full jitter fraction is subtracted.
    expect(computeBackoffDelay(1, options)).toBe(500);
    expect(computeBackoffDelay(1, { jitter: 0.5, random: () => 0 })).toBe(1_000);

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const delay = computeBackoffDelay(attempt, { jitter: 1 });
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(30_000);
    }
  });

  it('clamps jitter above one', () => {
    expect(computeBackoffDelay(1, { jitter: 5, random: () => 1 })).toBe(0);
  });
});
