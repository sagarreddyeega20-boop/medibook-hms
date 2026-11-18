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
  FREE: 'primary', DONE: 'success', HELD: 'pending', BOOKED: 'neutral', CONFIRMED: 'success', CHECKED_IN: 'info', IN_CONSULTATION: 'primary',
  OPEN: 'primary', COMPLETED: 'success', CANCELLED: 'warning', NO_SHOW: 'danger', AWAITING: 'warning',
  // orders
  ORDERED: 'info', SCHEDULED: 'neutral', IN_PROGRESS: 'warning', RESULT_READY: 'success',
  // money
  DRAFT: 'neutral', ISSUED: 'pending', PARTIALLY_PAID: 'pending', PAID: 'success', VOID: 'neutral',
  PENDING: 'pending', FAILED: 'danger', REFUNDED: 'neutral', PAY_AT_CLINIC: 'neutral',
  // doctor live status
  AVAILABLE: 'success', RUNNING_LATE: 'danger', OFF_DUTY: 'neutral', ON_LEAVE: 'neutral',
  // staff accounts
  ACTIVE: 'success', INVITED: 'pending', LOCKED: 'danger', DEACTIVATED: 'neutral',
  // audit events
  LOGIN_SUCCESS: 'success', LOGIN_FAILED: 'warning', ACCOUNT_LOCKED: 'danger', OTP_FAILED: 'warning', OTP_LOCKED: 'danger',
  LOGOUT: 'neutral', PASSWORD_SET: 'info', STAFF_CREATED: 'primary', STAFF_INVITE_SENT: 'info', ROLE_CHANGED: 'pending',
  STAFF_DEACTIVATED: 'neutral', PATIENT_REGISTERED: 'primary', ACCESS_DENIED: 'danger',
  FAMILY_LINKED: 'info', DEPARTMENT_CREATED: 'primary', DEPARTMENT_UPDATED: 'pending', DOCTOR_PROFILE_UPDATED: 'pending',
  SCHEDULE_UPDATED: 'pending', LEAVE_ADDED: 'warning', LEAVE_REMOVED: 'neutral',
  APPOINTMENT_BOOKED: 'success', APPOINTMENT_CANCELLED: 'warning', APPOINTMENT_RESCHEDULED: 'pending',
  WALK_IN_REGISTERED: 'primary', CONSULT_STARTED: 'primary', CONSULT_ENDED: 'success',
  // clinical audit events
  VIEW: 'info', BREAK_GLASS: 'danger', NOTE_SAVED: 'primary', ALLERGIES_UPDATED: 'pending', ORDER_CREATED: 'primary', ORDER_CANCELLED: 'warning',
  REFERRAL_CREATED: 'primary', REFERRAL_BOOKED: 'success', PRESCRIPTION_CREATED: 'primary', CHARGE_CREATED: 'neutral',
  // timeline event types + order types / priority
  VISIT: 'neutral', NOTE: 'primary', LAB: 'info', RADIOLOGY: 'info', RESULT: 'success', REFERRAL: 'pending', PRESCRIPTION: 'primary', MEDICATION: 'primary',
  ROUTINE: 'neutral', URGENT: 'warning', STAT: 'danger', ABNORMAL: 'danger', DISPENSED: 'success', PARTIALLY_DISPENSED: 'pending',
  TO_BOOK: 'warning',
  // pharmacy stock
  IN_STOCK: 'success', LOW_STOCK: 'warning', OUT_OF_STOCK: 'danger', PURCHASE: 'success', DISPENSE: 'info', ADJUSTMENT: 'neutral', RETURN: 'neutral',
  // department-queue audit events
  ORDER_STARTED: 'warning', RESULT_UPLOADED: 'success', MEDICINE_DISPENSED: 'success', MEDICINE_CREATED: 'primary', MEDICINE_UPDATED: 'pending', STOCK_IN: 'success',
  // billing: refunds, payment methods, billing audit events
  REQUESTED: 'pending', APPROVED: 'success', REJECTED: 'danger', CASH: 'neutral', UPI: 'info', CARD: 'info',
  PAYMENT_RECORDED: 'success', REFUND_REQUESTED: 'pending', REFUND_APPROVED: 'success', REFUND_REJECTED: 'danger',
  CASH_RECONCILED: 'info', CATALOGUE_UPDATED: 'pending', TRANSACTIONS_EXPORTED: 'neutral', BALANCED: 'success', SHORT: 'danger', OVER: 'warning',
  // visit types / booking source
  OPD: 'info', WALK_IN: 'primary', ONLINE: 'info', RECEPTION: 'neutral', INACTIVE: 'neutral',
};

/** Labels that differ from the plain "Title case" of the status code. */
export const STATUS_LABELS: Record<string, string> = {
  HELD: 'Awaiting payment',
  AWAITING: 'Awaiting doctor',
  PAY_AT_CLINIC: 'Pay at clinic',
  INVITED: 'Invite sent',
  OTP_FAILED: 'OTP failed',
  OTP_LOCKED: 'OTP locked',
  OPD: 'Appointment',
  WALK_IN: 'Walk-in',
  ONLINE: 'Booked online',
  RECEPTION: 'Booked at reception',
  VIEW: 'Viewed record',
  BREAK_GLASS: 'Break-glass',
  RESULT_READY: 'Result ready',
  LAB: 'Lab',
  RADIOLOGY: 'Radiology',
  NOTE: 'Note',
  TO_BOOK: 'To book',
  STAT: 'STAT',
  PURCHASE: 'Stock in',
  DISPENSE: 'Dispensed',
  ORDER_STARTED: 'Sample / scan taken',
  ISSUED: 'Unpaid',
  REQUESTED: 'Refund requested',
  UPI: 'UPI',
  BALANCED: 'Cash matches',
  SHORT: 'Cash short',
  OVER: 'Cash over',
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
