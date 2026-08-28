import { useEffect, useMemo, useRef, useState } from 'react';
import { useLatestRef } from './hooks';

export type FeedStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** The shape of the events we read. Structural, so mocks are trivial. */
export interface FeedEvent {
  readonly type?: string;
  readonly data?: unknown;
  readonly code?: number;
  readonly reason?: string;
  readonly wasClean?: boolean;
}

/**
 * The subset of `WebSocket` this hook actually touches. A real `WebSocket`
 * satisfies it; so does a ten-line fake, which is why the tests (and the demo's
 * mock market feed) can exercise every path without a server.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: FeedEvent) => void): void;
  removeEventListener(type: string, listener: (event: FeedEvent) => void): void;
}

export type SocketFactory = (url: string, protocols?: string | string[]) => WebSocketLike;

export interface ReconnectOptions {
  /** Set `false` (or pass `reconnect: false`) to fail fast instead. Default `true`. */
  enabled?: boolean;
  /** Delay before attempt #1. Default 1000ms. */
  initialDelayMs?: number;
  /** Ceiling for the exponential growth. Default 30000ms. */
  maxDelayMs?: number;
  /** Growth per attempt. Default 2 → 1s, 2s, 4s, 8s, 16s, 30s, 30s… */
  factor?: number;
  /**
   * Randomise each delay downwards by up to this fraction, in `[0, 1]`.
   * `0.2` → 80–100% of the computed delay. Default `0`: a deterministic
   * schedule, which is easier to reason about and to test. Turn it on when many
   * clients reconnect to the same server at once.
   */
  jitter?: number;
  /** Give up after this many consecutive failures. Default: never give up. */
  maxAttempts?: number;
  /** Injectable randomness for jitter. Default `Math.random`. */
  random?: () => number;
}

export interface HeartbeatOptions {
  /**
   * If no message arrives for this long, treat the socket as dead and
   * reconnect. This is the one that matters: a TCP connection can be "open"
   * forever after the network has quietly gone away.
   */
  timeoutMs: number;
  /** Also send a keepalive this often. Omit to only listen, never ping. */
  intervalMs?: number;
  /** The keepalive payload. Default `'ping'`. */
  message?: string | (() => string);
}

export interface FeedMetrics {
  /** Raw socket messages seen. */
  received: number;
  /** Items produced by `parse` and handed to `onItem`. */
  parsed: number;
  /** Messages `parse` rejected, threw on, or returned nothing for. */
  dropped: number;
  /** Sockets that reached `open`. */
  opens: number;
  /** Successful reconnections (opens that followed a failure). */
  reconnects: number;
  /** Socket-level error events. */
  errors: number;
}

export interface UseWebSocketFeedOptions<T> {
  /** Where to connect. `null`/`undefined` keeps the hook idle. */
  url: string | null | undefined;

  /**
   * Turn a raw message into an item, a batch of items, or nothing.
   *
   * This is the trust boundary. Throw, return `null`, return `undefined` — all
   * three mean "drop it", and none of them can take the UI down. Malformed
   * JSON, a half-written frame, a heartbeat echo, a message for a symbol you
   * don't track: all just dropped.
   */
  parse: (raw: unknown) => T | T[] | null | undefined;

  /** Called for each parsed item. Usually `store.ingest`. */
  onItem?: (item: T) => void;

  onOpen?: (info: { attempt: number; reconnected: boolean }) => void;

  /**
   * Fired when a connection re-opens after a failure — the hook point for
   * resync. A coalescing store only holds the *latest* value per key, so after
   * a gap you want a fresh snapshot rather than a replay: refetch here and
   * `ingestMany` the result.
   */
  onReconnect?: (info: { attempt: number }) => void;

