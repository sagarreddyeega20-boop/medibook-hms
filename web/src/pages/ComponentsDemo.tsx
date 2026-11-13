import { useState } from 'react';
import {
  AppShell, AuthCard, AuthNote, Badge, Button, Card, EmptyState, IdHighlight, Input, Modal, OtpInput, Segmented, Select, Table, Tabs, useToast,
  type Column,
} from '../components';
import { demoUser, foundationNav } from '../lib/nav';

interface DemoOrder {
  id: string;
  patient: string;
  mrn: string;
  test: string;
  status: string;
  amountPaise: number;
}

const orders: DemoOrder[] = [
  { id: 'ORD-1001', patient: 'Asha Verma', mrn: 'MB000123', test: 'ECG (12-lead)', status: 'ORDERED', amountPaise: 30000 },
  { id: 'ORD-1002', patient: 'Rahul Nair', mrn: 'MB000124', test: 'Complete Blood Count', status: 'IN_PROGRESS', amountPaise: 35000 },
  { id: 'ORD-1003', patient: 'Meena Iyer', mrn: 'MB000125', test: 'Chest X-ray (PA view)', status: 'RESULT_READY', amountPaise: 60000 },
  { id: 'ORD-1004', patient: 'Imran Khan', mrn: 'MB000126', test: 'Lipid profile', status: 'CANCELLED', amountPaise: 45000 },
];

const rupees = (paise: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100);

const columns: Column<DemoOrder>[] = [
  { key: 'id', header: 'Order', render: (r) => <strong>{r.id}</strong> },
  { key: 'patient', header: 'Patient', render: (r) => <>{r.patient} <span className="muted">· {r.mrn}</span></> },
  { key: 'test', header: 'Test', render: (r) => r.test },
  { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} dot /> },
  { key: 'amount', header: 'Amount', numeric: true, render: (r) => rupees(r.amountPaise) },
];

