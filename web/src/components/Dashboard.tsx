import type { ReactNode } from 'react';
import { cx } from '../lib/cx';
import { initials } from '../lib/format';
import { Badge } from './Badge';

/* ---------- Stat cards (v1 doctor dashboard) ---------- */

export type StatTone = 'default' | 'teal' | 'blue' | 'danger';

export function StatCard({ label, value, tone = 'default' }: { label: string; value: ReactNode; tone?: StatTone }) {
  return (
    <div className={cx('mb-stat', `mb-stat--${tone}`)}>
      <span className="mb-stat__label">{label}</span>
      <strong className="mb-stat__value">{value}</strong>
    </div>
  );
}

/** Row of 4 stat cards (2 per row on tablets). */
export function StatGrid({ children, label = 'Summary' }: { children: ReactNode; label?: string }) {
  return <section className="mb-stats" aria-label={label}>{children}</section>;
}

/* ---------- Now consulting side card ---------- */

interface NowConsultingProps {
  patient?: { name: string; meta: ReactNode; status?: string };
  /** Small grey fact pills, e.g. "10:30 AM · APT-1189", "7 past visits". */
  facts?: ReactNode[];
  /** Chatbot / triage intake shown in the teal box. */
  intake?: ReactNode;
  intakeLabel?: string;
  /** Notes form, buttons etc. */
  children?: ReactNode;
  emptyText?: string;
  title?: string;
}

export function NowConsultingCard({ patient, facts, intake, intakeLabel = 'Chatbot intake', children, emptyText = 'No patient is checked in right now. Use “Start consult” on a row to begin.', title = 'Now consulting' }: NowConsultingProps) {
  return (
    <section className="mb-card mb-consult" aria-label={title}>
      <h2 className="mb-card__title">{title}</h2>
      {!patient ? (
        <p className="muted">{emptyText}</p>
      ) : (
        <>
          <div className="mb-consult__who">
            <span className="mb-avatar mb-avatar--lg" aria-hidden="true">{initials(patient.name)}</span>
            <div>
              <p className="mb-consult__name">{patient.name}</p>
              <p className="mb-consult__meta">{patient.meta}</p>
            </div>
          </div>
          {(facts?.length || patient.status) && (
            <div className="mb-consult__facts">
              {facts?.map((f, i) => <span key={i} className="mb-fact">{f}</span>)}
              {patient.status && <Badge status={patient.status} />}
            </div>
          )}
          {intake && (
            <div className="mb-intake">
              <p className="mb-intake__label">{intakeLabel}</p>
              {intake}
            </div>
          )}
          {children}
        </>
      )}
    </section>
  );
}

/* ---------- Availability day chips ---------- */

export interface DayAvailability {
  day: string; // "Mon"
  open: boolean;
}

interface AvailabilityChipsProps {
  days: DayAvailability[];
  onToggle?: (index: number) => void;
  legend?: ReactNode;
  disabled?: boolean;
}

/** v1 "Availability this week": 7 toggle chips, teal = open, grey = off. */
export function AvailabilityChips({ days, onToggle, legend, disabled }: AvailabilityChipsProps) {
  return (
    <div>
      <div className="mb-avail" role="group" aria-label="Weekly availability">
        {days.map((d, i) => (
          <button
            key={d.day}
            type="button"
            className="mb-daychip"
            aria-pressed={d.open}
            disabled={disabled || !onToggle}
            onClick={() => onToggle?.(i)}
          >
            {d.day}
            <small>{d.open ? 'Open' : 'Off'}</small>
          </button>
        ))}
      </div>
      <p className="mb-avail__legend">
        <span className="mb-dot mb-dot--open" aria-hidden="true" /> Open
        <span className="mb-dot mb-dot--off" aria-hidden="true" /> Off
        {legend && <> · {legend}</>}
      </p>
    </div>
  );
}
