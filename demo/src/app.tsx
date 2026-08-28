import { useCallback, useMemo, useRef, useState } from 'react';
import {
  createJsonParser,
  createRealtimeStore,
  createTimeoutScheduler,
  LiveTable,
  rafScheduler,
  useRealtimeKeys,
  useWebSocketFeed,
  type FeedStatus,
  type LiveTableColumn,
  type Scheduler,
} from 'tickwork';
import { ChangeCell, Sparkline, SpreadCell } from './cells';
import {
  rowRenderCounter,
  useFrameStats,
  usePolledValue,
  useRatePerSecond,
} from './instrumentation';
import { isTick, SYMBOL_COUNT, type Tick } from './market';
import { createMockFeed } from './mock-socket';
import { NaiveTable } from './naive-table';

const RATE_PRESETS = [500, 2_000, 5_000, 10_000] as const;
const DEFAULT_RATE = 2_000;

/**
 * How often the store is allowed to flush — the render rate, set independently
 * of the data rate. This is the whole thesis made into a button: at 60fps the
 * digits are a blur, at 4/s the same feed is readable, and nothing is lost
 * either way because the store coalesces underneath.
 */
const DISPLAY_MODES = [
  // `flash` is kept well under the flush interval so the highlight reads as a
  // pulse with a clear off period, rather than sitting permanently lit.
  { id: 'frame', label: '60/s', note: 'every frame', flashMs: 260 },
  { id: 'calm', label: '10/s', note: 'every 100ms', flashMs: 70 },
  { id: 'readable', label: '4/s', note: 'every 250ms', flashMs: 130 },
] as const;

type DisplayId = (typeof DISPLAY_MODES)[number]['id'];

const parseTick = createJsonParser(isTick);

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const plain = new Intl.NumberFormat('en-US');

function signed(value: number, digits = 2): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

/**
 * Defined at module scope: a stable `columns` reference is what lets `LiveTable`
 * memoize its rows.
 */
const columns: readonly LiveTableColumn<Tick>[] = [
  {
    id: 'symbol',
    header: 'Symbol',
    width: 84,
    cell: (t) => {
      // One increment per row render — the instrument behind "row renders/s".
      rowRenderCounter.count += 1;
      return <span className="demo-symbol">{t.symbol}</span>;
    },
  },
  {
    id: 'price',
    header: 'Last',
    align: 'right',
    width: 92,
    // `flash` drives the green/red pulse by toggling a class on the <td>,
    // without any extra state or renders.
    flash: (t) => t.price,
    cell: (t) => <strong>{t.price.toFixed(2)}</strong>,
  },
  {
    id: 'change',
    header: 'Chg',
    align: 'right',
    width: 84,
    cell: (t) => (
      <span className={t.change >= 0 ? 'demo-up' : 'demo-down'}>{signed(t.change)}</span>
    ),
  },
  {
    id: 'changePct',
    header: 'Change',
    width: 168,
    cell: (t) => <ChangeCell value={t.changePct} />,
  },
  {
    id: 'trend',
    header: 'Trend · 6s',
    width: 100,
    cell: (t) => <Sparkline points={t.trend} />,
  },
  {
    id: 'bid',
    header: 'Bid',
    align: 'right',
    width: 84,
    cell: (t) => <span className="demo-muted">{t.bid.toFixed(2)}</span>,
  },
  {
    id: 'ask',
    header: 'Ask',
    align: 'right',
    width: 84,
    cell: (t) => <span className="demo-muted">{t.ask.toFixed(2)}</span>,
  },
  {
    id: 'spread',
    header: 'Spread bps',
    align: 'right',
    width: 92,
    cell: (t) => <SpreadCell bid={t.bid} ask={t.ask} />,
  },
  {
    id: 'volume',
    header: 'Volume',
    align: 'right',
    width: 88,
    cell: (t) => <span className="demo-muted">{compact.format(t.volume)}</span>,
  },
  {
    id: 'ticks',
    header: 'Ticks',
    align: 'right',
    width: 80,
    cell: (t) => <span className="demo-muted">{plain.format(t.ticks)}</span>,
  },
];

type Mode = 'tickwork' | 'naive';