const statusGroups = {
  Appointment: ['HELD', 'BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_CONSULTATION', 'COMPLETED', 'CANCELLED', 'NO_SHOW'],
  Order: ['ORDERED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'RESULT_READY', 'CANCELLED'],
  Invoice: ['DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID'],
  'Doctor live status': ['AVAILABLE', 'IN_CONSULTATION', 'RUNNING_LATE', 'OFF_DUTY', 'ON_LEAVE'],
};

export function ComponentsDemo() {
  const [seg, setSeg] = useState('staff');
  const [otp, setOtp] = useState('');
  const toast = useToast();
  const [tab, setTab] = useState('queue');
  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);

  const fakeSave = () => {
    setLoading(true);
    window.setTimeout(() => {
      setLoading(false);
      setModalOpen(false);
      toast.success('Walk-in registered', 'Token 14 issued for Dr. Mehta (Cardiology).');
    }, 700);
  };

  return (
    <AppShell
      nav={foundationNav}
      user={demoUser}
      title="Components"
      subtitle="Every base component in the MediBook style. Pages compose these — never hard-coded colours."
      actions={<Button onClick={() => setModalOpen(true)}>Open modal</Button>}
    >
      <Card title="Buttons" subtitle="primary · secondary · soft · ghost · danger, two sizes, loading and disabled">
        <div className="stack">
          <div className="row">
            <Button>Book appointment</Button>
            <Button variant="secondary">Reschedule</Button>
            <Button variant="soft">Check in</Button>
            <Button variant="ghost">Skip</Button>
            <Button variant="danger">Cancel visit</Button>
          </div>
          <div className="row">
            <Button size="sm">Small primary</Button>
            <Button size="sm" variant="secondary">Small secondary</Button>
            <Button loading>Saving</Button>
            <Button disabled>Disabled</Button>
          </div>
        </div>
      </Card>

      <div className="grid-2">
        <Card title="Inputs" subtitle="Label, hint, error and disabled states">
          <div className="stack">
            <Input label="Patient name" placeholder="e.g. Asha Verma" value={name} onChange={(e) => setName(e.target.value)} hint="As on government ID" />
            <Input label="Phone" placeholder="10-digit mobile" error="Enter a valid 10-digit mobile number" defaultValue="98765" />
            <Input label="MRN" value="MB000123" disabled readOnly />
          </div>
        </Card>
        <Card title="Selects" subtitle="Native select styled with tokens">
          <div className="stack">
            <Select
              label="Department"
              placeholder="Choose a department"
              options={[
                { value: 'CARD', label: 'Cardiology' },
                { value: 'NUTR', label: 'Nutrition' },
                { value: 'GEN', label: 'General Medicine' },
              ]}
            />
            <Select
              label="Payment method"
              defaultValue="UPI"
              options={[
                { value: 'CASH', label: 'Cash' },
                { value: 'UPI', label: 'UPI' },
                { value: 'CARD', label: 'Card' },
              ]}
            />
            <Select label="Visit type" error="Choose a visit type" placeholder="Select…" options={[{ value: 'OPD', label: 'OPD' }, { value: 'WALK_IN', label: 'Walk-in' }]} />
          </div>
        </Card>
      </div>

      <Card title="Badges" subtitle="Status colours come from one shared map, so a status looks the same everywhere">
        <div className="stack">
          {Object.entries(statusGroups).map(([group, statuses]) => (
            <div key={group} className="row">
              <span className="muted">{group}:</span>
              {statuses.map((s) => <Badge key={s} status={s} dot />)}
            </div>
          ))}
          <div className="row">
            <span className="muted">Tones:</span>
            {(['primary', 'success', 'danger', 'warning', 'pending', 'info', 'neutral'] as const).map((t) => <Badge key={t} tone={t}>{t}</Badge>)}
          </div>
        </div>
      </Card>

      <Card title="Tabs + Table" subtitle="Lab queue example (amounts stored as integer paise)" flush={false}>
        <Tabs
          label="Lab queue filters"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'queue', label: 'Queue', count: orders.length },
            { id: 'ready', label: 'Results ready', count: 1 },
            { id: 'empty', label: 'Cancelled today', count: 0 },
          ]}
        >
          {tab === 'queue' && <Table caption="Lab orders" columns={columns} rows={orders} rowKey={(r) => r.id} onRowClick={(r) => toast.show({ tone: 'info', title: r.id, message: `${r.patient} — ${r.test}` })} />}
          {tab === 'ready' && <Table caption="Results ready" columns={columns} rows={orders.filter((o) => o.status === 'RESULT_READY')} rowKey={(r) => r.id} />}
          {tab === 'empty' && <Table caption="Cancelled" columns={columns} rows={[]} rowKey={(r) => r.id} empty={<EmptyState title="No cancelled orders" text="Cancelled lab orders from today will be listed here." />} />}
        </Tabs>
      </Card>

      <div className="grid-2">
        <Card title="Toasts" subtitle="Bottom-right, auto-dismiss after 4 seconds">
          <div className="row">
            <Button variant="secondary" onClick={() => toast.success('Payment recorded', '₹1,250.00 by UPI against INV-2041.')}>Success</Button>
            <Button variant="secondary" onClick={() => toast.error('Slot already booked', 'Dr. Mehta 10:30 was just taken. Pick another slot.')}>Error</Button>
            <Button variant="secondary" onClick={() => toast.show({ tone: 'warning', title: 'Low stock', message: 'Atorvastatin 10mg: 8 left (reorder at 10).' })}>Warning</Button>
            <Button variant="secondary" onClick={() => toast.show({ tone: 'info', title: 'New referral', message: 'Cardiology referred Asha Verma to Nutrition.' })}>Info</Button>
          </div>
        </Card>
        <Card title="Empty state">
          <EmptyState title="No appointments today" text="Bookings made at reception or online will appear here in real time." action={<Button variant="soft" size="sm">Register walk-in</Button>} />
        </Card>
      </div>

      <Card title="Login / sign-up (v1 02-login, 03-signup)" subtitle="AuthCard · Segmented · OtpInput · IdHighlight · AuthNote — used by /login, /register, /set-password">
        <div className="grid-2">
          <AuthCard title="Welcome to MediBook" subtitle="Sign in with your hospital-issued staff ID.">
            <Segmented label="Sign in as" value={seg} onChange={setSeg} options={[{ id: 'staff', label: 'Staff' }, { id: 'patient', label: 'Patient' }]} />
            <OtpInput value={otp} onChange={setOtp} hint={<>Code expires in <strong>4:32</strong></>} />
            <Button block>Verify &amp; sign in</Button>
            <AuthNote>Didn’t get it? Resend in <strong>0:42</strong></AuthNote>
          </AuthCard>
          <AuthCard title="You’re all set" subtitle="Welcome to MediBook, Rahul.">
            <IdHighlight label="Your Patient ID" value="MB-2026-000001">Use this ID at reception on every visit.</IdHighlight>
          </AuthCard>
        </div>
      </Card>

      <Modal
        open={modalOpen}
        title="Register walk-in"
        onClose={() => setModalOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button onClick={fakeSave} loading={loading}>Register & issue token</Button>
          </>
        }
      >
        <div className="stack">
          <Input label="Patient name" placeholder="Full name" autoFocus />
          <Input label="Phone" placeholder="10-digit mobile" />
          <Select label="Doctor" placeholder="Choose a doctor" options={[{ value: 'd1', label: 'Dr. Mehta — Cardiology' }, { value: 'd2', label: 'Dr. Rao — Nutrition' }]} />
        </div>
      </Modal>
    </AppShell>
  );
}
