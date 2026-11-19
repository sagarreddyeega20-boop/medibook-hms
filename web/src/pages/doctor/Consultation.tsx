import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Badge, Button, Card, DashGrid, DoctorStatusSelect, EmptyState, Input, Modal, PersonCell, Select, Table, Tabs, Textarea, useToast, type Column, type DoctorStatusOption,
} from '../../components';
import { api, ApiRequestError, errorMessage } from '../../lib/api';
import { useLive } from '../../lib/live';
import { formatPaise } from '../../lib/format';
import { timeLabel, whenLabel } from '../../lib/time';
import { StaffLayout } from '../staff/StaffLayout';
import { patientMeta, type Consultation as ConsultationData, type Order } from './clinical';
import { PatientHeaderCard, PatientTimelineCard } from './PatientTimeline';

type TabId = 'notes' | 'tests' | 'referral' | 'rx';

/** Consultation screen for one visit: patient header, notes, orders (lab, radiology, referral, prescription), timeline, complete. */
export function Consultation() {
  const { visitId = '' } = useParams();
  const toast = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState<ConsultationData | null>(null);
  const [denied, setDenied] = useState<{ patientId: string } | null>(null);
  const [tab, setTab] = useState<TabId>('notes');
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirmDone, setConfirmDone] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<ConsultationData>(`/api/visits/${visitId}`));
      setDenied(null);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 403 && err.error.code === 'NO_CARE_RELATIONSHIP') {
        setDenied({ patientId: '' });
      } else toast.error('Could not open the consultation', errorMessage(err));
    }
  }, [visitId, toast]);
  useEffect(() => void load(), [load]);

  const changed = async () => {
    await load();
    setRefresh((n) => n + 1);
  };

  const move = async (action: 'start' | 'complete') => {
    setBusy(true);
    try {
      await api(`/api/visits/${visitId}/${action}`, { method: 'POST' });
      if (action === 'complete') {
        toast.success('Visit completed', 'The consultation charge was added to the patient’s bill.');
        setConfirmDone(false);
      }
      await changed();
    } catch (err) {
      toast.error('That didn’t work', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (denied) {
    return (
      <StaffLayout title="Consultation" subtitle="Access is limited to doctors treating this patient.">
        <Card title="No access to this visit">
          <p className="muted">This consultation belongs to a patient you have no visit, order or referral with. Open the patient from search to use break-glass access.</p>
          <div className="row" style={{ marginTop: 'var(--space-4)' }}><Link className="mb-btn mb-btn--secondary" to="/doctor">Back to schedule</Link></div>
        </Card>
      </StaffLayout>
    );
  }
  if (!data) return <StaffLayout title="Consultation" subtitle="Loading…"><Card><p className="muted">Loading…</p></Card></StaffLayout>;

  const { visit, patient, canEdit } = data;
  const inConsult = visit.status === 'IN_CONSULTATION';
  return (
    <StaffLayout
      title={patient.name}
      subtitle={`${patientMeta(patient)} · ${visit.visitNumber} · ${visit.type === 'WALK_IN' ? 'Walk-in' : 'Appointment'}${visit.doctor ? ` · ${visit.doctor.name}` : ''}`}
      actions={
        <>
          <Button variant="secondary" onClick={() => navigate('/doctor')}>Back to schedule</Button>
          {data.isMine && visit.status === 'OPEN' && <Button loading={busy} onClick={() => void move('start')}>Start consult</Button>}
          {data.isMine && inConsult && <Button loading={busy} onClick={() => setConfirmDone(true)}>Complete visit</Button>}
        </>
      }
    >
      {data.referral && <ReferralBanner order={data.referral} />}

      <DashGrid
        main={
          <>
            <Card title="Consultation" subtitle={canEdit ? (inConsult ? `In consultation since ${visit.consultStartedAt ? timeLabel(visit.consultStartedAt) : '—'}` : 'Waiting — start the consult when the patient comes in.') : `Read only · visit ${visit.status.toLowerCase().replace('_', ' ')}`} actions={<Badge status={visit.status} />}>
              <Tabs
                label="Consultation sections"
                value={tab}
                onChange={(id) => setTab(id as TabId)}
                tabs={[
                  { id: 'notes', label: 'Notes' },
                  { id: 'tests', label: 'Lab & radiology', count: data.orders.filter((o) => o.type === 'LAB' || o.type === 'RADIOLOGY').length },
                  { id: 'referral', label: 'Referral', count: data.orders.filter((o) => o.type === 'REFERRAL').length },
                  { id: 'rx', label: 'Prescription', count: data.orders.filter((o) => o.type === 'MEDICATION').length },
                ]}
              >
                {tab === 'notes' && <NotesForm key={data.note?.id ?? 'new'} data={data} onSaved={changed} />}
                {tab === 'tests' && <TestsForm visitId={visit.id} disabled={!canEdit} onSaved={changed} />}
                {tab === 'referral' && <ReferralForm visitId={visit.id} disabled={!canEdit} onSaved={changed} />}
                {tab === 'rx' && <PrescriptionForm visitId={visit.id} disabled={!canEdit} onSaved={changed} />}
              </Tabs>
            </Card>
            <OrdersCard orders={data.orders} canEdit={canEdit} onChanged={changed} />
            <PatientTimelineCard patientId={patient.id} currentVisitId={visit.id} refreshKey={refresh} onDenied={() => setDenied({ patientId: patient.id })} />
          </>
        }
        side={
          <>
            <PatientHeaderCard
              patient={patient}
              title={inConsult ? 'Now consulting' : 'Patient'}
              access={data.access}
              facts={[visit.tokenNumber ? `Token T${visit.tokenNumber}` : '', `${data.pastVisits} past visit${data.pastVisits === 1 ? '' : 's'}`].filter(Boolean)}
            >
              <AllergiesEditor patientId={patient.id} value={patient.allergies} disabled={!canEdit} onSaved={changed} />
            </PatientHeaderCard>
            <Card title="Charges on this visit">
              {data.charges.length ? (
                <dl className="mb-rows mb-rows--bill">
                  {data.charges.map((c) => <div key={c.id}><dt>{c.description}</dt><dd>{formatPaise(c.totalPaise)}</dd></div>)}
                </dl>
              ) : (
                <p className="muted">The consultation charge is added when you complete the visit.</p>
              )}
            </Card>
          </>
        }
      />

      <Modal
        open={confirmDone}
        title="Complete this visit?"
        onClose={() => setConfirmDone(false)}
        footer={<><Button variant="secondary" onClick={() => setConfirmDone(false)}>Not yet</Button><Button loading={busy} onClick={() => void move('complete')}>Complete visit</Button></>}
      >
        <p>The visit closes (notes and orders become read-only) and a consultation charge is added to {patient.name}’s bill.</p>
        {!data.note?.diagnosis && <p className="muted" style={{ marginTop: 'var(--space-3)' }}>No diagnosis has been recorded yet.</p>}
      </Modal>
    </StaffLayout>
  );
}

/* ---------------- Incoming referral (target doctor sees the reason) ---------------- */

function ReferralBanner({ order }: { order: Order }) {
  return (
    <Card title={`Referred by ${order.orderingDoctor.name}${order.orderingDoctor.department ? ` · ${order.orderingDoctor.department.name}` : ''}`} subtitle={`${order.orderNumber} · ${whenLabel(order.createdAt)}`} actions={<><Badge status={order.priority} /><Badge status={order.status} /></>}>
      <div className="mb-intake">
        <p className="mb-intake__label">Referral reason</p>
        {order.referral?.reason ?? order.clinicalNotes}
      </div>
    </Card>
  );
}

/* ---------------- Notes ---------------- */

function NotesForm({ data, onSaved }: { data: ConsultationData; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const n = data.note;
  const [form, setForm] = useState({ complaint: n?.complaint ?? data.visit.chiefComplaint ?? '', findings: n?.findings ?? '', diagnosis: n?.diagnosis ?? '', advice: n?.advice ?? '' });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const disabled = !data.canEdit;
  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/visits/${data.visit.id}/notes`, { method: 'PUT', json: form });
      toast.success('Notes saved');
      await onSaved();
    } catch (err) {
      toast.error('Notes not saved', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <Textarea label="Complaint" rows={2} value={form.complaint} onChange={set('complaint')} disabled={disabled} placeholder="What brings the patient in" />
      <Textarea label="Findings" rows={3} value={form.findings} onChange={set('findings')} disabled={disabled} placeholder="Examination, vitals, observations" />
      <Input label="Diagnosis" value={form.diagnosis} onChange={set('diagnosis')} disabled={disabled} placeholder="e.g. Stable angina" />
      <Textarea label="Advice" rows={3} value={form.advice} onChange={set('advice')} disabled={disabled} placeholder="Advice, follow-up, lifestyle" />
      {!disabled && <div className="row"><Button loading={busy} onClick={save}>Save notes</Button>{n && <span className="muted">Last saved {timeLabel(n.updatedAt)}</span>}</div>}
    </div>
  );
}

/* ---------------- Lab & radiology ---------------- */

interface CatalogueItem { id: string; code: string; name: string; category: 'LAB_TEST' | 'RADIOLOGY_SCAN'; pricePaise: number; department: { name: string } }
const PRIORITIES = [
  { value: 'ROUTINE', label: 'Routine' },
  { value: 'URGENT', label: 'Urgent' },
  { value: 'STAT', label: 'STAT (immediately)' },
];

function TestsForm({ visitId, disabled, onSaved }: { visitId: string; disabled: boolean; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [items, setItems] = useState<CatalogueItem[]>([]);
  const [itemId, setItemId] = useState('');
  const [priority, setPriority] = useState('ROUTINE');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ items: CatalogueItem[] }>('/api/orders/catalogue').then((r) => setItems(r.items)).catch(() => undefined);
  }, []);
  if (disabled) return <p className="muted">This visit is closed. Orders placed during it are listed below.</p>;
  const submit = async () => {
    setBusy(true);
    try {
      const { order } = await api<{ order: Order }>('/api/orders/investigations', { json: { visitId, catalogueItemId: itemId, priority, notes: notes || undefined } });
      toast.success(`${order.title} ordered`, `${order.orderNumber} is in the ${order.targetDepartment.name} queue.`);
      setItemId('');
      setNotes('');
      await onSaved();
    } catch (err) {
      toast.error('Order not placed', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const label = (i: CatalogueItem) => `${i.category === 'LAB_TEST' ? 'Lab' : 'Radiology'} · ${i.name} · ${formatPaise(i.pricePaise)}`;
  return (
    <div className="stack">
      <Select label="Test or scan (service catalogue)" placeholder="Choose a test or scan…" value={itemId} onChange={(e) => setItemId(e.target.value)} options={items.map((i) => ({ value: i.id, label: label(i) }))} />
      <Select label="Priority" value={priority} onChange={(e) => setPriority(e.target.value)} options={PRIORITIES} />
      <Textarea label="Indication (optional)" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Rule out ischaemia" />
      <div className="row"><Button loading={busy} disabled={!itemId} onClick={submit}>Place order</Button></div>
    </div>
  );
}

/* ---------------- Referral ---------------- */

interface Target { id: string; name: string; doctors: { id: string; name: string; specialty: string | null }[] }

function ReferralForm({ visitId, disabled, onSaved }: { visitId: string; disabled: boolean; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [targets, setTargets] = useState<Target[]>([]);
  const [deptId, setDeptId] = useState('');
  const [doctorId, setDoctorId] = useState('');
  const [priority, setPriority] = useState('ROUTINE');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [doctors, setDoctors] = useState<DoctorStatusOption[] | null>(null);
  const deptRef = useRef(deptId);
  deptRef.current = deptId;
  useEffect(() => {
    api<{ departments: Target[] }>('/api/orders/referral-targets').then((r) => setTargets(r.departments)).catch(() => undefined);
  }, []);
  // Live status of the chosen department's doctors (same calculation as the reception board).
  const loadDoctors = useCallback(async (id: string) => {
    if (!id) return setDoctors(null);
    const r = await api<{ doctors: DoctorStatusOption[] }>(`/api/reception/doctor-status?departmentId=${id}`);
    setDoctors((prev) => (id === deptRef.current ? r.doctors : prev));
  }, []);
  useEffect(() => {
    setDoctors(null);
    loadDoctors(deptId).catch(() => undefined);
  }, [deptId, loadDoctors]);
  useLive(['slots:changed'], () => void loadDoctors(deptRef.current).catch(() => undefined), !!deptId && !disabled);
  const dept = targets.find((t) => t.id === deptId);
  if (disabled) return <p className="muted">This visit is closed. Referrals made during it are listed below.</p>;
  const submit = async () => {
    setBusy(true);
    try {
      const { order } = await api<{ order: Order }>('/api/orders/referrals', { json: { visitId, toDepartmentId: deptId, toDoctorId: doctorId || null, reason, priority } });
      toast.success('Referral sent', `${order.orderNumber} is on the reception board to book with ${order.targetDoctor?.name ?? order.targetDepartment.name}.`);
      setDeptId('');
      setDoctorId('');
      setReason('');
      await onSaved();
    } catch (err) {
      toast.error('Referral not sent', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <div className="grid-2">
        <Select label="Department" placeholder="Choose a department…" value={deptId} onChange={(e) => { setDeptId(e.target.value); setDoctorId(''); }} options={targets.map((t) => ({ value: t.id, label: t.name }))} />
        <DoctorStatusSelect
          label="Doctor (optional)"
          value={doctorId}
          disabled={!dept}
          loading={!!dept && !doctors}
          onChange={setDoctorId}
          emptyLabel="Any doctor in the department"
          doctors={doctors ?? []}
        />
      </div>
      <Select label="Urgency" value={priority} onChange={(e) => setPriority(e.target.value)} options={PRIORITIES} />
      <Textarea label="Reason for referral" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What you want the other doctor to assess" hint="Only the receiving doctor sees the reason; reception sees just the department and urgency." />
      <div className="row"><Button loading={busy} disabled={!deptId || reason.trim().length < 5} onClick={submit}>Send referral</Button></div>
    </div>
  );
}

/* ---------------- Prescription (MEDICATION order) ---------------- */

interface Medicine { id: string; name: string; strength: string | null; form: string | null; stockQuantity: number }
interface RxLine { medicineName: string; dose: string; frequency: string; durationDays: string; instructions: string }
const emptyLine = (): RxLine => ({ medicineName: '', dose: '', frequency: '', durationDays: '', instructions: '' });

function PrescriptionForm({ visitId, disabled, onSaved }: { visitId: string; disabled: boolean; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [meds, setMeds] = useState<Medicine[]>([]);
  const [lines, setLines] = useState<RxLine[]>([emptyLine()]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ medicines: Medicine[] }>('/api/orders/medicines').then((r) => setMeds(r.medicines)).catch(() => undefined);
  }, []);
  const byName = useMemo(() => new Map(meds.map((m) => [m.name.toLowerCase(), m])), [meds]);
  if (disabled) return <p className="muted">This visit is closed. Prescriptions written during it are listed below.</p>;

  const set = (i: number, k: keyof RxLine, v: string) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const valid = lines.every((l) => l.medicineName.trim().length >= 2 && (!l.durationDays || Number(l.durationDays) > 0));
  const submit = async () => {
    setBusy(true);
    try {
      const items = lines.map((l) => ({
        medicineId: byName.get(l.medicineName.trim().toLowerCase())?.id ?? null,
        medicineName: l.medicineName.trim(),
        dose: l.dose || null,
        frequency: l.frequency || null,
        durationDays: l.durationDays ? Number(l.durationDays) : null,
        instructions: l.instructions || null,
      }));
      const { order } = await api<{ order: Order }>('/api/orders/prescriptions', { json: { visitId, items, notes: notes || undefined } });
      toast.success('Prescription sent to pharmacy', order.orderNumber);
      setLines([emptyLine()]);
      setNotes('');
      await onSaved();
    } catch (err) {
      toast.error('Prescription not saved', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <datalist id="mb-formulary">
        {meds.map((m) => <option key={m.id} value={m.name}>{m.stockQuantity > 0 ? `In stock: ${m.stockQuantity}` : 'Out of stock'}</option>)}
      </datalist>
      {lines.map((l, i) => (
        <Card key={i} title={`Medicine ${i + 1}`} actions={lines.length > 1 ? <Button variant="ghost" size="sm" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>Remove</Button> : undefined}>
          <div className="stack">
            <Input label="Medicine" list="mb-formulary" value={l.medicineName} onChange={(e) => set(i, 'medicineName', e.target.value)} placeholder="Start typing — pharmacy formulary" hint={byName.has(l.medicineName.trim().toLowerCase()) ? 'In the pharmacy formulary' : l.medicineName ? 'Not in the formulary — the pharmacist will substitute' : undefined} />
            <div className="grid-2">
              <Input label="Dose" value={l.dose} onChange={(e) => set(i, 'dose', e.target.value)} placeholder="1 tablet" />
              <Input label="Frequency" value={l.frequency} onChange={(e) => set(i, 'frequency', e.target.value)} placeholder="1-0-1 or BD" />
              <Input label="Days" type="number" min={1} max={365} value={l.durationDays} onChange={(e) => set(i, 'durationDays', e.target.value)} placeholder="5" />
              <Input label="Instructions" value={l.instructions} onChange={(e) => set(i, 'instructions', e.target.value)} placeholder="After food" />
            </div>
          </div>
        </Card>
      ))}
      <div className="row"><Button variant="soft" size="sm" onClick={() => setLines((ls) => [...ls, emptyLine()])}>+ Add medicine</Button></div>
      <Textarea label="Notes for the pharmacist (optional)" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      <div className="row"><Button loading={busy} disabled={!valid} onClick={submit}>Save prescription</Button></div>
    </div>
  );
}

/* ---------------- Orders on this visit ---------------- */

function OrdersCard({ orders, canEdit, onChanged }: { orders: Order[]; canEdit: boolean; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const cancel = async (o: Order) => {
    setBusy(o.id);
    try {
      await api(`/api/orders/${o.id}/cancel`, { json: { reason: 'Cancelled by the ordering doctor' } });
      toast.success(`${o.orderNumber} cancelled`);
      await onChanged();
    } catch (err) {
      toast.error('Not cancelled', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const detail = (o: Order) => {
    if (o.type === 'REFERRAL') return `${o.targetDoctor?.name ?? 'Any doctor'} · ${o.targetDepartment.name}${o.scheduledFor ? ` · ${whenLabel(o.scheduledFor)}` : ''}`;
    if (o.type === 'MEDICATION') return (o.prescription?.items ?? []).map((i) => [i.medicineName, i.frequency, i.durationDays ? `${i.durationDays}d` : null].filter(Boolean).join(' ')).join('; ');
    return `${o.targetDepartment.name}${o.clinicalNotes ? ` · ${o.clinicalNotes}` : ''}`;
  };
  const columns: Column<Order>[] = [
    { key: 'order', header: 'Order', render: (o) => <PersonCell name={o.type === 'MEDICATION' ? 'Prescription' : o.title} sub={o.orderNumber} /> },
    { key: 'type', header: 'Type', render: (o) => <div className="row" style={{ gap: 'var(--space-1)' }}><Badge status={o.type} size="sm" />{o.priority !== 'ROUTINE' && <Badge status={o.priority} size="sm" />}</div> },
    { key: 'detail', header: 'Details', render: detail },
    { key: 'status', header: 'Status', render: (o) => <Badge status={o.status} /> },
    { key: 'action', header: '', render: (o) => (canEdit && o.status === 'ORDERED' ? <Button variant="danger-outline" size="sm" loading={busy === o.id} onClick={() => void cancel(o)}>Cancel</Button> : null) },
  ];
  return (
    <Card flush>
      <div className="mb-card__head" style={{ padding: 'var(--space-5) var(--space-6) 0' }}>
        <h2 className="mb-card__title">Orders on this visit</h2>
        <span className="muted">{orders.length}</span>
      </div>
      <Table columns={columns} rows={orders} rowKey={(o) => o.id} caption="Orders on this visit" empty={<EmptyState title="No orders yet" text="Tests, scans, referrals and prescriptions you add appear here." />} />
    </Card>
  );
}

/* ---------------- Allergies ---------------- */

function AllergiesEditor({ patientId, value, disabled, onSaved }: { patientId: string; value: string | null; disabled: boolean; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value ?? '');
  const [busy, setBusy] = useState(false);
  if (disabled) return null;
  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/visits/patients/${patientId}/allergies`, { method: 'PUT', json: { allergies: text || null } });
      setOpen(false);
      await onSaved();
    } catch (err) {
      toast.error('Allergies not saved', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="link" onClick={() => { setText(value ?? ''); setOpen(true); }}>Update allergies</Button>
      <Modal open={open} title="Allergies" onClose={() => setOpen(false)} footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={busy} onClick={save}>Save</Button></>}>
        <Textarea label="Known allergies" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Penicillin (rash), peanuts" hint="Leave empty if none are known." autoFocus />
      </Modal>
    </>
  );
}

