import type { ReactNode } from 'react';
import { cx } from '../lib/cx';
import { Badge } from './Badge';
import { EmptyState } from './EmptyState';

export interface TimelineEntry {
  id: string;
  /** Event type code shown as the first badge, e.g. "NOTE", "LAB", "REFERRAL". */
  type: string;
  title: ReactNode;
  /** "Sat, 14 Nov · 11:30 AM · Dr. Arjun Mehta · Cardiology" */
  meta?: ReactNode;
  status?: string;
  priority?: string;
  /** Labelled facts shown as compact key/value rows. */
  lines?: { label: string; value: ReactNode }[];
  /** Teal accent, e.g. the visit being consulted now. */
  current?: boolean;
}

/**
 * Patient timeline: newest-first list of every visit, note, order, result, referral and prescription
 * across departments. A dot + rail on the left, type/status badges, compact key/value rows (v1 card style).
 */
export function Timeline({ items, empty, label = 'Patient timeline' }: { items: TimelineEntry[]; empty?: ReactNode; label?: string }) {
  if (!items.length) return <>{empty ?? <EmptyState title="Nothing on the timeline" text="Visits, notes, orders and results appear here as they happen." />}</>;
  return (
    <ol className="mb-timeline" aria-label={label}>
      {items.map((e) => (
        <li key={e.id} className={cx('mb-timeline__item', e.current && 'is-current')}>
          <span className="mb-timeline__dot" aria-hidden="true" />
          <div className="mb-timeline__body">
            <div className="mb-timeline__head">
              <Badge status={e.type} size="sm" />
              <strong className="mb-timeline__title">{e.title}</strong>
              {e.priority && e.priority !== 'ROUTINE' && <Badge status={e.priority} size="sm" />}
              {e.status && <Badge status={e.status} size="sm" />}
            </div>
            {e.meta && <p className="mb-timeline__meta">{e.meta}</p>}
            {e.lines && e.lines.length > 0 && (
              <dl className="mb-rows mb-rows--compact">
                {e.lines.map((l, i) => (
                  <div key={`${l.label}-${i}`}><dt>{l.label}</dt><dd>{l.value}</dd></div>
                ))}
              </dl>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
