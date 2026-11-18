import { Icon, type IconName, type NavSection } from '../components';

export type Role =
  | 'SUPER_ADMIN' | 'ADMIN' | 'RECEPTIONIST' | 'DOCTOR' | 'LAB_TECH'
  | 'RADIOLOGY_TECH' | 'PHARMACIST' | 'ACCOUNTS' | 'PATIENT';

export const ROLE_LABELS: Record<Role, string> = {
  SUPER_ADMIN: 'Super Admin', ADMIN: 'Admin', RECEPTIONIST: 'Receptionist', DOCTOR: 'Doctor', LAB_TECH: 'Lab technician',
  RADIOLOGY_TECH: 'Radiology technician', PHARMACIST: 'Pharmacist', ACCOUNTS: 'Accounts', PATIENT: 'Patient',
};

/** Each role's home screen, its sidebar sub-brand and its own API (placeholder dashboards for now). */
export const ROLE_HOME: Record<Role, { path: string; brandSub: string; title: string; api: string }> = {
  SUPER_ADMIN: { path: '/admin', brandSub: 'Administration', title: 'Admin console', api: '/api/staff/options' },
  ADMIN: { path: '/admin', brandSub: 'Administration', title: 'Admin console', api: '/api/staff/options' },
  RECEPTIONIST: { path: '/reception', brandSub: 'Reception', title: 'Live board', api: '/api/reception/board' },
  DOCTOR: { path: '/doctor', brandSub: 'for Doctors', title: 'My schedule', api: '/api/visits/dashboard' },
  LAB_TECH: { path: '/lab', brandSub: 'Laboratory', title: 'Lab queue', api: '/api/orders/lab/dashboard' },
  RADIOLOGY_TECH: { path: '/radiology', brandSub: 'Radiology', title: 'Radiology queue', api: '/api/orders/radiology/dashboard' },
  PHARMACIST: { path: '/pharmacy', brandSub: 'Pharmacy', title: 'Prescriptions queue', api: '/api/pharmacy/dashboard' },
  ACCOUNTS: { path: '/accounts', brandSub: 'Accounts', title: 'Accounts overview', api: '/api/accounts/dashboard' },
  PATIENT: { path: '/patient', brandSub: '', title: 'My MediBook', api: '/api/patients/me' },
};

export const homeFor = (role: Role) => ROLE_HOME[role].path;

const ic = (name: IconName) => <Icon name={name} size={17} />;

interface MenuItem {
  to: string;
  label: string;
  icon: IconName;
  roles: Role[];
  permission?: string;
  end?: boolean;
}

/** Sidebar items. A user sees an item only if their role is listed and they hold its permission. */
const MENU: MenuItem[] = [
  { to: '/admin', label: 'Dashboard', icon: 'clinic', roles: ['SUPER_ADMIN', 'ADMIN'], end: true },
  { to: '/admin/staff', label: 'Staff & roles', icon: 'lock', roles: ['SUPER_ADMIN', 'ADMIN'], permission: 'staff:read' },
  { to: '/admin/departments', label: 'Departments', icon: 'clinic', roles: ['SUPER_ADMIN', 'ADMIN'], permission: 'departments:manage' },
  { to: '/admin/doctors', label: 'Doctors & schedules', icon: 'calendar', roles: ['SUPER_ADMIN', 'ADMIN'], permission: 'schedules:manage' },
  { to: '/admin/prices', label: 'Prices & tax', icon: 'wallet', roles: ['SUPER_ADMIN', 'ADMIN'], permission: 'fees:manage' },
  { to: '/admin/audit', label: 'Audit log', icon: 'search', roles: ['SUPER_ADMIN', 'ADMIN'], permission: 'audit:read' },
  { to: '/reception', label: 'Live board', icon: 'calendar', roles: ['RECEPTIONIST'], permission: 'reception:read', end: true },
  { to: '/reception/patients', label: 'Patients', icon: 'search', roles: ['RECEPTIONIST'], permission: 'patients:register' },
  { to: '/doctor', label: 'Today’s schedule', icon: 'calendar', roles: ['DOCTOR'], permission: 'schedule:own', end: true },
  { to: '/lab', label: 'Lab queue', icon: 'bolt', roles: ['LAB_TECH'], permission: 'orders:lab' },
  { to: '/radiology', label: 'Radiology queue', icon: 'bolt', roles: ['RADIOLOGY_TECH'], permission: 'orders:radiology' },
  { to: '/pharmacy', label: 'Prescriptions', icon: 'wallet', roles: ['PHARMACIST'], permission: 'pharmacy:dispense', end: true },
  { to: '/pharmacy/stock', label: 'Stock', icon: 'clinic', roles: ['PHARMACIST'], permission: 'pharmacy:stock' },
  { to: '/accounts', label: 'Overview', icon: 'bank', roles: ['ACCOUNTS'], permission: 'accounts:read' },
  { to: '/billing', label: 'Billing counter', icon: 'wallet', roles: ['RECEPTIONIST', 'ACCOUNTS'], permission: 'payments:collect', end: true },
  { to: '/billing/close-day', label: 'Close the day', icon: 'card', roles: ['RECEPTIONIST', 'ACCOUNTS'], permission: 'payments:collect' },
];

export function navFor(user: { role: Role; permissions: string[] }): NavSection[] {
  const items = MENU.filter((m) => m.roles.includes(user.role) && (!m.permission || user.permissions.includes(m.permission)));
  return [{ title: ROLE_LABELS[user.role], items: items.map((m) => ({ to: m.to, label: m.label, end: m.end, icon: ic(m.icon) })) }];
}
