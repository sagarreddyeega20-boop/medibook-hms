import type { ReactNode } from 'react';
import { cx } from '../lib/cx';

export type BadgeTone = 'primary' | 'success' | 'danger' | 'warning' | 'pending' | 'info' | 'neutral';

/**
 * Status → tone map shared by every screen, so a status always has the same colour.
 * Follows MediBook v1: Completed/Confirmed green, Checked in blue, Booked grey,
 * Cancelled/Awaiting orange, Awaiting payment yellow.
 */
export const STATUS_TONES: Record<string, BadgeTone> = {
  // appointments / visits
  HELD: 'pending', BOOKED: 'neutral', CONFIRMED: 'success', CHECKED_IN: 'info', IN_CONSULTATION: 'primary',
  OPEN: 'primary', COMPLETED: 'success', CANCELLED: 'warning', NO_SHOW: 'danger', AWAITING: 'warning',
  // orders
  ORDERED: 'info', SCHEDULED: 'neutral', IN_PROGRESS: 'warning', RESULT_READY: 'success',
  // money
  DRAFT: 'neutral', ISSUED: 'info', PARTIALLY_PAID: 'pending', PAID: 'success', VOID: 'neutral',
  PENDING: 'pending', FAILED: 'danger', REFUNDED: 'neutral', PAY_AT_CLINIC: 'neutral',
  // doctor live status
  AVAILABLE: 'success', RUNNING_LATE: 'danger', OFF_DUTY: 'neutral', ON_LEAVE: 'neutral',
  // staff accounts
  ACTIVE: 'success', INVITED: 'pending', LOCKED: 'danger', DEACTIVATED: 'neutral',
  // audit events
  LOGIN_SUCCESS: 'success', LOGIN_FAILED: 'warning', ACCOUNT_LOCKED: 'danger', OTP_FAILED: 'warning', OTP_LOCKED: 'danger',
  LOGOUT: 'neutral', PASSWORD_SET: 'info', STAFF_CREATED: 'primary', STAFF_INVITE_SENT: 'info', ROLE_CHANGED: 'pending',
  STAFF_DEACTIVATED: 'neutral', PATIENT_REGISTERED: 'primary', ACCESS_DENIED: 'danger',
};

/** Labels that differ from the plain "Title case" of the status code. */
export const STATUS_LABELS: Record<string, string> = {
  HELD: 'Awaiting payment',
  AWAITING: 'Awaiting doctor',
  PAY_AT_CLINIC: 'Pay at clinic',
  INVITED: 'Invite sent',
  OTP_FAILED: 'OTP failed',
  OTP_LOCKED: 'OTP locked',
};

export const statusLabel = (s: string) =>
  STATUS_LABELS[s] ?? s.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

interface BadgeProps {
  tone?: BadgeTone;
  /** Pass a status code (e.g. "RESULT_READY") to pick tone and label automatically. */
  status?: string;
  dot?: boolean;
  size?: 'md' | 'sm';
  children?: ReactNode;
  className?: string;
}

export function Badge({ tone, status, dot, size = 'md', children, className }: BadgeProps) {
  const resolved = tone ?? (status ? STATUS_TONES[status] : undefined) ?? 'neutral';
  return (
    <span className={cx('mb-badge', `mb-badge--${resolved}`, size === 'sm' && 'mb-badge--sm', className)}>
      {dot && <span className="mb-badge__dot" aria-hidden="true" />}
      {children ?? (status ? statusLabel(status) : null)}
    </span>
  );
}
