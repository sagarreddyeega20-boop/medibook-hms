import type { ReactNode } from 'react';
import { cx } from '../lib/cx';
import { initials } from '../lib/format';
import { Badge, STATUS_TONES } from './Badge';

/* ---------- Slot grid (reception live board, admin schedule preview) ---------- */

export type SlotGridState = 'FREE' | 'HELD' | 'BOOKED' | 'CHECKED_IN' | 'DONE' | 'CANCELLED';

export const SLOT_STATE_LABELS: Record<SlotGridState, string> = {
  FREE: 'Free', HELD: 'Held', BOOKED: 'Booked', CHECKED_IN: 'Checked in', DONE: 'Done', CANCELLED: 'Cancelled',
};

/** Colour of a slot state = the Badge tone of that status (STATUS_TONES), so it matches everywhere. */
const toneOf = (state: SlotGridState) => STATUS_TONES[state === 'DONE' ? 'COMPLETED' : state] ?? 'neutral';

export interface SlotCell {
  id: string;
  time: string;           // "10:30 AM"
  state: SlotGridState;
  sub?: ReactNode;        // "T4 · Priya S." / "Held by you"
  past?: boolean;
  selected?: boolean;
  title?: string;         // tooltip / accessible description
}

/** A day of slots as small tiles coloured by state. Clicking a tile selects it. */
export function SlotGrid({ slots, onPick, label, empty }: { slots: SlotCell[]; onPick?: (id: string) => void; label: string; empty?: ReactNode }) {
  if (!slots.length) return <p className="mb-slotgrid__empty muted">{empty ?? 'No slots on this day.'}</p>;
  return (
    <div className="mb-slotgrid" role="group" aria-label={label}>
      {slots.map((s) => (
        <button
          key={s.id}
          type="button"
          className={cx('mb-slot', `mb-slot--${toneOf(s.state)}`, s.past && 'is-past')}
          aria-pressed={s.selected}
          title={s.title ?? `${s.time} · ${SLOT_STATE_LABELS[s.state]}`}
          aria-label={`${s.time}, ${SLOT_STATE_LABELS[s.state]}${s.title ? `, ${s.title}` : ''}`}
          disabled={!onPick}
          onClick={() => onPick?.(s.id)}
        >
          <strong>{s.time}</strong>
          <span>{s.sub ?? SLOT_STATE_LABELS[s.state]}</span>
        </button>
      ))}
    </div>
  );
}

export function SlotLegend({ states = ['FREE', 'HELD', 'BOOKED', 'CHECKED_IN', 'DONE', 'CANCELLED'] }: { states?: SlotGridState[] }) {
  return (
    <p className="mb-slotlegend">
      {states.map((s) => (
        <span key={s}><span className={cx('mb-slotlegend__swatch', `mb-slot--${toneOf(s)}`)} aria-hidden="true" />{SLOT_STATE_LABELS[s]}</span>
      ))}
    </p>
  );
}

/* ---------- Doctor card on the live board ---------- */

interface DoctorBoardCardProps {
  name: string;
  meta: ReactNode;             // "Cardiology · Interventional cardiology"
  status: string;              // calculated status code → Badge
  statusNote?: ReactNode;      // "22 min behind" / "Conference"
  token?: ReactNode;           // current patient token, e.g. "T4"
  current?: ReactNode;         // current patient name
  queueCount: number;
  nextFree?: ReactNode;        // "Today · 11:45 AM"
  selected?: boolean;
  onSelect?: () => void;
}

/** One doctor on the reception board: status badge, now-seeing token, queue count, next free slot. */
export function DoctorBoardCard({ name, meta, status, statusNote, token, current, queueCount, nextFree, selected, onSelect }: DoctorBoardCardProps) {
  return (
    <button type="button" className="mb-docboard" aria-pressed={selected} onClick={onSelect}>
      <span className="mb-docboard__head">
        <span className="mb-initials" aria-hidden="true">{initials(name)}</span>
        <span className="mb-docboard__who">
          <strong>{name}</strong>
          <span>{meta}</span>
        </span>
        <Badge status={status} dot size="sm" />
      </span>
      {statusNote && <span className="mb-docboard__note">{statusNote}</span>}
      <span className="mb-docboard__facts">
        <span><small>Now seeing</small><strong>{token ?? '—'}</strong>{current && <em>{current}</em>}</span>
        <span><small>In queue</small><strong>{queueCount}</strong></span>
        <span><small>Next free</small><strong className="mb-docboard__next">{nextFree ?? 'None in 14 days'}</strong></span>
      </span>
    </button>
  );
}
