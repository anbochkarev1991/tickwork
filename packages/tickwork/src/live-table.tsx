import {
  memo,
  useEffect,
  useInsertionEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useRealtimeKeys, useRealtimeValue } from './hooks';
import { ensureLiveTableStyles } from './styles';
import type { RealtimeStore } from './types';

export interface LiveTableColumn<T> {
  /** Stable identity for this column. Used as the React key. */
  id: string;
  /** Header content. Defaults to `id`. */
  header?: ReactNode;
  /** Render this column's cell for a row. */
  cell: (item: T, key: string) => ReactNode;
  align?: 'left' | 'right' | 'center';
  width?: number | string;
  className?: string;
  /**
   * Return a comparable number to flash the cell green when it rises and red
   * when it falls. Implemented by toggling a class on the DOM node directly —
   * no extra state, so no extra renders.
   */
  flash?: (item: T) => number | null | undefined;
}

export interface LiveTableProps<T> {
  store: RealtimeStore<T>;
  /**
   * Column definitions. Keep this array reference-stable (module scope or
   * `useMemo`) — rows are memoized on it, so a fresh array every render undoes
   * the fine-grained rendering.
   */
  columns: readonly LiveTableColumn<T>[];
  /**
   * Rows to render, in order. Defaults to the store's key list (insertion
   * order). Pass your own to sort or filter — sorting is your call, not the
   * table's.
   */
  keys?: readonly string[];
  className?: string;
  style?: CSSProperties;
  maxHeight?: number | string;
  emptyMessage?: ReactNode;
  caption?: ReactNode;
  rowClassName?: (item: T, key: string) => string | undefined;
  onRowClick?: (item: T, key: string) => void;
  /** How long a flash lasts. `0` disables flashing. Default 400ms. */
  flashDurationMs?: number;
  /** Inject the bundled stylesheet. Set `false` to bring your own CSS. */
  injectStyles?: boolean;
  'aria-label'?: string;
}

const DEFAULT_FLASH_MS = 400;
const FLASH_UP = 'tickwork-flash-up';
const FLASH_DOWN = 'tickwork-flash-down';

function alignClassName(align: LiveTableColumn<unknown>['align']): string {
  if (align === 'right') return ' tickwork-align-right';
  if (align === 'center') return ' tickwork-align-center';
  return '';
}

interface LiveTableCellProps<T> {
  column: LiveTableColumn<T>;
  item: T;
  rowKey: string;
  flashDurationMs: number;
}

function LiveTableCellInner<T>({
  column,
  item,
  rowKey,
  flashDurationMs,
}: LiveTableCellProps<T>): ReactNode {
  const flashValue = column.flash?.(item) ?? null;
  const nodeRef = useRef<HTMLTableCellElement | null>(null);
  const previousRef = useRef<number | null>(flashValue);

  useEffect(() => {
    const node = nodeRef.current;
    const previous = previousRef.current;
    previousRef.current = flashValue;

    if (node === null || flashDurationMs <= 0) return undefined;
    if (previous === null || flashValue === null || flashValue === previous) return undefined;

    const className = flashValue > previous ? FLASH_UP : FLASH_DOWN;
    node.classList.remove(FLASH_UP, FLASH_DOWN);
    // Reading layout restarts the CSS transition for back-to-back ticks.
    void node.offsetWidth;
    node.classList.add(className);

    const handle = setTimeout(() => node.classList.remove(className), flashDurationMs);
    return () => clearTimeout(handle);
  }, [flashValue, flashDurationMs]);

  return (
    <td
      ref={nodeRef}
      className={`tickwork-cell${alignClassName(column.align)}${
        column.className === undefined ? '' : ` ${column.className}`
      }`}
    >
      {column.cell(item, rowKey)}
    </td>
  );
}

const LiveTableCell = memo(LiveTableCellInner) as typeof LiveTableCellInner;

interface LiveTableRowProps<T> {
  store: RealtimeStore<T>;
  rowKey: string;
  columns: readonly LiveTableColumn<T>[];
  flashDurationMs: number;
  rowClassName?: (item: T, key: string) => string | undefined;
  onRowClick?: (item: T, key: string) => void;
}

/**
 * One row, subscribed to one key.
 *
 * This is where the performance story lands: the row reads its own value out of
 * the store, so a tick only ever re-renders the row it belongs to. The parent
 * table is not involved.
 */
function LiveTableRowInner<T>({
  store,
  rowKey,
  columns,
  flashDurationMs,
  rowClassName,
  onRowClick,
}: LiveTableRowProps<T>): ReactNode {
  const item = useRealtimeValue(store, rowKey);
  if (item === undefined) return null;

  const custom = rowClassName?.(item, rowKey);
  const className = `tickwork-row${onRowClick === undefined ? '' : ' tickwork-row-clickable'}${
    custom === undefined ? '' : ` ${custom}`
  }`;

  return (
    <tr
      className={className}
      onClick={onRowClick === undefined ? undefined : () => onRowClick(item, rowKey)}
      data-tickwork-key={rowKey}
    >
      {columns.map((column) => (
        <LiveTableCell
          key={column.id}
          column={column}
          item={item}
          rowKey={rowKey}
          flashDurationMs={flashDurationMs}
        />
      ))}
    </tr>
  );
}

/**
 * Memoized so a key-set change (a row added or removed) re-renders the table
 * shell without re-rendering every existing row.
 */
export const LiveTableRow = memo(LiveTableRowInner) as typeof LiveTableRowInner;

/**
 * A small, styled table over a {@link RealtimeStore}.
 *
 * It is intentionally thin — this is the demo-and-screenshots layer, not a data
 * grid. Sorting, filtering, paging and virtualization stay outside: pass the
 * `keys` you want, in the order you want. Everything here is built from the
 * public hooks, so replacing it with your own markup is a 20-line exercise.
 */
export function LiveTable<T>({
  store,
  columns,
  keys,
  className,
  style,
  maxHeight,
  emptyMessage = 'Waiting for data…',
  caption,
  rowClassName,
  onRowClick,
  flashDurationMs = DEFAULT_FLASH_MS,
  injectStyles = true,
  'aria-label': ariaLabel,
}: LiveTableProps<T>): ReactNode {
  useInsertionEffect(() => {
    if (injectStyles) ensureLiveTableStyles();
  }, [injectStyles]);

  // Always subscribed: cheap, and it keeps hook order stable when `keys`
  // appears or disappears between renders.
  const storeKeys = useRealtimeKeys(store);
  const rowKeys = keys ?? storeKeys;

  const wrapClassName = `tickwork-table-wrap${className === undefined ? '' : ` ${className}`}`;
  const wrapStyle: CSSProperties = maxHeight === undefined ? { ...style } : { maxHeight, ...style };

  return (
    <div className={wrapClassName} style={wrapStyle}>
      <table className="tickwork-table" aria-label={ariaLabel}>
        {caption === undefined ? null : <caption>{caption}</caption>}
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                className={`tickwork-header${alignClassName(column.align)}`}
                style={column.width === undefined ? undefined : { width: column.width }}
              >
                {column.header ?? column.id}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowKeys.map((rowKey) => (
            <LiveTableRow
              key={rowKey}
              store={store}
              rowKey={rowKey}
              columns={columns}
              flashDurationMs={flashDurationMs}
              rowClassName={rowClassName}
              onRowClick={onRowClick}
            />
          ))}
        </tbody>
      </table>
      {rowKeys.length === 0 ? <div className="tickwork-empty">{emptyMessage}</div> : null}
    </div>
  );
}
