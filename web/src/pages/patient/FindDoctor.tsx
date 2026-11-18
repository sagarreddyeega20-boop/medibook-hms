import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Button, Card, ConfirmationCard, DoctorSlotCard, EmptyState, OrderSummary, PatientGrid, Pill, Select, SideCard, SlotChip, Textarea, TrustNote, useToast,
} from '../../components';
import { errorMessage } from '../../lib/api';
import { bookingApi, type Appointment, type Department, type DirectoryDoctor, type Hold, type HouseholdMember, type PortalSlot } from '../../lib/booking';
import { formatPaise } from '../../lib/format';
import { useLive } from '../../lib/live';
import { addDays, dayLabel, keyOf, relativeDay, timeLabel, todayKey, whenLabel } from '../../lib/time';
import { mmss, useCountdown } from '../../lib/useCountdown';
import { PatientShell } from './PatientShell';

const DAYS = 7;

/** Patient portal: find doctors by department, view free slots, hold (10 min) → confirm. Also handles reschedule. */
export function FindDoctor() {
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const rescheduleId = params.get('reschedule');
  const rescheduleRef = params.get('ref');
  const [departments, setDepartments] = useState<Department[]>([]);
  const deptId = params.get('department') ?? '';
  const [date, setDate] = useState(params.get('date') ?? todayKey());
  const [doctors, setDoctors] = useState<DirectoryDoctor[] | null>(null);
  const [slots, setSlots] = useState<Record<string, PortalSlot[]>>({});
  const [household, setHousehold] = useState<HouseholdMember[]>([]);
  const [hold, setHold] = useState<(Hold & { doctor: DirectoryDoctor }) | null>(null);
  const [patientId, setPatientId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [booked, setBooked] = useState<Appointment | null>(null);
  const { left, start } = useCountdown();

  useEffect(() => {
    bookingApi.departments().then(setDepartments).catch(() => undefined);
    bookingApi.household().then((h) => { setHousehold(h); setPatientId(h[0]?.patient.id ?? ''); }).catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    const docs = await bookingApi.doctors(deptId || undefined, date);
    setDoctors(docs);
    const entries = await Promise.all(docs.map(async (d) => [d.id, (await bookingApi.slots(d.id, date)).slots] as const));
    setSlots(Object.fromEntries(entries));
  }, [deptId, date]);
  useEffect(() => {
    load().catch((err) => toast.error('Could not load doctors', errorMessage(err)));
  }, [load, toast]);
  useLive(['slots:changed'], () => void load().catch(() => undefined));

  // Release an unconfirmed hold when leaving the page.
  const holdRef = useRef<string | null>(null);
  holdRef.current = hold?.holdId ?? null;
  useEffect(() => () => { if (holdRef.current) void bookingApi.release(holdRef.current); }, []);

  const pick = async (doctor: DirectoryDoctor, slotStart: string) => {
    setBusy(true);
    setBooked(null);
    try {
      if (hold) await bookingApi.release(hold.holdId);
      const h = await bookingApi.hold(doctor.id, slotStart);
      setHold({ ...h, doctor });
      start(h.holdSeconds);
    } catch (err) {
      toast.error('That slot is no longer free', errorMessage(err));
      void load();
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!hold) return;
    setBusy(true);
    try {
      const a = rescheduleId ? await bookingApi.reschedule(rescheduleId, hold.holdId) : await bookingApi.book(hold.holdId, patientId, reason);
      setBooked(a);
      setHold(null);
      setReason('');
      if (rescheduleId) setParams(deptId ? { department: deptId } : {});
      void load();
    } catch (err) {
      toast.error('Booking failed', errorMessage(err));
      setHold(null);
      void load();
    } finally {
      setBusy(false);
    }
  };

  /** New bookings go to the payment page (Pay now / Pay at hospital); the hold travels with them. */
  const toPayment = () => {
    if (!hold) return;
    holdRef.current = null; // the payment page owns the hold now
    navigate(`/patient/pay?${new URLSearchParams({ hold: hold.holdId, patient: patientId, from: 'doctors' })}`, { state: { reason } });
  };

  const setDept = (id: string) => setParams({ ...(id ? { department: id } : {}), ...(rescheduleId ? { reschedule: rescheduleId, ref: rescheduleRef ?? '' } : {}) });
  const days = Array.from({ length: DAYS }, (_, i) => addDays(todayKey(), i));
  const fee = hold?.doctor.consultationFeePaise ?? 0;

  return (
    <PatientShell>
      <PatientGrid
        main={
          <div className="stack-lg">
            <div>
              <p className="mb-eyebrow">{rescheduleId ? `Rescheduling ${rescheduleRef ?? ''}` : 'Book an appointment'}</p>
              <h1 className="mb-page-title">Find a doctor</h1>
            </div>
            <Card>
              <div className="stack">
                <p className="mb-label">Department</p>
                <div className="mb-chips" role="group" aria-label="Department">
                  <Pill selected={!deptId} onClick={() => setDept('')}>All</Pill>
                  {departments.map((d) => <Pill key={d.id} selected={deptId === d.id} onClick={() => setDept(d.id)}>{d.name}</Pill>)}
                </div>
                <p className="mb-label">Day</p>
                <div className="mb-chips" role="group" aria-label="Day">
                  {days.map((d) => <SlotChip key={d} selected={d === date} onClick={() => setDate(d)}>{relativeDay(d)}</SlotChip>)}
                </div>
              </div>
            </Card>
            {doctors && doctors.length === 0 && <Card><EmptyState title="No doctors in this department yet" /></Card>}
            {doctors?.map((d) => {
              const free = (slots[d.id] ?? []).filter((s) => s.bookable);
              return (
                <Card key={d.id}>
                  {free.length ? (
                    <DoctorSlotCard
                      name={d.name}
                      meta={`${d.department.name}${d.specialty ? ` · ${d.specialty}` : ''}`}
                      fee={d.consultationFeePaise !== null ? formatPaise(d.consultationFeePaise) : undefined}
                      slots={free.map((s) => ({ id: s.start, label: timeLabel(s.start) }))}
                      selectedId={hold?.doctorId === d.id ? hold.slotStart : undefined}
                      onPick={(id) => void pick(d, id)}
                      slotsLabel={`Free slots · ${relativeDay(date)}`}
                    />
                  ) : (
                    <DoctorSlotCard
                      name={d.name}
                      meta={`${d.department.name}${d.specialty ? ` · ${d.specialty}` : ''}`}
                      fee={d.consultationFeePaise !== null ? formatPaise(d.consultationFeePaise) : undefined}
                      slots={d.nextFreeSlot ? [{ id: keyOf(d.nextFreeSlot.start), label: `Next free: ${dayLabel(keyOf(d.nextFreeSlot.start))}` }] : []}
                      onPick={(k) => setDate(k)}
                      slotsLabel={`No free slots ${relativeDay(date).toLowerCase() === 'today' ? 'today' : `on ${dayLabel(date)}`}`}
                    />
                  )}
                </Card>
              );
            })}
          </div>
        }
        side={
          <>
            {booked ? (
              <SideCard title={rescheduleRef ? 'Rescheduled' : 'Booked'}>
                <ConfirmationCard
                  title={booked.rescheduledFromId ? 'Appointment rescheduled' : 'Appointment confirmed'}
                  rows={[
                    { label: 'When', value: whenLabel(booked.slotStart) },
                    { label: 'Doctor', value: booked.doctor?.name ?? '' },
                    { label: 'Booking ref', value: booked.ref },
                    { label: 'Patient ID', value: booked.patient?.mrn ?? '' },
                  ]}
                  actions={<Button variant="secondary" size="sm" onClick={() => navigate('/patient/appointments')}>My appointments</Button>}
                />
              </SideCard>
            ) : hold ? (
              <>
                <OrderSummary
                  title={rescheduleId ? 'New time' : 'Your booking'}
                  hold={{ label: 'Slot held for', remaining: left > 0 ? mmss(left) : 'expired', low: left < 60 }}
                  doctor={{ name: hold.doctor.name, speciality: hold.doctor.department.name }}
                  details={[{ label: 'When', value: whenLabel(hold.slotStart) }, ...(rescheduleRef ? [{ label: 'Replaces', value: rescheduleRef }] : [])]}
                  bill={rescheduleId ? [] : [{ label: 'Consultation', paise: fee }]}
                  totalPaise={rescheduleId ? 0 : fee}
                />
                <Card>
                  <div className="stack">
                    {!rescheduleId && household.length > 1 && (
                      <Select label="Booking for" value={patientId} options={household.map((h) => ({ value: h.patient.id, label: `${h.patient.name} (${h.relationship})` }))} onChange={(e) => setPatientId(e.target.value)} />
                    )}
                    {!rescheduleId && <Textarea label="Reason for visit (optional)" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}
                    <Button size="lg" block loading={busy} disabled={left === 0 || !patientId} onClick={rescheduleId ? confirm : toPayment}>{rescheduleId ? 'Move my appointment' : 'Continue to payment'}</Button>
                    <Button variant="ghost" block onClick={() => { void bookingApi.release(hold.holdId); setHold(null); }}>Choose another time</Button>
                    {!rescheduleId && <TrustNote>Next: pay online now, or choose to pay at the hospital.</TrustNote>}
                  </div>
                </Card>
              </>
            ) : (
              <SideCard title="How booking works">
                <p className="muted">Pick a free time. We hold it for you for 10 minutes while you confirm, so nobody else can take it.</p>
                {rescheduleId && <p className="muted">Your current appointment {rescheduleRef} stays booked until you confirm the new time. <Link to="/patient/appointments">Keep it</Link></p>}
              </SideCard>
            )}
            <SideCard title="Prefer to chat?" tone="assist">
              <p className="muted">Tell the assistant your symptoms and it suggests the right department.</p>
              <Link to="/patient" className="mb-btn mb-btn--secondary mb-btn--sm">Open the assistant</Link>
            </SideCard>
          </>
        }
      />
    </PatientShell>
  );
}
