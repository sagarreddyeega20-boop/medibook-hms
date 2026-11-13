import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AppointmentCard, Button, Card, EmptyState, HeroBanner, Input, Modal, PatientGrid, PersonList, Select, SideCard, Tabs, Textarea, useToast,
} from '../../components';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { bookingApi, isUpcoming, type Appointment, type HouseholdMember } from '../../lib/booking';
import { useLive } from '../../lib/live';
import { tileDate, timeLabel, whenLabel } from '../../lib/time';
import { PatientShell } from './PatientShell';

const emptyMember = { fullName: '', gender: '', dateOfBirth: '', relationship: '' };

/** Patient portal: upcoming / past / cancelled appointments (self + family), cancel with a reason, reschedule, family members. */
export function MyAppointments() {
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [appointments, setAppointments] = useState<Appointment[] | null>(null);
  const [household, setHousehold] = useState<HouseholdMember[]>([]);
  const [tab, setTab] = useState('upcoming');
  const [cancelling, setCancelling] = useState<Appointment | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [member, setMember] = useState(emptyMember);
  const [memberError, setMemberError] = useState<string>();

  const load = useCallback(async () => {
    const [a, h] = await Promise.all([bookingApi.mine(), bookingApi.household()]);
    setAppointments(a);
    setHousehold(h);
  }, []);
  useEffect(() => {
    load().catch((err) => toast.error('Could not load appointments', errorMessage(err)));
  }, [load, toast]);
  useLive(['slots:changed'], () => void load().catch(() => undefined));

  const groups = useMemo(() => {
    const all = appointments ?? [];
    const upcoming = all.filter(isUpcoming).sort((a, b) => a.slotStart.localeCompare(b.slotStart));
    const cancelled = all.filter((a) => a.status === 'CANCELLED');
    const past = all.filter((a) => !upcoming.includes(a) && a.status !== 'CANCELLED');
    return { upcoming, past, cancelled };
  }, [appointments]);
  const shown = groups[tab as keyof typeof groups];

  const cancel = async () => {
    if (!cancelling) return;
    setBusy(true);
    try {
      await bookingApi.cancel(cancelling.id, reason);
      toast.success(`${cancelling.ref} cancelled`, 'We’ve emailed you a confirmation.');
      setCancelling(null);
      setReason('');
      await load();
    } catch (err) {
      toast.error('Could not cancel', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const addMember = async (e: FormEvent) => {
    e.preventDefault();
    if (member.fullName.trim().length < 2 || !member.gender || !member.dateOfBirth || member.relationship.trim().length < 2) return setMemberError('Fill in every field');
    setBusy(true);
    setMemberError(undefined);
    try {
      await api('/api/patients/me/family', { json: member });
      setAdding(false);
      setMember(emptyMember);
      await load();
      toast.success('Family member added', 'They have their own Patient ID; you can book for them.');
    } catch (err) {
      setMemberError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const doctorsSeen = [...new Map((appointments ?? []).filter((a) => a.status === 'COMPLETED' && a.doctor).map((a) => [a.doctor!.id, a])).values()];
  const forWhom = (a: Appointment) => (household.length > 1 && a.patient ? ` · for ${a.patient.name}` : '');

  return (
    <PatientShell>
      <PatientGrid
        banner={
          <HeroBanner
            name={user?.name ?? ''}
            meta={<>Patient ID <strong>{user?.mrn}</strong>{household.length > 1 ? <> · {household.length - 1} family member{household.length > 2 ? 's' : ''}</> : null}</>}
            stats={[
              { label: 'Upcoming', value: appointments ? groups.upcoming.length : '—' },
              { label: 'Past visits', value: appointments ? groups.past.length : '—' },
              { label: 'Cancelled', value: appointments ? groups.cancelled.length : '—' },
            ]}
          />
        }
        main={
          <div className="stack">
            <Tabs
              label="Appointments"
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'upcoming', label: 'Upcoming', count: groups.upcoming.length },
                { id: 'past', label: 'Past', count: groups.past.length },
                { id: 'cancelled', label: 'Cancelled', count: groups.cancelled.length },
              ]}
            />
            {appointments && shown.length === 0 && (
              <Card>
                <EmptyState
                  title={tab === 'upcoming' ? 'No upcoming appointments' : `No ${tab} appointments`}
                  text="Book with a doctor in a few taps, or ask the assistant."
                  action={<Link to="/patient/doctors" className="mb-btn mb-btn--primary">Book a doctor</Link>}
                />
              </Card>
            )}
            {shown.map((a) => (
              <AppointmentCard
                key={a.id}
                date={tileDate(a.slotStart)}
                title={`${a.doctor?.name ?? 'Doctor'} · ${a.doctor?.department?.name ?? ''}`}
                lines={[
                  `${whenLabel(a.slotStart)} – ${timeLabel(a.slotEnd)}${forWhom(a)}`,
                  `Ref ${a.ref}${a.tokenNumber ? ` · Token T${a.tokenNumber}` : ''}${a.reason ? ` · Reason: ${a.reason}` : ''}${a.cancelReason ? ` · ${a.cancelReason}` : ''}`,
                ]}
                status={a.status === 'BOOKED' ? 'CONFIRMED' : a.status}
                actions={
                  a.status === 'BOOKED' ? (
                    <>
                      <Button variant="secondary" size="sm" onClick={() => navigate(`/patient/doctors?reschedule=${a.id}&ref=${a.ref}`)}>Reschedule</Button>
                      <Button variant="danger-outline" size="sm" onClick={() => setCancelling(a)}>Cancel</Button>
                    </>
                  ) : undefined
                }
              />
            ))}
          </div>
        }
        side={
          <>
            <SideCard title="Family on your account">
              <PersonList items={household.map((h) => ({ key: h.patient.id, name: h.patient.name, sub: `${h.relationship} · ${h.patient.mrn}` }))} />
              <Button variant="link" onClick={() => setAdding(true)}>Add a family member</Button>
            </SideCard>
            <SideCard title="Doctors you’ve consulted">
              {doctorsSeen.length ? (
                <PersonList items={doctorsSeen.map((a) => ({ key: a.doctor!.id, name: a.doctor!.name, sub: a.doctor!.department?.name, action: <Link to="/patient/doctors" className="mb-btn mb-btn--link">Book again</Link> }))} />
              ) : <p className="muted">Doctors you visit will appear here.</p>}
            </SideCard>
            <SideCard title="Ask the assistant" tone="assist">
              <p className="muted">“Book a cardiologist tomorrow”, “my appointments”, “cancel APT-000123”.</p>
              <Link to="/patient" className="mb-btn mb-btn--secondary mb-btn--sm">Open chat</Link>
            </SideCard>
          </>
        }
      />

      <Modal
        open={!!cancelling}
        title={`Cancel ${cancelling?.ref ?? ''}?`}
        onClose={() => setCancelling(null)}
        footer={<><Button variant="secondary" onClick={() => setCancelling(null)}>Keep it</Button><Button variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={cancel}>Cancel appointment</Button></>}
      >
        <div className="stack">
          {cancelling && <p className="muted">{cancelling.doctor?.name} · {whenLabel(cancelling.slotStart)}</p>}
          <Textarea label="Reason" placeholder="e.g. Feeling better / can’t make it" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </div>
      </Modal>

      <Modal
        open={adding}
        title="Add a family member"
        onClose={() => setAdding(false)}
        footer={<><Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button><Button type="submit" form="member-form" loading={busy}>Add member</Button></>}
      >
        <form id="member-form" className="stack" onSubmit={addMember}>
          <Input label="Full name" value={member.fullName} onChange={(e) => setMember({ ...member, fullName: e.target.value })} />
          <div className="grid-2">
            <Select label="Gender" value={member.gender} placeholder="Choose…" options={[{ value: 'FEMALE', label: 'Female' }, { value: 'MALE', label: 'Male' }, { value: 'OTHER', label: 'Other' }]} onChange={(e) => setMember({ ...member, gender: e.target.value })} />
            <Input label="Date of birth" type="date" value={member.dateOfBirth} onChange={(e) => setMember({ ...member, dateOfBirth: e.target.value })} />
          </div>
          <Input label="Relationship" placeholder="e.g. Mother, Son" value={member.relationship} onChange={(e) => setMember({ ...member, relationship: e.target.value })} />
          {memberError && <p className="mb-error-text" role="alert">{memberError}</p>}
        </form>
      </Modal>
    </PatientShell>
  );
}
