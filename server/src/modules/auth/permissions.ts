import type { RoleCode } from '@prisma/client';

/**
 * Role → permission strings, from the role table in docs/mvp-structure.md ("Two layers of access").
 * This file is the single source: prisma/seed.ts writes it into roles / permissions / role_permissions,
 * and routes guard with requirePermission('<resource>:<action>').
 */
export const PERMISSIONS = {
  // Admin console
  'staff:read': 'View staff, roles and departments',
  'staff:create': 'Create staff accounts (non-admin roles)',
  'staff:create_admin': 'Create Admin accounts and change Admin roles (Super Admin only)',
  'staff:update': 'Change a staff member’s role or department, resend invites',
  'staff:deactivate': 'Deactivate staff accounts',
  'departments:manage': 'Manage departments',
  'schedules:manage': 'Manage doctor schedules and leaves',
  'fees:manage': 'Manage fees and the service catalogue',
  'audit:read': 'Read the audit log',
  'integrations:manage': 'Manage integrations',
  'backups:manage': 'Manage backups',
  // Reception
  'reception:read': 'Live board of all doctors’ slots and status',
  'appointments:book': 'Book, cancel and reschedule appointments',
  'appointments:checkin': 'Check patients in, register walk-ins, issue tokens',
  'patients:register': 'Register patients at reception',
  'patients:read_contact': 'Read patient contact details',
  'payments:collect': 'Record counter payments',
  // Doctor
  'schedule:own': 'Own schedule',
  'clinical:read': 'Read the timeline of treated patients',
  'clinical:write': 'Write clinical notes',
  'prescriptions:write': 'Write prescriptions',
  'orders:create': 'Order tests and scans',
  'referrals:create': 'Refer patients to other doctors',
  // Lab / radiology
  'orders:lab': 'Lab order queue',
  'orders:radiology': 'Radiology order queue',
  'results:upload': 'Upload results to the patient timeline',
  // Pharmacy
  'prescriptions:read': 'Read prescriptions to dispense',
  'pharmacy:dispense': 'Dispense medicines',
  'pharmacy:stock': 'Manage pharmacy stock',
  // Accounts
  'accounts:read': 'Revenue and counts by department',
  'transactions:read': 'Transactions by date',
  'refunds:manage': 'Approve and record refunds',
  // Patient (own data only)
  'self:read': 'Own visits, reports and bills',
  'self:book': 'Book own appointments',
  'family:manage': 'Manage family members',
} as const;

export type Permission = keyof typeof PERMISSIONS;

const ADMIN: Permission[] = [
  'staff:read', 'staff:create', 'staff:update', 'staff:deactivate',
  'departments:manage', 'schedules:manage', 'fees:manage', 'audit:read',
];

export const ROLE_PERMISSIONS: Record<RoleCode, Permission[]> = {
  SUPER_ADMIN: [...ADMIN, 'staff:create_admin', 'integrations:manage', 'backups:manage'],
  ADMIN,
  RECEPTIONIST: ['reception:read', 'appointments:book', 'appointments:checkin', 'patients:register', 'patients:read_contact', 'payments:collect'],
  DOCTOR: ['schedule:own', 'clinical:read', 'clinical:write', 'prescriptions:write', 'orders:create', 'referrals:create', 'patients:read_contact'],
  LAB_TECH: ['orders:lab', 'results:upload'],
  RADIOLOGY_TECH: ['orders:radiology', 'results:upload'],
  PHARMACIST: ['prescriptions:read', 'pharmacy:dispense', 'pharmacy:stock'],
  ACCOUNTS: ['accounts:read', 'transactions:read', 'refunds:manage'],
  PATIENT: ['self:read', 'self:book', 'family:manage'],
};

export const STAFF_ROLES = ['SUPER_ADMIN', 'ADMIN', 'RECEPTIONIST', 'DOCTOR', 'LAB_TECH', 'RADIOLOGY_TECH', 'PHARMACIST', 'ACCOUNTS'] as const satisfies readonly RoleCode[];
export type StaffRole = (typeof STAFF_ROLES)[number];

/** Role code used inside staff IDs: HMS-<CODE>-NNNN, e.g. HMS-DOC-0007. */
export const STAFF_ID_CODES: Record<StaffRole, string> = {
  SUPER_ADMIN: 'SUP',
  ADMIN: 'ADM',
  RECEPTIONIST: 'REC',
  DOCTOR: 'DOC',
  LAB_TECH: 'LAB',
  RADIOLOGY_TECH: 'RAD',
  PHARMACIST: 'PHA',
  ACCOUNTS: 'ACC',
};

/** Roles that only a Super Admin may grant, change or deactivate. */
export const PRIVILEGED_ROLES: readonly RoleCode[] = ['SUPER_ADMIN', 'ADMIN'];
