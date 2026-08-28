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
}

/**
 * Mutable market state, shared across sockets so a reconnect resumes the same
 * market rather than starting a new one.
 */
export function createMarket(): {
  symbols: readonly string[];
  nextTick: () => Tick;
  snapshot: () => Tick[];
} {
  const states: SymbolState[] = SEEDS.map((seed) => ({
    ...seed,
    open: seed.price,
    current: seed.price,
    volume: Math.round(2_000_000 + Math.random() * 40_000_000),
    ticks: 0,
  }));

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
      ticks: state.ticks,
      ts: Date.now(),
    };
  };

  const nextTick = (): Tick => {
    // Round-robin with a random jump, so updates are spread across symbols but
    // some get hotter than others (like a real tape).
    cursor = (cursor + 1 + (Math.random() < 0.25 ? Math.floor(Math.random() * 7) : 0)) % states.length;
    const state = states[cursor] as SymbolState;

    // Gaussian-ish step via the sum of two uniforms.
    const shock = (Math.random() + Math.random() - 1) * state.vol * 0.35;
    const next = Math.max(0.5, state.current * (1 + shock));

    state.current = round2(next);
    state.volume += Math.round(Math.random() * 900);
    state.ticks += 1;

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
