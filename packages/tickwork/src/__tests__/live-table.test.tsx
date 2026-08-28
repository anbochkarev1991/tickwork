import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveTable, type LiveTableColumn } from '../live-table';
import { createManualScheduler, type ManualScheduler } from '../scheduler';
import { createRealtimeStore } from '../store';
import type { RealtimeStore } from '../types';

interface Quote {
  symbol: string;
  price: number;
}

const quote = (symbol: string, price: number): Quote => ({ symbol, price });

/** Render counts per symbol, incremented once per row render. */
let rowRenders: Record<string, number>;

const columns: readonly LiveTableColumn<Quote>[] = [
  {
    id: 'symbol',
    header: 'Symbol',
    cell: (item) => {
      // A cell renderer runs exactly once per row render: our render spy.
      rowRenders[item.symbol] = (rowRenders[item.symbol] ?? 0) + 1;
      return item.symbol;
    },
  },
  {
    id: 'price',
    header: 'Last',
    align: 'right',
    flash: (item) => item.price,
    cell: (item) => item.price.toFixed(2),
  },
];

function setup(): { store: RealtimeStore<Quote>; scheduler: ManualScheduler } {
  const scheduler = createManualScheduler();
  const store = createRealtimeStore<Quote>({ getKey: (item) => item.symbol, scheduler });
  return { store, scheduler };
}

function cellsOf(symbol: string): HTMLTableCellElement[] {
  const row = document.querySelector(`[data-tickwork-key="${symbol}"]`);
  if (row === null) throw new Error(`No row for ${symbol}`);
  return Array.from(row.querySelectorAll('td'));
}

