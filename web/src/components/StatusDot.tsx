import { cx } from '../lib/cx';

export type DotTone = 'success' | 'warning' | 'danger';

/** Doctor live status → traffic-light tone (green free now, amber busy, red away). */
export const DOCTOR_DOT_TONES: Record<string, DotTone> = {
  AVAILABLE: 'success',
  IN_CONSULTATION: 'warning',
  RUNNING_LATE: 'warning',
  OFF_DUTY: 'danger',
  ON_LEAVE: 'danger',
};

/** Sort rank for a doctor status: green first, then amber, then red. */
export const doctorStatusRank = (status: string) => ({ success: 0, warning: 1, danger: 2 })[DOCTOR_DOT_TONES[status] ?? 'danger'];

/**
 * A small coloured status dot. Colour is never the only signal: always show a text label next to it
 * (the dot itself is hidden from screen readers unless `label` is given).
 */
export function StatusDot({ tone, status, label, className }: { tone?: DotTone; status?: string; label?: string; className?: string }) {
  const resolved = tone ?? (status ? DOCTOR_DOT_TONES[status] : undefined) ?? 'danger';
  return (
    <span
      className={cx('mb-status-dot', `mb-status-dot--${resolved}`, className)}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    />
  );
}
