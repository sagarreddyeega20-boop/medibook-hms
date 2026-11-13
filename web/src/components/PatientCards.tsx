import type { ReactNode } from 'react';
import { cx } from '../lib/cx';
import { initials } from '../lib/format';
import { Badge } from './Badge';

/* ---------- Dark hero banner (v1 My appointments) ---------- */

interface HeroBannerProps {
  name: string;
  /** e.g. <>Patient ID <strong>MB-24-00731</strong> · Male, 22</> */
  meta?: ReactNode;
  stats?: { label: string; value: ReactNode }[];
}

export function HeroBanner({ name, meta, stats }: HeroBannerProps) {
  return (
    <section className="mb-hero-banner" aria-label={name}>
      <span className="mb-hero-banner__avatar" aria-hidden="true">{initials(name)}</span>
      <div>
        <h1 className="mb-hero-banner__name">{name}</h1>
        {meta && <p className="mb-hero-banner__meta">{meta}</p>}
      </div>
      {stats && (
        <dl className="mb-hero-banner__stats">
          {stats.map((s) => (
            <div key={s.label}>
              <dt>{s.label}</dt>
              <dd>{s.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/* ---------- Appointment card with date tile ---------- */

/** v1 date tile: "NOV / 14" in a teal-tinted square. */
export function DateTile({ date }: { date: Date }) {
  return (
    <span className="mb-datetile">
      <small>{date.toLocaleString('en-IN', { month: 'short' })}</small>
      <strong>{date.getDate()}</strong>
    </span>
  );
}

interface AppointmentCardProps {
  date: Date;
  title: ReactNode;          // "Dr. Ananya Rao · Dermatology"
  lines?: ReactNode[];       // "Sat · 11:30 AM · Skin Care Clinic", "Ref APT-1142 · Reason: skin rash"
  status?: string;           // status code → Badge
  payment?: string;          // payment status code → small badge line
  actions?: ReactNode;       // Reschedule / Cancel buttons
}

export function AppointmentCard({ date, title, lines, status, payment, actions }: AppointmentCardProps) {
  return (
    <article className="mb-card mb-appt">
      <DateTile date={date} />
      <div className="mb-appt__info">
        <h3 className="mb-appt__title">{title}</h3>
        {lines?.map((l, i) => <p key={i} className="mb-appt__line">{l}</p>)}
        {payment && (
          <p className="mb-appt__pay">Payment <Badge status={payment} size="sm" /></p>
        )}
      </div>
      {(status || actions) && (
        <div className="mb-appt__actions">
          {status && <Badge status={status} />}
          {actions}
        </div>
      )}
    </article>
  );
}

/* ---------- Side cards ---------- */

export function SideCard({ title, children, tone }: { title: string; children: ReactNode; tone?: 'assist' }) {
  return (
    <section className={cx('mb-card mb-sidecard', tone === 'assist' && 'mb-sidecard--assist')} aria-label={title}>
      <h2 className="mb-sidecard__title">{title}</h2>
      {children}
    </section>
  );
}

/** "Doctors you've consulted" list: name, muted line, action link on the right. */
export function PersonList({ items }: { items: { key: string; name: ReactNode; sub?: ReactNode; action?: ReactNode }[] }) {
  return (
    <ul className="mb-personlist">
      {items.map((it) => (
        <li key={it.key}>
          <div>
            <strong>{it.name}</strong>
            {it.sub && <span>{it.sub}</span>}
          </div>
          {it.action}
        </li>
      ))}
    </ul>
  );
}

/* ---------- Pills (specialities) ---------- */

export function Pill({ children, onClick, selected }: { children: ReactNode; onClick?: () => void; selected?: boolean }) {
  return (
    <button type="button" className="mb-pill" aria-pressed={selected} onClick={onClick}>{children}</button>
  );
}