  onClose?: (event: FeedEvent) => void;
  onError?: (error: unknown) => void;
  /** Called instead of crashing when `parse` throws or rejects a message. */
  onParseError?: (error: unknown, raw: unknown) => void;
  /** The heartbeat watchdog fired: no traffic within `timeoutMs`. */
  onHeartbeatTimeout?: () => void;
  /** `maxAttempts` exhausted; the feed is now `closed` and will stay there. */
  onGiveUp?: (info: { attempts: number }) => void;

  reconnect?: ReconnectOptions | false;
  heartbeat?: HeartbeatOptions | false;
  protocols?: string | string[];
  /** Override socket construction (tests, mocks, custom transports). */
  socketFactory?: SocketFactory;
  /** Connect on mount. Default `true`. */
  autoConnect?: boolean;
}

/**
 * Every function here is a stable, standalone reference — declared as a
 * property rather than a method so it is safe to destructure, pass as a
 * callback, or list in a dependency array.
 */
export interface WebSocketFeed {
  /** `connecting` → `open`, or `reconnecting` while backing off. */
  status: FeedStatus;
  /** Consecutive failed attempts. `0` whenever the socket is healthy. */
  attempt: number;
  /** Send on the live socket. Returns `false` if there isn't one. */
  send: (data: string) => boolean;
  /** Connect (or reconnect immediately, resetting the backoff). */
  connect: () => void;
  /** Close and stay closed until `connect()`. */
  disconnect: () => void;
  /** Escape hatch for the live socket. `null` unless open or connecting. */
  getSocket: () => WebSocketLike | null;
  /** `Date.now()` of the last message, or `null`. Read, don't render. */
  getLastMessageAt: () => number | null;
  /**
   * Throughput counters. Deliberately a getter: at thousands of messages a
   * second, re-rendering on every message is the bug we exist to prevent.
   */
  getMetrics: () => FeedMetrics;
}

const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSED = 3;
const CLOSE_NORMAL = 1000;
const CLOSE_HEARTBEAT_TIMEOUT = 4000;

type TimerHandle = ReturnType<typeof setTimeout>;

export type NormalizedReconnectOptions = Required<Omit<ReconnectOptions, 'random'>> &
  Pick<ReconnectOptions, 'random'>;

export const DEFAULT_RECONNECT_OPTIONS: NormalizedReconnectOptions = {
  enabled: true,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  factor: 2,
  jitter: 0,
  maxAttempts: Number.POSITIVE_INFINITY,
};

export function normalizeReconnectOptions(
  input: ReconnectOptions | false | undefined,
): NormalizedReconnectOptions {
  if (input === false) return { ...DEFAULT_RECONNECT_OPTIONS, enabled: false };
  return { ...DEFAULT_RECONNECT_OPTIONS, ...input };
}

/**
 * Exponential backoff, capped, optionally jittered downwards.
 *
 * With the defaults, attempts 1…n wait 1s, 2s, 4s, 8s, 16s, 30s, 30s, … The
 * cap matters more than the curve: an unbounded doubling means a client that
 * was offline over a weekend takes hours to notice the network came back.
 */
export function computeBackoffDelay(
  attempt: number,
  options: ReconnectOptions | false | undefined = undefined,
): number {
  const { initialDelayMs, maxDelayMs, factor, jitter, random } = normalizeReconnectOptions(options);
  const exponent = Math.max(0, attempt - 1);
  const capped = Math.min(initialDelayMs * Math.pow(factor, exponent), maxDelayMs);
  if (jitter <= 0) return capped;
  const amount = Math.min(1, jitter);
  const rng = random ?? Math.random;
  return Math.round(capped * (1 - amount * rng()));
}

function normalizeHeartbeat(
  input: HeartbeatOptions | false | undefined,
):
  | (Required<Pick<HeartbeatOptions, 'timeoutMs' | 'intervalMs'>> &
      Pick<HeartbeatOptions, 'message'>)
  | null {
  if (!input || input.timeoutMs <= 0) return null;
  return { timeoutMs: input.timeoutMs, intervalMs: input.intervalMs ?? 0, message: input.message };
}

