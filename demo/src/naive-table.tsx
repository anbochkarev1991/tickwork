import { useEffect, useState } from 'react';
import { ensureLiveTableStyles } from 'tickwork';
import { ChangeCell, Sparkline, SpreadCell } from './cells';
import { rowRenderCounter } from './instrumentation';
import type { Tick } from './market';

export interface NaiveTableProps {
  /** Hands the App a sink to push every single message into. */
  register: (sink: ((tick: Tick) => void) | null) => void;
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const plain = new Intl.NumberFormat('en-US');

/**
 * The naive implementation, kept honest.
 *
 * One `useState` holding every row, and a `setState` for every message that
 * arrives. This is what most real dashboards do, and it is not a strawman: the
 * state update is minimal and the object spread is shallow. Same columns, same
 * cell components, same visual weight as the `tickwork` table — the only
 * difference is where the update lands.
 *
 * Note what is missing: a display-rate control. There is nothing to set. Every
 * message renders, by construction.
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
    <div className="tickwork-table-wrap" style={{ maxHeight: 'min(60vh, 640px)' }}>
      <table className="tickwork-table">
        <thead>
          <tr>
            <th scope="col">Symbol</th>
            <th scope="col" className="tickwork-align-right">
              Last
            </th>
            <th scope="col" className="tickwork-align-right">
              Chg
            </th>
            <th scope="col">Change</th>
            <th scope="col">Trend · 6s</th>
            <th scope="col" className="tickwork-align-right">
              Bid
            </th>
            <th scope="col" className="tickwork-align-right">
              Ask
            </th>
            <th scope="col" className="tickwork-align-right">
              Spread bps
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
                <td className="tickwork-align-right">
                  <strong>{tick.price.toFixed(2)}</strong>
                </td>
                <td className={`tickwork-align-right ${tick.change >= 0 ? 'demo-up' : 'demo-down'}`}>
                  {`${tick.change >= 0 ? '+' : ''}${tick.change.toFixed(2)}`}
                </td>
                <td>
                  <ChangeCell value={tick.changePct} />
                </td>
                <td>
                  <Sparkline points={tick.trend} />
                </td>
                <td className="tickwork-align-right demo-muted">{tick.bid.toFixed(2)}</td>
                <td className="tickwork-align-right demo-muted">{tick.ask.toFixed(2)}</td>
                <td className="tickwork-align-right">
                  <SpreadCell bid={tick.bid} ask={tick.ask} />
                </td>
                <td className="tickwork-align-right demo-muted">{compact.format(tick.volume)}</td>
                <td className="tickwork-align-right demo-muted">{plain.format(tick.ticks)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {symbols.length === 0 ? <div className="tickwork-empty">Waiting for data…</div> : null}
    </div>
  );
}
