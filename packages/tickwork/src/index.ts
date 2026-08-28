/**
 * tickwork — React primitives for high-frequency real-time UIs.
 *
 * The feed can push thousands of updates a second; the UI renders once a frame,
 * and only the rows that changed. See the README for the why.
 */

export { createRealtimeStore } from './store';
export {
  createManualScheduler,
  createTimeoutScheduler,
  rafScheduler,
  type CancelScheduledTask,
  type ManualScheduler,
  type Scheduler,
} from './scheduler';
export { useLatestRef, useRealtimeKeys, useRealtimeMetrics, useRealtimeValue } from './hooks';
export {
  computeBackoffDelay,
  DEFAULT_RECONNECT_OPTIONS,
  initialFeedStatus,
  normalizeReconnectOptions,
  useWebSocketFeed,
  type FeedEvent,
  type FeedMetrics,
  type FeedStatus,
  type HeartbeatOptions,
  type NormalizedReconnectOptions,
  type ReconnectOptions,
  type SocketFactory,
  type UseWebSocketFeedOptions,
  type WebSocketFeed,
  type WebSocketLike,
} from './use-web-socket-feed';
export { createJsonParser } from './parsers';
export { LiveTable, LiveTableRow, type LiveTableColumn, type LiveTableProps } from './live-table';
export { ensureLiveTableStyles, LIVE_TABLE_STYLES } from './styles';
export type {
  CreateRealtimeStoreOptions,
  Listener,
  RealtimeStore,
  RealtimeStoreMetrics,
  Unsubscribe,
} from './types';
