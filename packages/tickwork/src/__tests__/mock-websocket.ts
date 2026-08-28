import type { FeedEvent, WebSocketLike } from '../use-web-socket-feed';

type Listener = (event: FeedEvent) => void;

/**
 * A WebSocket test double. Nothing happens until a test says so: no automatic
 * open, no automatic close. Every transition is driven explicitly.
 */
export class MockWebSocket implements WebSocketLike {
  static instances: MockWebSocket[] = [];

  static reset(): void {
    MockWebSocket.instances = [];
  }

  static get current(): MockWebSocket {
    const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    if (socket === undefined) throw new Error('No MockWebSocket has been created');
    return socket;
  }

  static get count(): number {
    return MockWebSocket.instances.length;
  }

  readyState = 0; // CONNECTING
  /** Make `send` blow up, the way a socket dying mid-call would. */
  sendShouldThrow = false;
  /** Make `close` blow up, the way some broken transports do. */
  closeShouldThrow = false;
  readonly sent: string[] = [];
  readonly closeCalls: { code?: number; reason?: string }[] = [];

  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    if (this.sendShouldThrow) throw new Error('MockWebSocket: send failed');
    if (this.readyState !== 1) throw new Error('MockWebSocket: send on a socket that is not open');
    this.sent.push(data);
  }

  /** The client closing the socket. */
  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    if (this.closeShouldThrow) throw new Error('MockWebSocket: close failed');
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', { type: 'close', code: code ?? 1000, reason, wasClean: true });
  }

  /** How many handlers are attached — proves cleanup detached them. */
  get listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  // --- test drivers -------------------------------------------------------

  serverOpen(): void {
    this.readyState = 1;
    this.emit('open', { type: 'open' });
  }

  serverMessage(data: unknown): void {
    this.emit('message', { type: 'message', data });
  }

  serverError(): void {
    this.emit('error', { type: 'error' });
  }

  /** An unclean disconnect: the network went away. */
  serverClose(code = 1006, reason = 'abnormal closure'): void {
    this.readyState = 3;
    this.emit('close', { type: 'close', code, reason, wasClean: false });
  }

  private emit(type: string, event: FeedEvent): void {
    const set = this.listeners.get(type);
    if (set === undefined) return;
    for (const listener of Array.from(set)) listener(event);
  }
}

export const mockSocketFactory = (url: string, protocols?: string | string[]): WebSocketLike =>
  new MockWebSocket(url, protocols);
