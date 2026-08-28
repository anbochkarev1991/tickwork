import type { FeedEvent, SocketFactory, WebSocketLike } from 'tickwork';
import { createMarket, type Tick } from './market';

/**
 * A WebSocket-shaped fake that emits JSON ticks at a configurable rate, and can
 * be killed on demand to demonstrate reconnection.
 *
 * Because `useWebSocketFeed` accepts a `socketFactory`, this plugs into exactly
 * the same code path a real `wss://` connection would take — including backoff,
 * heartbeat and parse failures.
 */

const FRAME_MS = 16;
const CONNECT_DELAY_MS = 220;
/**
 * Cap on undelivered messages. A real client under this much pressure would be
 * dropping frames too — and without a cap, naive mode would grow the queue
 * without bound and never recover.
 */
const MAX_QUEUE = 25_000;

type Listener = (event: FeedEvent) => void;

interface MockSocket extends WebSocketLike {
  /** Kill the socket the way a network blip would: no clean close. */
  kill(): void;
  /** Push an arbitrary payload down the wire, valid or not. */
  emitRaw(data: unknown): void;
  /** Messages generated but not yet dispatched. */
  readonly queueDepth: number;
  /** Messages thrown away because the client could not keep up. */
  readonly droppedByBackpressure: number;
}

export interface MockFeedController {
  /** Pass straight to `useWebSocketFeed({ socketFactory })`. */
  socketFactory: SocketFactory;
  setRate(messagesPerSecond: number): void;
  getRate(): number;
  setPaused(paused: boolean): void;
  isPaused(): boolean;
  /** Simulate a dropped connection. The feed will back off and reconnect. */
  dropConnection(): void;
  /** Inject a malformed frame to prove the parse boundary holds. */
  injectGarbage(): void;
  /** Full state of the market — what a real app would refetch on reconnect. */
  snapshot(): Tick[];
  getSentCount(): number;
  /** Undelivered backlog — non-zero means the page cannot keep up. */
  getQueueDepth(): number;
}

export function createMockFeed(initialRate: number): MockFeedController {
  const market = createMarket();
  let rate = initialRate;
  let paused = false;
  let sent = 0;
  let live: MockSocket | null = null;

  function createMockSocket(): MockSocket {
    const listeners = new Map<string, Set<Listener>>();
    let readyState = 0; // CONNECTING
    let ticker: ReturnType<typeof setInterval> | null = null;
    /** Fractional carry, so 1 msg/sec is as accurate as 5,000. */
    let debt = 0;

    const emit = (type: string, event: FeedEvent): void => {
      const set = listeners.get(type);
      if (set === undefined) return;
      for (const listener of Array.from(set)) listener(event);
    };

    /**
     * Message delivery, one macrotask per message.
     *
     * This detail decides whether the demo is honest. A real WebSocket
     * dispatches every frame in its own task, so a naive `setState` per message
     * really does mean a render per message. If the mock instead emitted a
     * whole batch synchronously, React's automatic batching would collapse the
     * batch into one render for free and the comparison would be rigged in the
     * naive implementation's favour.
     *
     * `MessageChannel` gives us a genuine macrotask per message with none of
     * `setTimeout`'s 4ms clamping.
     */
    const channel = new MessageChannel();
    const queue: string[] = [];
    let dropped = 0;

    let pumping = false;

    const pump = (): void => {
      if (pumping || readyState !== 1) return;
      pumping = true;
      channel.port2.postMessage(null);
    };

    channel.port1.onmessage = () => {
      pumping = false;
      if (readyState !== 1) return;
      const payload = queue.shift();
      if (payload !== undefined) emit('message', { type: 'message', data: payload });
      // Chain rather than burst: posting the *next* delivery only after this
      // one lands means the task queue gets a turn in between, so React's
      // render task interleaves with arriving messages. Queueing a whole
      // tick's worth of tasks up front would let React batch them all into one
      // render — free performance no real feed would ever hand you.
      if (queue.length > 0) pump();
    };

    const deliver = (payload: string): void => {
      if (queue.length >= MAX_QUEUE) {
        dropped += 1;
        return;
      }
      queue.push(payload);
      pump();
    };

    const stopTicking = (): void => {
      if (ticker === null) return;
      clearInterval(ticker);
      ticker = null;
    };

    const startTicking = (): void => {
      stopTicking();
      ticker = setInterval(() => {
        if (readyState !== 1 || paused) return;
        debt += (rate * FRAME_MS) / 1000;
        const count = Math.floor(debt);
        debt -= count;
        for (let index = 0; index < count; index += 1) {
          sent += 1;
          deliver(JSON.stringify(market.nextTick()));
        }
      }, FRAME_MS);
    };

    const openTimer = setTimeout(() => {
      readyState = 1; // OPEN
      emit('open', { type: 'open' });
      startTicking();
    }, CONNECT_DELAY_MS);

    const shutdown = (code: number, reason: string, wasClean: boolean): void => {
      if (readyState === 3) return;
      readyState = 3; // CLOSED
      clearTimeout(openTimer);
      stopTicking();
      queue.length = 0;
      channel.port1.onmessage = null;
      channel.port1.close();
      channel.port2.close();
      if (live === socket) live = null;
      emit('close', { type: 'close', code, reason, wasClean });
    };

    const socket: MockSocket = {
      get readyState() {
        return readyState;
      },
      send(data: string) {
        // Answer heartbeats, so the watchdog stays happy while the feed is paused.
        if (data === 'ping' && readyState === 1) {
          emit('message', { type: 'message', data: JSON.stringify({ pong: Date.now() }) });
        }
      },
      close(code = 1000, reason = '') {
        shutdown(code, reason, true);
      },
      kill() {
        emit('error', { type: 'error' });
        shutdown(1006, 'simulated network drop', false);
      },
      emitRaw(data: unknown) {
        if (readyState !== 1) return;
        sent += 1;
        emit('message', { type: 'message', data });
      },
      get queueDepth() {
        return queue.length;
      },
      get droppedByBackpressure() {
        return dropped;
      },
      addEventListener(type, listener) {
        let set = listeners.get(type);
        if (set === undefined) {
          set = new Set();
          listeners.set(type, set);
        }
        set.add(listener);
      },
      removeEventListener(type, listener) {
        listeners.get(type)?.delete(listener);
      },
    };

    live = socket;
    return socket;
  }

  return {
    socketFactory: () => createMockSocket(),
    setRate(messagesPerSecond) {
      rate = Math.max(0, messagesPerSecond);
    },
    getRate: () => rate,
    setPaused(next) {
      paused = next;
    },
    isPaused: () => paused,
    dropConnection() {
      live?.kill();
    },
    injectGarbage() {
      const socket = live;
      if (socket === null) return;
      // A truncated frame, a null payload, a proxy error page, and a binary
      // blob. `createJsonParser` throws or returns null for all four; the feed
      // counts them as dropped and the UI never notices.
      const payloads: unknown[] = [
        '{"symbol": "AAPL", "pri',
        'null',
        '<html>502 Bad Gateway</html>',
        new Uint8Array([1, 2, 3]),
      ];
      for (const payload of payloads) socket.emitRaw(payload);
    },
    snapshot: () => market.snapshot(),
    getSentCount: () => sent,
    getQueueDepth: () => live?.queueDepth ?? 0,
  };
}
