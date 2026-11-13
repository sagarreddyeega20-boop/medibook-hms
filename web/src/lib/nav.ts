import type { NavSection } from '../components';

/** Foundation navigation. Role-specific sections are added as modules are built. */
export const foundationNav: NavSection[] = [
  {
    items: [
      { to: '/', label: 'Overview', end: true },
      { to: '/demo/components', label: 'Components' },
    ],
  },
  {
    title: 'v1 pattern demos',
    items: [
      { to: '/demo/staff', label: 'Staff dashboard' },
      { to: '/demo/patient', label: 'Patient home + chat', end: true },
      { to: '/demo/patient/appointments', label: 'My appointments' },
      { to: '/demo/patient/payment', label: 'Payment' },
      { to: '/demo/patient/chat', label: 'Mobile chat' },
    ],
  },
];

export const demoUser = { name: 'Super Admin', role: 'SA0001 · Super Admin' };
