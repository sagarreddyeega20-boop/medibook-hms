import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PatientLayout, PatientNavbar } from '../../components';
import { useAuth } from '../../lib/auth';

/** v1 patient layout wired to the signed-in patient: navbar links, teal "Book a doctor" CTA, logout. */
export function PatientShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;
  return (
    <PatientLayout
      navbar={
        <PatientNavbar
          links={[
            { to: '/patient', label: 'Home', end: true },
            { to: '/patient/doctors', label: 'Find a doctor' },
            { to: '/patient/appointments', label: 'My appointments' },
          ]}
          user={{ name: user.name, onLogout: async () => { await logout(); navigate('/login?tab=patient', { replace: true }); } }}
          cta={<Link to="/patient/doctors" className="mb-btn mb-btn--primary mb-btn--sm">Book a doctor</Link>}
        />
      }
    >
      {children}
    </PatientLayout>
  );
}