beforeEach(() => {
  rowRenders = {};
  document.getElementById('tickwork-live-table-styles')?.remove();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LiveTable — rendering', () => {
  it('renders headers, rows and cells from the store', () => {
    const { store, scheduler } = setup();
    store.ingestMany([quote('AAPL', 228.4), quote('MSFT', 431.2)]);
    scheduler.flush();

    render(<LiveTable store={store} columns={columns} aria-label="Quotes" />);

    expect(screen.getByRole('table', { name: 'Quotes' })).toBeTruthy();
    expect(screen.getByText('Symbol')).toBeTruthy();
    expect(screen.getByText('AAPL')).toBeTruthy();
    expect(screen.getByText('228.40')).toBeTruthy();
    expect(screen.getByText('431.20')).toBeTruthy();
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('shows the empty state until data arrives', () => {
    const { store, scheduler } = setup();
    render(<LiveTable store={store} columns={columns} emptyMessage="No quotes yet" />);

    expect(screen.getByText('No quotes yet')).toBeTruthy();

    act(() => {
      store.ingest(quote('AAPL', 1));
      scheduler.flush();
    });

    expect(screen.queryByText('No quotes yet')).toBeNull();
  });

  it('updates a cell when its row ticks', () => {
    const { store, scheduler } = setup();
    store.ingest(quote('AAPL', 100));
    scheduler.flush();
    render(<LiveTable store={store} columns={columns} />);

    expect(screen.getByText('100.00')).toBeTruthy();

    act(() => {
      store.ingest(quote('AAPL', 101.5));
      scheduler.flush();
    });

    expect(screen.getByText('101.50')).toBeTruthy();
    expect(screen.queryByText('100.00')).toBeNull();
  });

  it('adds and removes rows as the key set changes', () => {
    const { store, scheduler } = setup();
    store.ingest(quote('AAPL', 1));
    scheduler.flush();
    render(<LiveTable store={store} columns={columns} />);

    act(() => {
      store.ingest(quote('MSFT', 2));
      scheduler.flush();
    });
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);

    act(() => {
      store.remove('AAPL');
    });
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(screen.queryByText('AAPL')).toBeNull();
  });

  it('renders the keys it is given, in the order given', () => {
    const { store, scheduler } = setup();
    store.ingestMany([quote('AAPL', 1), quote('MSFT', 2), quote('NVDA', 3)]);
    scheduler.flush();

    render(<LiveTable store={store} columns={columns} keys={['NVDA', 'AAPL']} />);

    const rows = Array.from(document.querySelectorAll('tbody tr'));
    expect(rows.map((row) => row.getAttribute('data-tickwork-key'))).toEqual(['NVDA', 'AAPL']);
  });

  it('applies alignment, width, caption and custom class names', () => {
    const { store, scheduler } = setup();
    store.ingest(quote('AAPL', 1));
    scheduler.flush();

    render(
      <LiveTable
        store={store}
        columns={[
          { ...(columns[0] as LiveTableColumn<Quote>), className: 'sym-cell', width: 120 },
          columns[1] as LiveTableColumn<Quote>,
        ]}
        className="my-table"
        caption="Live quotes"
        maxHeight={300}
        rowClassName={(item) => (item.price > 0 ? 'positive' : undefined)}
      />,
    );

    const wrap = document.querySelector('.tickwork-table-wrap');
    expect(wrap?.classList.contains('my-table')).toBe(true);
    expect((wrap as HTMLElement).style.maxHeight).toBe('300px');
    expect(screen.getByText('Live quotes').tagName).toBe('CAPTION');

    const headers = Array.from(document.querySelectorAll('th'));
    expect((headers[0] as HTMLElement).style.width).toBe('120px');
    expect(headers[1]?.classList.contains('tickwork-align-right')).toBe(true);

    const [symbolCell] = cellsOf('AAPL');
    expect(symbolCell?.classList.contains('sym-cell')).toBe(true);
    expect(document.querySelector('.tickwork-row')?.classList.contains('positive')).toBe(true);
  });

  it('falls back to the column id as its header', () => {
    const { store } = setup();
    render(<LiveTable store={store} columns={[{ id: 'raw', cell: () => null }]} />);
    expect(screen.getByText('raw')).toBeTruthy();
  });

  it('calls onRowClick with the row it belongs to', () => {
    const { store, scheduler } = setup();
    store.ingest(quote('AAPL', 12));
    scheduler.flush();
    const onRowClick = vi.fn();

    render(<LiveTable store={store} columns={columns} onRowClick={onRowClick} />);
    fireEvent.click(screen.getByText('AAPL'));

    expect(onRowClick).toHaveBeenCalledWith(quote('AAPL', 12), 'AAPL');
    expect(document.querySelector('.tickwork-row-clickable')).toBeTruthy();
  });
});

describe('LiveTable — fine-grained updates', () => {
  it('re-renders only the row that changed', () => {
    const { store, scheduler } = setup();
    store.ingestMany([quote('AAPL', 1), quote('MSFT', 1), quote('NVDA', 1)]);
    scheduler.flush();

    render(<LiveTable store={store} columns={columns} />);
    expect(rowRenders).toEqual({ AAPL: 1, MSFT: 1, NVDA: 1 });

    act(() => {
      store.ingest(quote('AAPL', 2));
      scheduler.flush();
    });

    expect(rowRenders).toEqual({ AAPL: 2, MSFT: 1, NVDA: 1 });
  });

  it('collapses a flood of updates into one render per row per frame', () => {
    const { store, scheduler } = setup();
    store.ingestMany([quote('AAPL', 0), quote('MSFT', 0)]);
    scheduler.flush();
    render(<LiveTable store={store} columns={columns} />);

    act(() => {
      // 5,000 messages, two symbols, one frame.
      for (let index = 0; index < 5_000; index += 1) {
        store.ingest(quote(index % 2 === 0 ? 'AAPL' : 'MSFT', index));
      }
      scheduler.flush();
    });

    expect(rowRenders).toEqual({ AAPL: 2, MSFT: 2 });
    expect(screen.getByText('4998.00')).toBeTruthy();
    expect(screen.getByText('4999.00')).toBeTruthy();
  });

  it('does not re-render existing rows when a new row appears', () => {
    const { store, scheduler } = setup();
    store.ingest(quote('AAPL', 1));
    scheduler.flush();
    render(<LiveTable store={store} columns={columns} />);

    act(() => {
      store.ingest(quote('MSFT', 1));
      scheduler.flush();
    });

    expect(rowRenders).toEqual({ AAPL: 1, MSFT: 1 });
  });
});

describe('LiveTable — flashing', () => {
  it('flashes up on a rise and down on a fall, then clears', () => {
    vi.useFakeTimers();
    const { store, scheduler } = setup();
    store.ingest(quote('AAPL', 100));
    scheduler.flush();
    render(<LiveTable store={store} columns={columns} flashDurationMs={400} />);

    const priceCell = () => cellsOf('AAPL')[1] as HTMLTableCellElement;
    expect(priceCell().className).not.toContain('tickwork-flash');

    act(() => {
      store.ingest(quote('AAPL', 101));
      scheduler.flush();
    });
    expect(priceCell().classList.contains('tickwork-flash-up')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(priceCell().className).not.toContain('tickwork-flash');

    act(() => {
      store.ingest(quote('AAPL', 99));
      scheduler.flush();
    });
    expect(priceCell().classList.contains('tickwork-flash-down')).toBe(true);
  });

  it('does not flash when the value is unchanged or flashing is disabled', () => {
    vi.useFakeTimers();
    const { store, scheduler } = setup();
    store.ingest(quote('AAPL', 100));
    scheduler.flush();
    const { unmount } = render(<LiveTable store={store} columns={columns} flashDurationMs={0} />);

    act(() => {
      store.ingest(quote('AAPL', 101));
      scheduler.flush();
    });

    expect((cellsOf('AAPL')[1] as HTMLElement).className).not.toContain('tickwork-flash');
    unmount();
  });
});

describe('LiveTable — styles', () => {
  it('injects the stylesheet exactly once', () => {
    const { store } = setup();
    render(
      <>
        <LiveTable store={store} columns={columns} />
        <LiveTable store={store} columns={columns} />
      </>,
    );

    expect(document.querySelectorAll('#tickwork-live-table-styles')).toHaveLength(1);
  });

  it('skips injection when asked to', () => {
    const { store } = setup();
    render(<LiveTable store={store} columns={columns} injectStyles={false} />);
    expect(document.getElementById('tickwork-live-table-styles')).toBeNull();
  });
});