export function App() {
  const store = useMemo(() => createRealtimeStore<Tick>({ getKey: (tick) => tick.symbol }), []);
  const mockFeed = useMemo(() => createMockFeed(DEFAULT_RATE), []);

  const [mode, setMode] = useState<Mode>('tickwork');
  const [rate, setRate] = useState<number>(DEFAULT_RATE);
  const [paused, setPaused] = useState(false);
  const [display, setDisplay] = useState<DisplayId>('frame');

  // Built once; `setScheduler` swaps between them while data keeps arriving.
  const schedulers = useMemo<Record<DisplayId, Scheduler>>(
    () => ({
      frame: rafScheduler,
      calm: createTimeoutScheduler(100),
      readable: createTimeoutScheduler(250),
    }),
    [],
  );

  const modeRef = useRef<Mode>(mode);
  modeRef.current = mode;
  const naiveSink = useRef<((tick: Tick) => void) | null>(null);

  const feed = useWebSocketFeed<Tick>({
    // No server involved: `socketFactory` returns the mock. Everything else —
    // backoff, heartbeat, parse boundary — is the real code path.
    url: 'wss://mock.tickwork.dev/marketdata',
    socketFactory: mockFeed.socketFactory,
    parse: parseTick,
    onItem: (tick) => {
      if (modeRef.current === 'tickwork') store.ingest(tick);
      else naiveSink.current?.(tick);
    },
    heartbeat: { timeoutMs: 8_000, intervalMs: 3_000 },
    reconnect: { initialDelayMs: 1_000, maxDelayMs: 30_000, jitter: 0.1 },
    // A coalescing store keeps only the newest value per key, so after a gap the
    // right move is a fresh snapshot, not a replay of what we missed.
    onReconnect: () => store.ingestMany(mockFeed.snapshot()),
  });

  const storeKeys = useRealtimeKeys(store);
  const sortedKeys = useMemo(() => [...storeKeys].sort(), [storeKeys]);

  const { fps, worstFrameMs } = useFrameStats();
  const messageRate = useRatePerSecond(useCallback(() => feed.getMetrics().received, [feed]));
  const appliedRate = useRatePerSecond(useCallback(() => store.getMetrics().applied, [store]));
  const coalescedRate = useRatePerSecond(useCallback(() => store.getMetrics().coalesced, [store]));
  const renderRate = useRatePerSecond(useCallback(() => rowRenderCounter.count, []));
  const backlog = usePolledValue(useCallback(() => mockFeed.getQueueDepth(), [mockFeed]));
  const flushRate = useRatePerSecond(useCallback(() => store.getMetrics().flushes, [store]));

  const registerNaiveSink = useCallback((sink: ((tick: Tick) => void) | null) => {
    naiveSink.current = sink;
  }, []);

  const handleRate = (next: number): void => {
    setRate(next);
    mockFeed.setRate(next);
  };

  const flashMs =
    DISPLAY_MODES.find((option) => option.id === display)?.flashMs ?? 260;

  const handleDisplay = (id: DisplayId): void => {
    setDisplay(id);
    store.setScheduler(schedulers[id]);
  };

  const handlePause = (): void => {
    const next = !paused;
    setPaused(next);
    mockFeed.setPaused(next);
  };

  const dropped = feed.getMetrics().dropped;

  return (
    <div className="demo-page">
      <header className="demo-header">
        <div className="demo-brand">
          <span className="demo-bolt" aria-hidden="true">
            ⚡
          </span>
          <div>
            <h1>tickwork</h1>
            <p>
              React primitives for high-frequency real-time UIs. The feed screams, the UI stays
              calm.
            </p>
          </div>
        </div>
        <a
          className="demo-link"
          href="https://github.com/anbochkarev1991/tickwork"
          target="_blank"
          rel="noreferrer"
        >
          GitHub ↗
        </a>
      </header>

      <section className="demo-stats" aria-label="Live performance counters">
        <Stat label="Feed in" value={`${compact.format(messageRate)}/s`} note="messages received" />
        <Stat
          label="Applied"
          value={`${compact.format(appliedRate)}/s`}
          note="committed to the DOM"
        />
        <Stat
          label="Coalesced"
          value={`${compact.format(coalescedRate)}/s`}
          note="superseded before paint"
          tone="muted"
        />
        <Stat
          label="Row renders"
          value={`${compact.format(renderRate)}/s`}
          note={`${SYMBOL_COUNT} rows on screen`}
        />
        <Stat
          label="Flushes"
          value={mode === 'tickwork' ? `${plain.format(flushRate)}/s` : 'n/a'}
          note={mode === 'tickwork' ? 'renders per second' : 'no batching at all'}
          tone={mode === 'tickwork' ? undefined : 'bad'}
        />
        <Stat
          label="Backlog"
          value={compact.format(backlog)}
          note="messages not yet delivered"
          tone={backlog > 500 ? 'bad' : 'muted'}
        />
        <Stat
          label="FPS"
          value={String(fps)}
          note={`worst frame ${worstFrameMs}ms`}
          tone={fps >= 50 ? 'good' : fps >= 30 ? 'warn' : 'bad'}
        />
        <Stat
          label="Dropped"
          value={plain.format(dropped)}
          note="unparseable (incl. heartbeats)"
          tone="muted"
        />
      </section>

      <section className="demo-controls">
        <div className="demo-control-group" role="group" aria-label="Rendering mode">
          <span className="demo-control-label">Mode</span>
          <button
            type="button"
            className={mode === 'tickwork' ? 'demo-btn is-active' : 'demo-btn'}
            onClick={() => setMode('tickwork')}
          >
            tickwork
          </button>
          <button
            type="button"
            className={mode === 'naive' ? 'demo-btn is-active is-danger' : 'demo-btn'}
            onClick={() => setMode('naive')}
          >
            naive setState
          </button>
        </div>

        <div className="demo-control-group" role="group" aria-label="Display rate">
          <span className="demo-control-label" title="How often the store flushes to the DOM">
            Display
          </span>
          {DISPLAY_MODES.map((option) => (
            <button
              key={option.id}
              type="button"
              className={display === option.id ? 'demo-btn is-active' : 'demo-btn'}
              onClick={() => handleDisplay(option.id)}
              disabled={mode === 'naive'}
              title={
                mode === 'naive'
                  ? 'Not available: naive setState renders on every message, so there is no render rate to set'
                  : option.note
              }
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="demo-control-group" role="group" aria-label="Feed rate">
          <span className="demo-control-label">Rate</span>
          {RATE_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              className={rate === preset ? 'demo-btn is-active' : 'demo-btn'}
              onClick={() => handleRate(preset)}
            >
              {compact.format(preset)}/s
            </button>
          ))}
        </div>

        <div className="demo-control-group">
          <span className="demo-control-label">Feed</span>
          <button type="button" className="demo-btn" onClick={handlePause}>
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" className="demo-btn" onClick={() => mockFeed.dropConnection()}>
            Drop connection
          </button>
          <button type="button" className="demo-btn" onClick={() => mockFeed.injectGarbage()}>
            Inject garbage
          </button>
        </div>

        <StatusPill status={feed.status} attempt={feed.attempt} />
      </section>

      {mode === 'naive' ? (
        <p className="demo-warning">
          Naive mode: one <code>setState</code> per message, re-rendering the whole table. Watch{' '}
          <strong>row renders</strong> climb past 45,000/s and <strong>backlog</strong> run away —
          the feed cannot be drained as fast as it arrives, so what you are reading is seconds
          stale and messages are being dropped. On fast hardware the frame rate survives; the
          data does not. On a slower machine you lose both.
        </p>
      ) : null}

      <main className="demo-main">
        {mode === 'tickwork' ? (
          <LiveTable
            store={store}
            columns={columns}
            keys={sortedKeys}
            maxHeight="min(60vh, 640px)"
            flashDurationMs={flashMs}
            aria-label="Live market data"
          />
        ) : (
          <NaiveTable register={registerNaiveSink} />
        )}
      </main>

      <footer className="demo-footer">
        <p>
          {SYMBOL_COUNT} symbols · mock feed, no server · rAF-batched, per-key subscriptions ·{' '}
          <code>npm i tickwork</code>
        </p>
      </footer>
    </div>
  );
}

interface StatProps {
  label: string;
  value: string;
  note?: string;
  tone?: 'good' | 'warn' | 'bad' | 'muted';
}

function Stat({ label, value, note, tone }: StatProps) {
  return (
    <div className={`demo-stat${tone === undefined ? '' : ` is-${tone}`}`}>
      <span className="demo-stat-label">{label}</span>
      <span className="demo-stat-value">{value}</span>
      {note === undefined ? null : <span className="demo-stat-note">{note}</span>}
    </div>
  );
}

const STATUS_COPY: Record<FeedStatus, string> = {
  connecting: 'connecting',
  open: 'live',
  reconnecting: 'reconnecting',
  closed: 'closed',
};

function StatusPill({ status, attempt }: { status: FeedStatus; attempt: number }) {
  return (
    <div className={`demo-status is-${status}`}>
      <span className="demo-status-dot" aria-hidden="true" />
      {STATUS_COPY[status]}
      {status === 'reconnecting' ? ` · attempt ${attempt}` : ''}
    </div>
  );
}
