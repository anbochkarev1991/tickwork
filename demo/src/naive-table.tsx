import { useEffect, useState } from 'react';
import { ensureLiveTableStyles } from 'tickwork';
import { rowRenderCounter } from './instrumentation';
import type { Tick } from './market';

export interface NaiveTableProps {
  /** Hands the App a sink to push every single message into. */
  register: (sink: ((tick: Tick) => void) | null) => void;
}

/**
 * The naive implementation, kept honest.
 *
 * One `useState` holding every row, and a `setState` for every message that
 * arrives. This is what most real dashboards do, and it is not a strawman: the
 * state update is minimal and the object spread is shallow. It falls over
 * anyway, because 2,000 messages/sec means 2,000 renders/sec of 50 rows —
 * 100,000 row renders a second against a 60fps budget.
 */
export function NaiveTable({ register }: NaiveTableProps) {
  const [rows, setRows] = useState<Record<string, Tick>>({});

  useEffect(() => {
    ensureLiveTableStyles();
    register((tick) => {
      setRows((previous) => ({ ...previous, [tick.symbol]: tick }));
    });
    return () => register(null);
  }, [register]);

  const symbols = Object.keys(rows).sort();

  return (
    <div className="tickwork-table-wrap">
      <table className="tickwork-table">
        <thead>
          <tr>
            <th scope="col">Symbol</th>
            <th scope="col">Name</th>
            <th scope="col" className="tickwork-align-right">
              Last
            </th>
            <th scope="col" className="tickwork-align-right">
              Chg
            </th>
            <th scope="col" className="tickwork-align-right">
              Chg %
            </th>
            <th scope="col" className="tickwork-align-right">
              Bid
            </th>
            <th scope="col" className="tickwork-align-right">
              Ask
            </th>
            <th scope="col" className="tickwork-align-right">
              Volume
            </th>
            <th scope="col" className="tickwork-align-right">
              Ticks
            </th>
          </tr>
        </thead>
        <tbody>
          {symbols.map((symbol) => {
            const tick = rows[symbol] as Tick;
            rowRenderCounter.count += 1;
            return (
              <tr key={symbol}>
                <td className="demo-symbol">{tick.symbol}</td>
                <td className="demo-muted">{tick.name}</td>
                <td className="tickwork-align-right">{tick.price.toFixed(2)}</td>
                <td className={`tickwork-align-right ${tick.change >= 0 ? 'demo-up' : 'demo-down'}`}>
                  {formatSigned(tick.change)}
                </td>
                <td className={`tickwork-align-right ${tick.change >= 0 ? 'demo-up' : 'demo-down'}`}>
                  {formatSigned(tick.changePct)}%
                </td>
                <td className="tickwork-align-right demo-muted">{tick.bid.toFixed(2)}</td>
                <td className="tickwork-align-right demo-muted">{tick.ask.toFixed(2)}</td>
                <td className="tickwork-align-right demo-muted">{tick.volume.toLocaleString()}</td>
                <td className="tickwork-align-right demo-muted">{tick.ticks.toLocaleString()}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {symbols.length === 0 ? <div className="tickwork-empty">Waiting for data…</div> : null}
    </div>
  );
}

function formatSigned(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}
