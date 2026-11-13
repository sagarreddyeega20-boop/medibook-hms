import { useState } from 'react';
import {
  AppShell, AvailabilityChips, Pill, Timeline, DoctorBoardCard, SlotGrid, SlotLegend, Badge, Button, Card, DashGrid, NowConsultingCard, PersonCell, StatCard, StatGrid, Table, Textarea,
  type Column, type DayAvailability,
} from '../../components';
import { greeting } from '../../lib/format';
import { demoUser, foundationNav } from '../../lib/nav';

interface Row { id: string; time: string; name: string; mrn: string; reason: string; status: string }

const schedule: Row[] = [
  { id: 'a1', time: '10:00', name: 'Priya S.', mrn: 'MB-24-00412', reason: 'Acne follow-up', status: 'COMPLETED' },
  { id: 'a2', time: '11:30', name: 'Rahul Kumar', mrn: 'MB-24-00731', reason: 'Skin rash (new)', status: 'CHECKED_IN' },
  { id: 'a3', time: '12:00', name: 'Lakshmi N.', mrn: 'MB-23-01988', reason: 'Hair fall', status: 'BOOKED' },
  { id: 'a4', time: '12:30', name: 'Mohammed A.', mrn: 'MB-25-00057', reason: 'Eczema review', status: 'CANCELLED' },
  { id: 'a5', time: '16:00', name: 'Divya R.', mrn: 'MB-24-01120', reason: 'Pigmentation', status: 'BOOKED' },
];

const action = (r: Row) => {
  switch (r.status) {
    case 'CHECKED_IN': return <Button size="sm">Start consult</Button>;
    case 'COMPLETED': return <Button variant="link">View notes</Button>;
    case 'CANCELLED': return <Button variant="link">Offer slot</Button>;
    default: return <Button variant="link">Patient history</Button>;
  }
};

