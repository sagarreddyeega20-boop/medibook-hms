import type { ReactNode } from 'react';
import { cx } from '../lib/cx';

export type BadgeTone = 'primary' | 'success' | 'danger' | 'warning' | 'info' | 'neutral';

/**
 * Status → tone map shared by every screen, so a status always has the same colour.
 * Covers appointment, visit, order, invoice, payment and doctor-board statuses.
 */
export const STATUS_TONES: Record<string, BadgeTone> = {
  // appointments / visits
  HELD: 'neutral', BOOKED: 'info', CHECKED_IN: 'primary', IN_CONSULTATION: 'warning',
  OPEN: 'primary', COMPLETED: 'success', CANCELLED: 'danger', NO_SHOW: 'neutral',
  // orders
  ORDERED: 'info', SCHEDULED: 'neutral', IN_PROGRESS: 'warning', RESULT_READY: 'success',
  // money
  DRAFT: 'neutral', ISSUED: 'info', PARTIALLY_PAID: 'warning', PAID: 'success', VOID: 'neutral',
  PENDING: 'warning', CONFIRMED: 'success', FAILED: 'danger',
  // doctor live status
  AVAILABLE: 'success', RUNNING_LATE: 'danger', OFF_DUTY: 'neutral', ON_LEAVE: 'neutral',
};

const pretty = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

interface BadgeProps {
  tone?: BadgeTone;
  /** Pass a status code (e.g. "RESULT_READY") to pick tone and label automatically. */
  status?: string;
  dot?: boolean;
  children?: ReactNode;
  className?: string;
}

export function Badge({ tone, status, dot, children, className }: BadgeProps) {
  const resolved = tone ?? (status ? STATUS_TONES[status] : undefined) ?? 'neutral';
  return (
    <span className={cx('mb-badge', `mb-badge--${resolved}`, className)}>
      {dot && <span className="mb-badge__dot" aria-hidden="true" />}
      {children ?? (status ? pretty(status) : null)}
    </span>
  );
}
