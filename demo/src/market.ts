/**
 * A fake market. No server, no network — just enough realism to make the
 * performance problem real: 50 symbols, a random walk, and as many messages per
 * second as you ask for.
 */

export interface Tick {
  symbol: string;
  name: string;
  price: number;
  open: number;
  change: number;
  changePct: number;
  bid: number;
  ask: number;
  volume: number;
  /**
   * Recent prices for the sparkline, oldest first.
   *
   * Sampled on a timer rather than per tick, for two reasons: a sparkline needs
   * a point every few hundred milliseconds, not 200 a second, and a stable
   * array reference lets the sparkline component memoize away ~99% of its
   * renders. Under coalescing the store keeps only the newest value per key, so
   * anything historical has to be carried on the value itself (or kept in a
   * side buffer) — it cannot be reconstructed from what the store holds.
   */
  trend: readonly number[];
  /** Raw messages this symbol has produced. Compare with renders. */
  ticks: number;
  ts: number;
}

interface SymbolSeed {
  symbol: string;
  name: string;
  price: number;
  /** Daily volatility, as a fraction of price. */
  vol: number;
}

const SEEDS: readonly SymbolSeed[] = [
  { symbol: 'AAPL', name: 'Apple', price: 228.4, vol: 0.014 },
  { symbol: 'MSFT', name: 'Microsoft', price: 431.2, vol: 0.012 },
  { symbol: 'NVDA', name: 'NVIDIA', price: 132.75, vol: 0.031 },
  { symbol: 'AMZN', name: 'Amazon', price: 186.9, vol: 0.017 },
  { symbol: 'GOOGL', name: 'Alphabet', price: 174.55, vol: 0.015 },
  { symbol: 'META', name: 'Meta Platforms', price: 563.1, vol: 0.02 },
  { symbol: 'TSLA', name: 'Tesla', price: 249.3, vol: 0.036 },
  { symbol: 'BRK.B', name: 'Berkshire Hathaway', price: 462.8, vol: 0.008 },
  { symbol: 'JPM', name: 'JPMorgan Chase', price: 214.6, vol: 0.011 },
  { symbol: 'V', name: 'Visa', price: 283.45, vol: 0.009 },
  { symbol: 'MA', name: 'Mastercard', price: 489.2, vol: 0.009 },
  { symbol: 'UNH', name: 'UnitedHealth', price: 586.7, vol: 0.013 },
  { symbol: 'XOM', name: 'Exxon Mobil', price: 117.85, vol: 0.014 },
  { symbol: 'CVX', name: 'Chevron', price: 148.2, vol: 0.013 },
  { symbol: 'LLY', name: 'Eli Lilly', price: 912.4, vol: 0.018 },
  { symbol: 'JNJ', name: 'Johnson & Johnson', price: 162.9, vol: 0.008 },
  { symbol: 'PG', name: 'Procter & Gamble', price: 171.35, vol: 0.007 },
  { symbol: 'HD', name: 'Home Depot', price: 372.6, vol: 0.011 },
  { symbol: 'COST', name: 'Costco', price: 884.15, vol: 0.01 },
  { symbol: 'WMT', name: 'Walmart', price: 76.4, vol: 0.009 },
  { symbol: 'ABBV', name: 'AbbVie', price: 196.75, vol: 0.011 },
  { symbol: 'MRK', name: 'Merck', price: 113.2, vol: 0.011 },
  { symbol: 'PEP', name: 'PepsiCo', price: 172.9, vol: 0.007 },
  { symbol: 'KO', name: 'Coca-Cola', price: 68.15, vol: 0.007 },
  { symbol: 'AVGO', name: 'Broadcom', price: 165.8, vol: 0.028 },
  { symbol: 'AMD', name: 'Advanced Micro Devices', price: 148.35, vol: 0.033 },
  { symbol: 'INTC', name: 'Intel', price: 21.45, vol: 0.03 },
  { symbol: 'CRM', name: 'Salesforce', price: 261.9, vol: 0.019 },
  { symbol: 'ORCL', name: 'Oracle', price: 158.7, vol: 0.016 },
  { symbol: 'ADBE', name: 'Adobe', price: 528.4, vol: 0.019 },
  { symbol: 'NFLX', name: 'Netflix', price: 701.25, vol: 0.022 },
  { symbol: 'DIS', name: 'Walt Disney', price: 91.6, vol: 0.016 },
  { symbol: 'BAC', name: 'Bank of America', price: 40.15, vol: 0.014 },
  { symbol: 'WFC', name: 'Wells Fargo', price: 57.8, vol: 0.015 },
  { symbol: 'GS', name: 'Goldman Sachs', price: 512.3, vol: 0.013 },
  { symbol: 'MS', name: 'Morgan Stanley', price: 104.95, vol: 0.014 },
  { symbol: 'CAT', name: 'Caterpillar', price: 379.4, vol: 0.013 },
  { symbol: 'BA', name: 'Boeing', price: 172.6, vol: 0.024 },
  { symbol: 'GE', name: 'GE Aerospace', price: 178.85, vol: 0.015 },
  { symbol: 'MMM', name: '3M', price: 133.7, vol: 0.012 },
  { symbol: 'NKE', name: 'Nike', price: 80.25, vol: 0.017 },
  { symbol: 'SBUX', name: 'Starbucks', price: 94.6, vol: 0.014 },
  { symbol: 'MCD', name: "McDonald's", price: 291.4, vol: 0.008 },
  { symbol: 'QCOM', name: 'Qualcomm', price: 168.9, vol: 0.023 },
  { symbol: 'TXN', name: 'Texas Instruments', price: 203.15, vol: 0.014 },
  { symbol: 'MU', name: 'Micron', price: 94.3, vol: 0.035 },
  { symbol: 'PLTR', name: 'Palantir', price: 34.75, vol: 0.041 },
  { symbol: 'COIN', name: 'Coinbase', price: 168.4, vol: 0.048 },
  { symbol: 'UBER', name: 'Uber', price: 73.9, vol: 0.021 },
  { symbol: 'SHOP', name: 'Shopify', price: 71.25, vol: 0.029 },
];

