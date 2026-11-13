import { Link } from 'react-router-dom';
import { PatientNavbar } from '../../components';

/** Navbar used by the patient demo pages. Real patient pages pass their own links. */
export function PatientDemoNavbar({ signedIn = true }: { signedIn?: boolean }) {
  return (
    <PatientNavbar
      links={[
        { to: '/demo/patient', label: 'Find doctors', end: true },
        { to: '/demo/patient/appointments', label: 'My appointments' },
        { to: '/demo/staff', label: 'Staff login' },
      ]}
      user={signedIn ? { name: 'Rahul Kumar', onLogout: () => undefined } : undefined}
      cta={signedIn ? undefined : <Link to="/demo/patient" className="mb-btn mb-btn--primary mb-btn--sm">Get my Patient ID</Link>}
    />
  );
}
