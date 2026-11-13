import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { PatientLayout, PatientNavbar } from '../../components';

/** Public pages (login, sign-up, set password) use the v1 patient top navbar on the light page. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <PatientLayout
      navbar={
        <PatientNavbar
          links={[{ to: '/login', label: 'Log in' }]}
          cta={<Link to="/register" className="mb-btn mb-btn--primary">Sign up</Link>}
        />
      }
    >
      {children}
    </PatientLayout>
  );
}