export const SYMBOL_COUNT = SEEDS.length;

interface SymbolState extends SymbolSeed {
  open: number;
  current: number;
  volume: number;
  ticks: number;
  /** Rolling window, mutated in place. */
  history: number[];
  /** Frozen copy handed to ticks; a new reference only when a sample lands. */
  trend: readonly number[];
  lastSampleAt: number;
}

/**
 * Per-tick volatility, as a multiple of the symbol's daily vol. Together with
 * PULL this fixes the stationary spread at roughly ±vol around the open.
 */
const NOISE_SCALE = 0.05;
/** Strength of the pull back towards the opening price, per tick. */
const PULL = 0.0002;

/** One sparkline point per this many milliseconds. */
const TREND_SAMPLE_MS = 250;
/** Points retained — 24 × 250ms = six seconds of history. */
const TREND_POINTS = 24;

/**
 * Mutable market state, shared across sockets so a reconnect resumes the same
 * market rather than starting a new one.
 */
export function createMarket(): {
  symbols: readonly string[];
  nextTick: () => Tick;
  snapshot: () => Tick[];
} {
  const states: SymbolState[] = SEEDS.map((seed) => {
    // Seed the window with a backwards random walk so sparklines have shape
    // from the first frame instead of six seconds of flat line.
    const history: number[] = [];
    let walk = seed.price;
    for (let index = 0; index < TREND_POINTS; index += 1) {
      walk *= 1 + (Math.random() - 0.5) * seed.vol * 0.5;
      // Keep the seeded history inside the same band the live walk stays in.
      walk = Math.min(seed.price * (1 + seed.vol), Math.max(seed.price * (1 - seed.vol), walk));
      history.unshift(round2(walk));
    }

    return {
      ...seed,
      open: seed.price,
      current: seed.price,
      volume: Math.round(2_000_000 + Math.random() * 40_000_000),
      ticks: 0,
      history,
      trend: [...history],
      lastSampleAt: Date.now(),
    };
  });

  let cursor = 0;

  const toTick = (state: SymbolState): Tick => {
    const price = state.current;
    const change = price - state.open;
    const spread = Math.max(0.01, price * 0.00012);
    return {
      symbol: state.symbol,
      name: state.name,
      price,
      open: state.open,
      change,
      changePct: (change / state.open) * 100,
      bid: round2(price - spread),
      ask: round2(price + spread),
      volume: state.volume,
      trend: state.trend,
      ticks: state.ticks,
      ts: Date.now(),
    };
  };

  const nextTick = (): Tick => {
    // Round-robin with a random jump, so updates are spread across symbols but
    // some get hotter than others (like a real tape).
    cursor = (cursor + 1 + (Math.random() < 0.25 ? Math.floor(Math.random() * 7) : 0)) % states.length;
    const state = states[cursor] as SymbolState;

    // Mean-reverting walk (Ornstein–Uhlenbeck in discrete form) rather than a
    // pure random walk. A pure walk drifts without bound: after a few minutes
    // at 10k messages/sec every symbol was ±30% from its open, which is not a
    // thing equities do, and it pinned every magnitude bar to full width.
    //
    // The pull term keeps prices oscillating around the open. Note that the
    // *spread* of the result depends only on NOISE_SCALE/PULL, not on how fast
    // ticks arrive — so the market looks the same at 500/sec and 10,000/sec,
    // only the timescale changes. Each tick moves the last couple of digits,
    // leaving the leading digits stable: that is what makes a price readable.
    const deviation = state.current / state.open - 1;
    // Gaussian-ish step via the sum of two uniforms.
    const noise = (Math.random() + Math.random() - 1) * state.vol * NOISE_SCALE;
    const next = Math.max(0.5, state.current * (1 - deviation * PULL + noise));

    state.current = round2(next);
    state.volume += Math.round(Math.random() * 900);
    state.ticks += 1;

    const now = Date.now();
    if (now - state.lastSampleAt >= TREND_SAMPLE_MS) {
      state.lastSampleAt = now;
      state.history.push(state.current);
      if (state.history.length > TREND_POINTS) state.history.shift();
      state.trend = [...state.history];
    }

    return toTick(state);
  };

  return {
    symbols: states.map((state) => state.symbol),
    nextTick,
    snapshot: () => states.map(toTick),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function isTick(value: unknown): value is Tick {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Tick>;
  return typeof candidate.symbol === 'string' && typeof candidate.price === 'number';
}
