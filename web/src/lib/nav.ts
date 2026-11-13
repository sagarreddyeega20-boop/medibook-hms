import type { NavSection } from '../components';

/** Foundation navigation. Role-specific sections are added as modules are built. */
export const foundationNav: NavSection[] = [
  {
    items: [
      { to: '/', label: 'Overview', end: true },
      { to: '/demo/components', label: 'Components' },
    ],
  },
];

export const demoUser = { name: 'Super Admin', role: 'SA0001 · Super Admin' };