const columns: Column<Row>[] = [
  { key: 'time', header: 'Time', render: (r) => <span className="mb-time">{r.time}</span> },
  { key: 'patient', header: 'Patient', render: (r) => <PersonCell name={r.name} sub={r.mrn} /> },
  { key: 'reason', header: 'Reason', render: (r) => r.reason },
  { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
  { key: 'action', header: 'Action', render: action },
];

/** v1 page 3: staff dashboard layout (dark sidebar, greeting + search, stat cards, main table, right side panel). */
export function StaffDashboardDemo() {
  const [days, setDays] = useState<DayAvailability[]>(
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => ({ day, open: !['Wed', 'Sun'].includes(day) })),
  );
  const [search, setSearch] = useState('');
  const rows = schedule.filter((r) => `${r.name} ${r.mrn}`.toLowerCase().includes(search.toLowerCase()));

  return (
    <AppShell
      nav={foundationNav}
      brandSub="for Staff"
      user={{ ...demoUser, onLogout: () => undefined }}
      title={`${greeting()}, Dr. Ananya`}
      subtitle="Saturday, 14 November · Skin Care Clinic, Jayanagar"
      search={{ placeholder: 'Search Patient ID or name', value: search, onChange: setSearch }}
      actions={<Button>Block a slot</Button>}
    >
      <StatGrid label="Today at a glance">
        <StatCard label="Today’s appointments" value={12} />
        <StatCard label="Completed" value={4} tone="teal" />
        <StatCard label="Waiting / upcoming" value={7} tone="blue" />
        <StatCard label="Cancelled" value={1} tone="danger" />
      </StatGrid>

      <DashGrid
        main={
          <Card flush>
            <div className="mb-card__head" style={{ padding: 'var(--space-5) var(--space-6) 0' }}>
              <h2 className="mb-card__title">Today’s schedule</h2>
              <Button variant="link">Export list</Button>
            </div>
            <Table columns={columns} rows={rows} rowKey={(r) => r.id} isCurrent={(r) => r.status === 'CHECKED_IN'} caption="Today’s schedule" />
          </Card>
        }
        side={
          <>
            <NowConsultingCard
              patient={{ name: 'Rahul Kumar · 22 M', meta: 'MB-24-00731 · 7 past visits on MediBook' }}
              facts={['11:30 AM · APT-1142']}
              intake="Itchy red rash on forearms for 5 days, no known allergies."
            >
              <Textarea label="Consultation notes" placeholder="Diagnosis, advice…" />
              <div className="row">
                <Button>Save &amp; add prescription</Button>
                <Button variant="secondary">Mark done</Button>
              </div>
            </NowConsultingCard>
            <Card title="Availability this week">
              <AvailabilityChips
                days={days}
                onToggle={(i) => setDays((d) => d.map((x, j) => (j === i ? { ...x, open: !x.open } : x)))}
                legend="Slots: 30 min"
              />
            </Card>
          </>
        }
      />

      <Card title="Patient timeline pattern" subtitle="Timeline + Pill filters (used on the consultation screen and patient record)">
        <div className="stack">
          <div className="mb-chips" role="group" aria-label="Demo filter">
            <Pill selected>All · 5</Pill><Pill>Notes · 1</Pill><Pill>Lab &amp; radiology · 1</Pill><Pill>Referrals · 1</Pill>
          </div>
          <Timeline
            items={[
              { id: 't1', type: 'VISIT', title: 'OPD visit · V-20261114-0003', status: 'IN_CONSULTATION', meta: 'Today · 11:30 AM · Dr. Sneha Kulkarni · Nutrition', current: true, lines: [{ label: 'Complaint', value: 'Diet plan (referral)' }] },
              { id: 't2', type: 'REFERRAL', title: 'Dr. Arjun Mehta → Nutrition', status: 'SCHEDULED', meta: 'Yesterday · 4:10 PM · Dr. Arjun Mehta · Cardiology', lines: [{ label: 'Reason', value: 'Weight loss and cardiac diet plan' }] },
              { id: 't3', type: 'LAB', title: 'ECG (12-lead)', status: 'ORDERED', priority: 'URGENT', meta: 'Yesterday · 4:05 PM · Dr. Arjun Mehta · Laboratory', lines: [{ label: 'Indication', value: 'Rule out ischaemia' }] },
              { id: 't4', type: 'NOTE', title: 'Clinical note · Stable angina', meta: 'Yesterday · 4:00 PM · Dr. Arjun Mehta · Cardiology', lines: [{ label: 'Findings', value: 'BP 150/95, BMI 31' }, { label: 'Diagnosis', value: 'Stable angina' }, { label: 'Advice', value: 'Low-fat diet' }] },
              { id: 't5', type: 'PRESCRIPTION', title: 'Prescription · 1 item', status: 'ACTIVE', meta: 'Yesterday · 4:02 PM · Dr. Arjun Mehta · Cardiology', lines: [{ label: 'Atorvastatin 10 mg', value: '1 tablet · 0-0-1 · 30 days · After dinner' }] },
            ]}
          />
        </div>
      </Card>

      <Card title="Reception live board patterns" subtitle="DoctorBoardCard + SlotGrid + SlotLegend (used on /reception)">
        <div className="stack">
          <div className="mb-boardgrid">
            <DoctorBoardCard name="Dr. Ananya Iyer" meta="Cardiology · Interventional" status="IN_CONSULTATION" token="T4" current="Priya S." queueCount={3} nextFree="Today · 4:15 PM" selected />
            <DoctorBoardCard name="Dr. Vikram Nair" meta="General Medicine" status="RUNNING_LATE" statusNote="Queue 22 min behind schedule" token="T9" queueCount={6} nextFree="Tomorrow · 8:00 AM" />
            <DoctorBoardCard name="Dr. Rhea Kapoor" meta="Dermatology" status="ON_LEAVE" statusNote="On leave: Conference" queueCount={0} />
          </div>
          <SlotGrid
            label="Demo slots"
            onPick={() => undefined}
            slots={[
              { id: '1', time: '10:00 AM', state: 'DONE', sub: 'T1 · Priya S.' },
              { id: '2', time: '10:15 AM', state: 'CHECKED_IN', sub: 'T2 · Rahul K.' },
              { id: '3', time: '10:30 AM', state: 'BOOKED', sub: 'Lakshmi N.' },
              { id: '4', time: '10:45 AM', state: 'HELD' },
              { id: '5', time: '11:00 AM', state: 'CANCELLED' },
              { id: '6', time: '11:15 AM', state: 'FREE', selected: true },
            ]}
          />
          <SlotLegend />
        </div>
      </Card>
    </AppShell>
  );
}
