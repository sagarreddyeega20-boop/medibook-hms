import { useId, type ReactNode } from 'react';
import { cx } from '../lib/cx';
import { formatPaise, initials } from '../lib/format';
import { Icon, type IconName } from './Icon';

/* ---------- Key/value rows (order summary, confirmation, receipts) ---------- */

export function SummaryRows({ rows, variant }: { rows: { label: string; value: ReactNode }[]; variant?: 'bill' }) {
  return (
    <dl className={cx('mb-rows', variant === 'bill' && 'mb-rows--bill')}>
      {rows.map((r) => (
        <div key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></div>
      ))}
    </dl>
  );
}

/* ---------- Order summary card ---------- */

interface OrderSummaryProps {
  title?: string;
  /** Slot-hold countdown, e.g. "09:59". `low` turns it red. */
  hold?: { label: string; remaining: string; low?: boolean };
  doctor?: { name: string; speciality: string };
  details: { label: string; value: ReactNode }[];
  /** Amounts in integer paise. */
  bill: { label: string; paise: number }[];
  totalPaise: number;
}

/** v1 payment page left card: hold timer, doctor, booking rows, dashed bill, bold total. */
export function OrderSummary({ title = 'Order summary', hold, doctor, details, bill, totalPaise }: OrderSummaryProps) {
  return (
    <section className="mb-card mb-summary" aria-label={title}>
      <h2 className="mb-card__title">{title}</h2>
      {hold && (
        <p className={cx('mb-hold', hold.low && 'is-low')} role="timer">
          <Icon name="timer" size={16} />
          {hold.label}
          <strong>{hold.remaining}</strong>
        </p>
      )}
      {doctor && (
        <div className="mb-summary__doc">
          <span className="mb-initials mb-initials--lg" aria-hidden="true">{initials(doctor.name)}</span>
          <div>
            <p className="mb-summary__doc-name">{doctor.name}</p>
            <p className="muted">{doctor.speciality}</p>
          </div>
        </div>
      )}
      <SummaryRows rows={details} />
      <dl className="mb-rows mb-rows--bill">
        {bill.map((b) => (
          <div key={b.label}><dt>{b.label}</dt><dd>{formatPaise(b.paise)}</dd></div>
        ))}
        <div className="mb-rows__total"><dt>Total</dt><dd>{formatPaise(totalPaise)}</dd></div>
      </dl>
    </section>
  );
}

/* ---------- Payment method cards ---------- */

interface PaymentMethodCardProps {
  name: string;          // radio group name
  value: string;
  checked: boolean;
  onSelect: (value: string) => void;
  icon: IconName;
  title: string;
  subtitle?: string;
  badge?: ReactNode;     // "Recommended"
  children?: ReactNode;  // expanded body when selected
}

/** v1 radio card: icon tile, title + subtitle, optional badge; expands with a teal outline when selected. */
export function PaymentMethodCard({ name, value, checked, onSelect, icon, title, subtitle, badge, children }: PaymentMethodCardProps) {
  const id = useId();
  return (
    <div className={cx('mb-pm', checked && 'is-open')}>
      <label className="mb-pm__head" htmlFor={id}>
        <input id={id} type="radio" name={name} value={value} checked={checked} onChange={() => onSelect(value)} />
        <span className="mb-pm__icon" aria-hidden="true"><Icon name={icon} size={18} /></span>
        <span className="mb-pm__text">
          <strong>{title}</strong>
          {subtitle && <small>{subtitle}</small>}
        </span>
        {badge}
      </label>
      {checked && children && <div className="mb-pm__body">{children}</div>}
    </div>
  );
}

/** Selectable tiles (UPI apps, banks, wallets). */
export function OptionTiles({ options, value, onChange, label }: { options: { value: string; label: string; mark: string }[]; value?: string; onChange: (v: string) => void; label: string }) {
  return (
    <div className="mb-tiles" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className="mb-tile" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          <span className="mb-tile__mark" aria-hidden="true">{o.mark}</span>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** "— OR —" divider used between payment options. */
export function OrDivider({ children = 'or' }: { children?: ReactNode }) {
  return <p className="mb-or">{children}</p>;
}

/* ---------- Result screen (v1: processing / payment successful / payment failed / slot expired) ---------- */

interface ResultCardProps {
  tone: 'processing' | 'success' | 'fail';
  title: string;
  /** Muted lines under the title. */
  children?: ReactNode;
  rows?: { label: string; value: ReactNode }[];
  actions?: ReactNode;
}

/** v1 full-width result card: round icon, title, muted text, receipt rows, actions. */
export function ResultCard({ tone, title, children, rows, actions }: ResultCardProps) {
  return (
    <section className={cx('mb-card mb-result', `mb-result--${tone}`)} aria-live={tone === 'processing' ? 'assertive' : 'polite'} tabIndex={-1}>
      <span className="mb-result__icon" aria-hidden="true">
        {tone === 'processing' ? <span className="mb-spinner mb-result__spinner" /> : <Icon name={tone === 'success' ? 'check' : 'close'} size={28} strokeWidth={3} />}
      </span>
      <h2 className="mb-result__title">{title}</h2>
      {children && <div className="mb-result__text">{children}</div>}
      {rows && rows.length > 0 && <SummaryRows rows={rows} />}
      {actions && <div className="mb-result__actions">{actions}</div>}
    </section>
  );
}

/** Trust line under the pay button. */
export function TrustNote({ children }: { children: ReactNode }) {
  return <p className="mb-trust"><Icon name="lock" size={14} />{children}</p>;
}
