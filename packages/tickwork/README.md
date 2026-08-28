# ⚡ tickwork

**React primitives for high-frequency real-time UIs.** Your feed pushes thousands of updates a second; your UI renders once a frame, and only the rows that changed.

- rAF-batched keyed store with structural backpressure — the pending queue can never grow past the number of distinct keys
- Per-key subscriptions via `useSyncExternalStore`, with reference-stable snapshots
- A WebSocket hook with capped exponential backoff, a heartbeat watchdog, resync-on-reconnect, and a parse boundary that drops bad frames instead of crashing
- Zero runtime dependencies · 4.6 kB min+gzip · TypeScript strict · ESM + CJS

```sh
npm install tickwork
```

```tsx
const store = useMemo(() => createRealtimeStore<Tick>({ getKey: (t) => t.symbol }), []);

useWebSocketFeed({ url, parse: createJsonParser(isTick), onItem: store.ingest });

return <LiveTable store={store} columns={columns} />;
```

**[Full documentation, measured benchmarks, and a live demo → github.com/anbochkarev1991/tickwork](https://github.com/anbochkarev1991/tickwork#readme)**

MIT © Anton Bochkarev