const defaultSocketFactory: SocketFactory = (url, protocols) => {
  if (typeof WebSocket === 'undefined') {
    throw new Error(
      'tickwork: no global WebSocket in this environment. Pass `socketFactory` to useWebSocketFeed.',
    );
  }
  // No cast: a real WebSocket structurally satisfies WebSocketLike.
  return new WebSocket(url, protocols);
};

export function initialFeedStatus<T>(options: UseWebSocketFeedOptions<T>): FeedStatus {
  return options.url && options.autoConnect !== false ? 'connecting' : 'closed';
}

interface FeedControllerState {
  status: FeedStatus;
  attempt: number;
}

interface FeedController {
  connect: () => void;
  disconnect: () => void;
  destroy: () => void;
  send: (data: string) => boolean;
  getSocket: () => WebSocketLike | null;
  getLastMessageAt: () => number | null;
  getMetrics: () => FeedMetrics;
}

/**
 * All of the connection logic, deliberately outside React.
 *
 * It is created once per hook instance and never re-created, so timers and
 * sockets survive re-renders. React only learns about `{ status, attempt }`;
 * everything high-frequency (messages, byte counts) stays in closures where it
 * cannot cause a render.
 */
function createFeedController<T>(
  latest: { readonly current: UseWebSocketFeedOptions<T> },
  publishState: (state: FeedControllerState) => void,
): FeedController {
  let status: FeedStatus = initialFeedStatus(latest.current);
  let publishedStatus: FeedStatus = status;
  let publishedAttempt = 0;

  let socket: WebSocketLike | null = null;
  let detachListeners: (() => void) | null = null;

  let reconnectTimer: TimerHandle | null = null;
  let pingTimer: TimerHandle | null = null;
  let watchdogTimer: TimerHandle | null = null;

  let attempt = 0;
  let intentionallyClosed = false;
  let destroyed = false;
  let lastMessageAt: number | null = null;

  const metrics: FeedMetrics = {
    received: 0,
    parsed: 0,
    dropped: 0,
    opens: 0,
    reconnects: 0,
    errors: 0,
  };

  function publish(next: FeedStatus): void {
    status = next;
    if (publishedStatus === status && publishedAttempt === attempt) return;
    publishedStatus = status;
    publishedAttempt = attempt;
    publishState({ status, attempt });
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer === null) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function stopHeartbeat(): void {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (watchdogTimer !== null) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function resetWatchdog(): void {
    const heartbeat = normalizeHeartbeat(latest.current.heartbeat);
    if (watchdogTimer !== null) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
    if (heartbeat === null) return;
    watchdogTimer = setTimeout(handleDeadConnection, heartbeat.timeoutMs);
  }

  function startHeartbeat(): void {
    stopHeartbeat();
    const heartbeat = normalizeHeartbeat(latest.current.heartbeat);
    if (heartbeat === null) return;
    if (heartbeat.intervalMs > 0) {
      pingTimer = setInterval(() => {
        const { message } = heartbeat;
        send(typeof message === 'function' ? message() : (message ?? 'ping'));
      }, heartbeat.intervalMs);
    }
    resetWatchdog();
  }

  /**
   * The socket went quiet. Don't wait for a close event — a half-open socket
   * may never emit one, which is exactly the failure mode a heartbeat exists to
   * catch. Tear it down ourselves and go straight to the backoff loop.
   */
  function handleDeadConnection(): void {
    watchdogTimer = null;
    latest.current.onHeartbeatTimeout?.();
    stopHeartbeat();
    closeSocket(CLOSE_HEARTBEAT_TIMEOUT, 'tickwork: heartbeat timeout');
    if (destroyed) return;
    scheduleReconnect();
  }

  /** Detach handlers *before* closing, so our own close never loops back in. */
  function closeSocket(code?: number, reason?: string): void {
    const current = socket;
    detachListeners?.();
    detachListeners = null;
    socket = null;
    if (current === null) return;
    try {
      current.close(code, reason);
    } catch {
      // Already gone. Nothing to do, and nothing worth crashing over.
    }
  }

  function handleRaw(raw: unknown): void {
    const options = latest.current;
    metrics.received += 1;

    let result: T | T[] | null | undefined;
    try {
      result = options.parse(raw);
    } catch (error) {
      metrics.dropped += 1;
      options.onParseError?.(error, raw);
      return;
    }

    if (result === null || result === undefined) {
      metrics.dropped += 1;
      return;
    }

    const onItem = options.onItem;
    if (Array.isArray(result)) {
      for (const item of result) {
        if (item === null || item === undefined) {
          metrics.dropped += 1;
          continue;
        }
        metrics.parsed += 1;
        onItem?.(item);
      }
      return;
    }

    metrics.parsed += 1;
    onItem?.(result);
  }

  function openSocket(): void {
    if (destroyed) return;
    const options = latest.current;
    const url = options.url;
    if (!url) {
      publish('closed');
      return;
    }

    closeSocket(CLOSE_NORMAL, 'tickwork: replacing socket');

    let next: WebSocketLike;
    try {
      next = (options.socketFactory ?? defaultSocketFactory)(url, options.protocols);
    } catch (error) {
      metrics.errors += 1;
      latest.current.onError?.(error);
      scheduleReconnect();
      return;
    }

    socket = next;
    publish(attempt === 0 ? 'connecting' : 'reconnecting');

    const isStale = (): boolean => socket !== next;

    const handleOpen = (): void => {
      if (isStale()) return;
      const attemptsTaken = attempt;
      const reconnected = attemptsTaken > 0;
      attempt = 0;
      metrics.opens += 1;
      lastMessageAt = Date.now();
      publish('open');
      startHeartbeat();
      latest.current.onOpen?.({ attempt: attemptsTaken, reconnected });
      if (reconnected) {
        metrics.reconnects += 1;
        latest.current.onReconnect?.({ attempt: attemptsTaken });
      }
    };

    const handleMessage = (event: FeedEvent): void => {
      if (isStale()) return;
      lastMessageAt = Date.now();
      resetWatchdog();
      handleRaw(event.data);
    };

    const handleError = (event: FeedEvent): void => {
      if (isStale()) return;
      metrics.errors += 1;
      latest.current.onError?.(event);
    };

    const handleClose = (event: FeedEvent): void => {
      if (isStale()) return;
      detachListeners?.();
      detachListeners = null;
      socket = null;
      stopHeartbeat();
      latest.current.onClose?.(event);
      if (destroyed) return;
      if (intentionallyClosed) {
        publish('closed');
        return;
      }
      scheduleReconnect();
    };

    next.addEventListener('open', handleOpen);
    next.addEventListener('message', handleMessage);
    next.addEventListener('error', handleError);
    next.addEventListener('close', handleClose);

    detachListeners = () => {
      next.removeEventListener('open', handleOpen);
      next.removeEventListener('message', handleMessage);
      next.removeEventListener('error', handleError);
      next.removeEventListener('close', handleClose);
    };

    // A real WebSocket is always CONNECTING at this point, but a custom
    // `socketFactory` can hand back a pooled or shared connection whose 'open'
    // event has already been and gone. Adopt its current state rather than
    // waiting for an event that will never arrive.
    if (next.readyState === WEBSOCKET_OPEN) {
      handleOpen();
    } else if (next.readyState === WEBSOCKET_CLOSED) {
      closeSocket();
      scheduleReconnect();
    }
  }

  function scheduleReconnect(): void {
    if (destroyed) return;
    const options = latest.current;
    const config = normalizeReconnectOptions(options.reconnect);

    if (!config.enabled || !options.url) {
      publish('closed');
      return;
    }

    const nextAttempt = attempt + 1;
    if (nextAttempt > config.maxAttempts) {
      const attempts = attempt;
      publish('closed');
      options.onGiveUp?.({ attempts });
      return;
    }

    attempt = nextAttempt;
    publish('reconnecting');

    clearReconnectTimer();
    reconnectTimer = setTimeout(
      () => {
        reconnectTimer = null;
        openSocket();
      },
      computeBackoffDelay(nextAttempt, options.reconnect),
    );
  }

  function send(data: string): boolean {
    const current = socket;
    if (current === null || current.readyState !== WEBSOCKET_OPEN) return false;
    try {
      current.send(data);
      return true;
    } catch (error) {
      metrics.errors += 1;
      latest.current.onError?.(error);
      return false;
    }
  }

  return {
    connect() {
      // Revive a torn-down controller. StrictMode runs mount → cleanup →
      // mount, so `destroy()` fires before the second `connect()`; without
      // this, a development build would never connect at all.
      destroyed = false;
      intentionallyClosed = false;
      clearReconnectTimer();
      attempt = 0;
      openSocket();
    },
    disconnect() {
      intentionallyClosed = true;
      clearReconnectTimer();
      stopHeartbeat();
      closeSocket(CLOSE_NORMAL, 'tickwork: client disconnect');
      attempt = 0;
      publish('closed');
    },
    /**
     * Tear everything down: no timers, no socket, no reconnects. `connect()`
     * brings it back, which is what makes StrictMode's remount work.
     */
    destroy() {
      destroyed = true;
      intentionallyClosed = true;
      clearReconnectTimer();
      stopHeartbeat();
      closeSocket(CLOSE_NORMAL, 'tickwork: unmount');
    },
    send,
    getSocket: () => socket,
    getLastMessageAt: () => lastMessageAt,
    getMetrics: () => ({ ...metrics }),
  };
}

/**
 * A WebSocket connection with the boring-but-essential parts handled:
 * exponential backoff, heartbeat/timeout detection, resync-on-reconnect, and a
 * parse boundary that drops bad messages instead of unmounting your app.
 *
 * The hook re-renders on connection *status*, never on traffic. Route the data
 * itself into a store from `onItem` and let the store decide when to paint.
 *
 * ```tsx
 * const feed = useWebSocketFeed<Tick>({
 *   url: 'wss://example.com/ticks',
 *   parse: createJsonParser(isTick),
 *   onItem: store.ingest,
 *   heartbeat: { timeoutMs: 10_000, intervalMs: 5_000 },
 *   onReconnect: () => void resyncSnapshot(),
 * });
 * ```
 */
export function useWebSocketFeed<T>(options: UseWebSocketFeedOptions<T>): WebSocketFeed {
  const latest = useLatestRef(options);
  const [state, setState] = useState<FeedControllerState>(() => ({
    status: initialFeedStatus(options),
    attempt: 0,
  }));

  // One controller per hook instance, for the life of the component.
  const controllerRef = useRef<FeedController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createFeedController<T>(latest, setState);
  }
  const controller = controllerRef.current;

  const url = options.url ?? null;
  const autoConnect = options.autoConnect !== false;

  // Reconnect when the target changes; nothing else in `options` disturbs the
  // live socket, because everything else is read through `latest`.
  useEffect(() => {
    if (!url || !autoConnect) return undefined;
    controller.connect();
    return () => controller.disconnect();
  }, [controller, url, autoConnect]);

  // Unmount: kill timers and the socket, and refuse to reconnect afterwards.
  useEffect(() => () => controller.destroy(), [controller]);

  return useMemo<WebSocketFeed>(
    () => ({
      status: state.status,
      attempt: state.attempt,
      send: controller.send,
      connect: controller.connect,
      disconnect: controller.disconnect,
      getSocket: controller.getSocket,
      getLastMessageAt: controller.getLastMessageAt,
      getMetrics: controller.getMetrics,
    }),
    [controller, state.status, state.attempt],
  );
}
