import type { ReactNode } from 'react';
import { cx } from '../lib/cx';
import { EmptyState } from './EmptyState';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  numeric?: boolean;
  width?: string;
}

interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Highlights a row with the v1 teal tint, e.g. the patient being seen now. */
  isCurrent?: (row: T) => boolean;
  empty?: ReactNode;
  caption?: string;
}

/** v1 schedule table: grey header strip, roomy rows, no outer border (sits flush inside a Card). */
export function Table<T>({ columns, rows, rowKey, onRowClick, isCurrent, empty, caption }: TableProps<T>) {
  if (rows.length === 0) {
    return <>{empty ?? <EmptyState title="Nothing here yet" text="Records will appear here once they are created." />}</>;
  }
  return (
    <div className="mb-table-wrap">
      <table className={cx('mb-table', onRowClick && 'mb-table--clickable')}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cx(c.numeric && 'mb-num')} style={c.width ? { width: c.width } : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className={cx(isCurrent?.(row) && 'is-current')}
              aria-current={isCurrent?.(row) || undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={onRowClick ? (e) => e.key === 'Enter' && onRowClick(row) : undefined}
            >
              {columns.map((c) => (
                <td key={c.key} className={cx(c.numeric && 'mb-num')}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Two-line cell used in v1 tables: bold name over a muted ID line. */
export function PersonCell({ name, sub }: { name: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-person">
      <strong>{name}</strong>
      {sub && <span>{sub}</span>}
    </div>
  );
}
