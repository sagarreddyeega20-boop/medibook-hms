import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, EmptyState, HeroBanner, IdHighlight, PatientGrid, PatientLayout, PatientNavbar, SideCard } from '../../components';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';

interface PatientProfile {
  mrn: string;
  firstName: string;
  lastName: string | null;
  gender: string;
  dateOfBirth: string | null;
  email: string | null;
  phone: string | null;
}

const age = (dob: string) => {
  const d = new Date(dob);
  const now = new Date();
  return now.getFullYear() - d.getFullYear() - (now < new Date(now.getFullYear(), d.getMonth(), d.getDate()) ? 1 : 0);
};

/** Placeholder patient home (v1 patient layout). Visits, reports and bills arrive with their modules. */
export function PatientHome() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<PatientProfile | null>(null);

  useEffect(() => {
    api<{ patient: PatientProfile }>('/api/patients/me').then((r) => setProfile(r.patient)).catch(() => undefined);
  }, []);

  if (!user) return null;
  const sex = profile ? profile.gender.charAt(0) + profile.gender.slice(1).toLowerCase() : '';

  return (
    <PatientLayout
      navbar={
        <PatientNavbar
          links={[{ to: '/patient', label: 'My MediBook' }]}
          user={{ name: user.name, onLogout: async () => { await logout(); navigate('/login?tab=patient', { replace: true }); } }}
        />
      }
    >
      <PatientGrid
        banner={
          <HeroBanner
            name={user.name}
            meta={<>Patient ID <strong>{user.mrn}</strong>{profile?.dateOfBirth ? <> · {sex}, {age(profile.dateOfBirth)}</> : null}{profile?.phone ? <> · {profile.phone}</> : null}</>}
            stats={[{ label: 'Upcoming', value: '—' }, { label: 'Past visits', value: '—' }, { label: 'Bills due', value: '—' }]}
          />
        }
        main={
          <Card title="My visits">
            <EmptyState title="Coming soon" text="Booking, your visits, reports and bills will appear here as the next modules are built." />
          </Card>
        }
        side={
          <>
            <IdHighlight label="Your Patient ID" value={user.mrn ?? ''}>Show this ID at reception on every visit.</IdHighlight>
            <SideCard title="Account">
              <p className="muted">Signed in with a code sent to {profile?.email ?? 'your email'}. You’ll be signed out after 30 minutes without activity.</p>
            </SideCard>
          </>
        }
      />
    </PatientLayout>
  );
}
