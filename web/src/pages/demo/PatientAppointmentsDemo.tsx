import { useState } from 'react';
import {
  AppointmentCard, Button, Card, HeroBanner, PatientGrid, PatientLayout, PersonList, SideCard, Table, Tabs, type Column,
} from '../../components';
import { PatientDemoNavbar } from './PatientDemoNav';

interface Consultation { id: string; date: string; doctor: string; notes: string }

const consultations: Consultation[] = [
  { id: 'c1', date: '02 Oct 2026', doctor: 'Dr. Suresh Nayak', notes: 'Viral fever, rest and fluids' },
  { id: 'c2', date: '18 Aug 2026', doctor: 'Dr. Meera Iyer', notes: 'Eye check-up, new spectacle power' },
  { id: 'c3', date: '05 Jun 2026', doctor: 'Dr. Arjun Hegde', notes: 'Wrist sprain, physiotherapy advised' },
];

const columns: Column<Consultation>[] = [
  { key: 'date', header: 'Date', render: (r) => r.date },
  { key: 'doctor', header: 'Doctor', render: (r) => r.doctor },
  { key: 'notes', header: 'Diagnosis / notes', render: (r) => r.notes },
  { key: 'rx', header: 'Prescription', render: () => <Button variant="link">Download PDF</Button> },
];

const actions = (
  <>
    <Button variant="secondary" size="sm">Reschedule</Button>
    <Button variant="danger-outline" size="sm">Cancel</Button>
  </>
);

/** v1 page 2: My appointments & consultation history. */
export function PatientAppointmentsDemo() {
  const [tab, setTab] = useState('upcoming');
  return (
    <PatientLayout navbar={<PatientDemoNavbar />}>
      <PatientGrid
        banner={
          <HeroBanner
            name="Rahul Kumar"
            meta={<>Patient ID <strong>MB-24-00731</strong> · Male, 22 · +91 98xxxx4410</>}
            stats={[{ label: 'Upcoming', value: 2 }, { label: 'Past visits', value: 7 }, { label: 'Doctors consulted', value: 4 }]}
          />
        }
        main={
          <>
            <Tabs
              label="Appointments"
              value={tab}
              onChange={setTab}
              tabs={[{ id: 'upcoming', label: 'Upcoming' }, { id: 'past', label: 'Past consultations' }, { id: 'cancelled', label: 'Cancelled' }]}
            >
              <div className="stack" style={{ gap: 'var(--space-3)' }}>
                <AppointmentCard
                  date={new Date(2026, 10, 14)}
                  title="Dr. Ananya Rao · Dermatology"
                  lines={['Sat · 11:30 AM · Skin Care Clinic, Jayanagar 4th Block', 'Ref APT-1142 · Reason: skin rash']}
                  status="CONFIRMED" payment="PAID" actions={actions}
                />
                <AppointmentCard
                  date={new Date(2026, 10, 21)}
                  title="Dr. Suresh Nayak · General physician"
                  lines={['Sat · 6:00 PM · City Care Clinic, Basavanagudi', 'Ref APT-1187 · Follow-up visit']}
                  status="AWAITING" payment="PAY_AT_CLINIC" actions={actions}
                />
              </div>
            </Tabs>

            <section>
              <h2 className="section-title" style={{ marginBottom: 'var(--space-3)' }}>Recent consultations</h2>
              <Card flush>
                <Table columns={columns} rows={consultations} rowKey={(r) => r.id} caption="Recent consultations" />
              </Card>
            </section>
          </>
        }
        side={
          <>
            <SideCard title="Doctors you’ve consulted">
              <PersonList
                items={[
                  { key: 'sn', name: 'Dr. Suresh Nayak', sub: 'General physician · 3 visits', action: <Button variant="link">Book again</Button> },
                  { key: 'mi', name: 'Dr. Meera Iyer', sub: 'Ophthalmology · 2 visits', action: <Button variant="link">Book again</Button> },
                  { key: 'ah', name: 'Dr. Arjun Hegde', sub: 'Orthopaedics · 1 visit', action: <Button variant="link">Book again</Button> },
                  { key: 'ar', name: 'Dr. Ananya Rao', sub: 'Dermatology · upcoming', action: <Button variant="link">Book again</Button> },
                ]}
              />
            </SideCard>
            <SideCard title="Ask the assistant" tone="assist">
              <p>“Show my last prescription” or “Move my Saturday visit to Sunday” — the chatbot can do it for you.</p>
              <Button variant="link">Open chat</Button>
            </SideCard>
          </>
        }
      />
    </PatientLayout>
  );
}
