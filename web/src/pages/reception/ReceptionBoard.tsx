import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge, Button, Card, DashGrid, DoctorBoardCard, EmptyState, Input, Modal, NowConsultingCard, Pill, PersonList, Select, SlotGrid, SlotLegend,
  StatCard, StatGrid, Textarea, useToast, type SlotCell,
} from '../../components';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatPaise, greeting } from '../../lib/format';
import { useLive } from '../../lib/live';
import { addDays, keyOf, longDayLabel, relativeDay, timeLabel, todayKey, whenLabel } from '../../lib/time';
import { mmss, useCountdown } from '../../lib/useCountdown';
import { StaffLayout } from '../staff/StaffLayout';
import { PatientPicker, type PatientSummary } from './PatientPicker';

type SlotState = 'FREE' | 'HELD' | 'BOOKED' | 'CHECKED_IN' | 'DONE' | 'CANCELLED';
interface PersonRef { id: string; name: string; mrn: string; phone: string | null }
interface BoardSlot {
  start: string;
  end: string;
  state: SlotState;
  past: boolean;
  bookable: boolean;
  heldByMe?: boolean;
  offSchedule?: boolean;
  appointment?: { id: string; ref: string; patientId: string; status: string; tokenNumber: number | null; reason: string | null; source: string };
  patient: PersonRef | null;
  /** Prepaid online at booking (the counter collects only tests and medicines), or refunded after a cancel. */
  payment: 'PAID_ONLINE' | 'REFUNDED' | null;
}
interface QueueItem { visitId: string; token: number | null; type: 'OPD' | 'WALK_IN'; patient: PersonRef | null; slotStart: string | null; arrivedAt: string }
interface BoardDoctor {
  id: string;
  name: string;
  specialty: string | null;
  department: { id: string; code: string; name: string };
  consultationFeePaise: number | null;
  status: string;
  lateByMinutes: number;
  leaveReason: string | null;
  worksToday: boolean;
  current: { visitId: string; token: number | null; type: string; patient: PersonRef | null; since: string | null } | null;
  queue: QueueItem[];
  done: number;
  nextFreeSlot: { start: string; end: string } | null;
  slots: BoardSlot[];
}
interface Board {
  date: string;
  today: string;
  stats: { appointments: number; checkedIn: number; walkIns: number; cancelled: number; doctorsAvailable: number; doctorsOnDuty: number };
  doctors: BoardDoctor[];
}
interface Hold { holdId: string; doctorId: string; slotStart: string; slotEnd: string; holdSeconds: number }
/** A doctor's REFERRAL order waiting to be booked (no clinical reason — reception can't see it). */
interface ReferralToBook {
  orderId: string;
  orderNumber: string;
  priority: string;
  createdAt: string;
  patient: PersonRef | null;
  fromDoctor: { name: string; department: string | null };
  toDepartment: { id: string; name: string };
  toDoctor: { id: string; name: string } | null;
}

const T = (n: number | null | undefined) => (n ? `T${n}` : '—');
const short = (name: string) => {
  const [a, b] = name.split(' ');
  return b ? `${a} ${b[0]}.` : a!;
};

/** RECEPTIONIST home: the live board of every doctor's status, queue and slots. Updates over Socket.IO. */
export function ReceptionBoard() {
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [board, setBoard] = useState<Board | null>(null);
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);
  const [deptId, setDeptId] = useState('');
  const [date, setDate] = useState(todayKey());
  const [doctorId, setDoctorId] = useState<string | null>(null);
  const [slotStart, setSlotStart] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [walkInOpen, setWalkInOpen] = useState(false);
  const [moving, setMoving] = useState<{ appointmentId: string; ref: string; patient: string } | null>(null);
  const [referrals, setReferrals] = useState<ReferralToBook[]>([]);
  const [referral, setReferral] = useState<ReferralToBook | null>(null);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ date, ...(deptId ? { departmentId: deptId } : {}) });
    const [b, r] = await Promise.all([api<Board>(`/api/reception/board?${qs}`), api<{ referrals: ReferralToBook[] }>('/api/reception/referrals')]);
    setBoard(b);
    setReferrals(r.referrals);
  }, [date, deptId]);

  useEffect(() => {
    load().catch((err) => toast.error('Could not load the board', errorMessage(err)));
  }, [load, toast]);
  useEffect(() => {
    api<{ departments: { id: string; name: string; doctorCount: number }[] }>('/api/scheduling/departments')
      .then((r) => setDepartments(r.departments.filter((d) => d.doctorCount > 0)))
      .catch(() => undefined);
  }, []);
  // Any booking, hold, check-in or queue move anywhere → refetch (debounced in useLive).
  useLive(['board:changed'], () => void load().catch(() => undefined));
  // Statuses (running late, off duty) also change with the clock.
  useEffect(() => {
    const t = window.setInterval(() => void load().catch(() => undefined), 60_000);
    return () => window.clearInterval(t);
  }, [load]);

  const doctor = board?.doctors.find((d) => d.id === doctorId) ?? board?.doctors[0] ?? null;
  const slot = doctor?.slots.find((s) => s.start === slotStart) ?? null;

  const cells: SlotCell[] = useMemo(
    () =>
      (doctor?.slots ?? []).map((s) => ({
        id: s.start,
        time: timeLabel(s.start),
        state: s.state,
        past: s.past,
        selected: s.start === slotStart,
        sub: s.patient && s.state !== 'CANCELLED' ? `${s.appointment?.tokenNumber ? `T${s.appointment.tokenNumber} · ` : ''}${short(s.patient.name)}${s.payment === 'PAID_ONLINE' ? ' · Paid' : ''}` : s.heldByMe ? 'Held by you' : s.past && s.state === 'FREE' ? 'Past' : undefined,
        title: s.patient ? `${s.patient.name} · ${s.appointment?.ref}${s.payment === 'PAID_ONLINE' ? ' · paid online' : ''}` : undefined,
      })),
    [doctor, slotStart],
  );

  const first = user?.name.split(' ')[0] ?? '';
  const isToday = date === todayKey();

  return (
    <StaffLayout
      title={`${greeting()}, ${first}`}
      subtitle={`${longDayLabel(todayKey())} · Reception live board`}
      search={{
        placeholder: 'Search MRN, name or phone',
        value: search,
        onChange: setSearch,
      }}
      actions={
        <>
          {search.trim().length >= 2 && <Button variant="secondary" onClick={() => navigate(`/reception/patients?q=${encodeURIComponent(search.trim())}`)}>Find patient</Button>}
          <Button onClick={() => setWalkInOpen(true)}>New walk-in</Button>
        </>
      }
    >
      <StatGrid label="Today at a glance">
        <StatCard label={isToday ? 'Today’s appointments' : `Appointments ${relativeDay(date)}`} value={board?.stats.appointments ?? '—'} />
        <StatCard label="Checked in" value={board?.stats.checkedIn ?? '—'} tone="teal" />
        <StatCard label="Walk-ins" value={board?.stats.walkIns ?? '—'} tone="blue" />
        <StatCard label="Doctors available" value={board ? `${board.stats.doctorsAvailable} / ${board.doctors.length}` : '—'} tone="danger" />
      </StatGrid>

      <DashGrid
        main={
          <>
            {referral && (
              <Card
                title={`Booking referral ${referral.orderNumber}`}
                subtitle={`${referral.patient?.name ?? 'Patient'} → ${referral.toDoctor ? `${referral.toDoctor.name} · ` : ''}${referral.toDepartment.name}. Pick a free slot on the grid.`}
                actions={<><Badge status={referral.priority} size="sm" /><Button variant="ghost" size="sm" onClick={() => setReferral(null)}>Stop</Button></>}
              >
                <p className="muted">From {referral.fromDoctor.name}{referral.fromDoctor.department ? ` (${referral.fromDoctor.department})` : ''}. Once booked, the referral moves to Scheduled and the doctor can open the patient’s timeline.</p>
              </Card>
            )}
            <Card
              title="Doctors"
              subtitle="Status is calculated from schedules, leaves and the queue — it updates live."
              actions={<Badge tone="success" dot size="sm">Live</Badge>}
            >
              <div className="stack">
                <div className="mb-chips" role="group" aria-label="Filter by department">
                  <Pill selected={!deptId} onClick={() => setDeptId('')}>All departments</Pill>
                  {departments.map((d) => <Pill key={d.id} selected={deptId === d.id} onClick={() => setDeptId(d.id)}>{d.name}</Pill>)}
                </div>
                {board && board.doctors.length === 0 ? (
                  <EmptyState title="No doctors here" text="Admins add doctors and their weekly schedules under Doctors & schedules." />
                ) : (
                  <div className="mb-boardgrid">
                    {board?.doctors.map((d) => (
                      <DoctorBoardCard
                        key={d.id}
                        name={d.name}
                        meta={`${d.department.name}${d.specialty ? ` · ${d.specialty}` : ''}`}
                        status={d.status}
                        statusNote={d.status === 'RUNNING_LATE' ? `Queue ${d.lateByMinutes} min behind schedule` : d.status === 'ON_LEAVE' && d.leaveReason ? `On leave: ${d.leaveReason}` : undefined}
                        token={d.current ? T(d.current.token) : undefined}
                        current={d.current?.patient ? short(d.current.patient.name) : undefined}
                        queueCount={d.queue.length}
                        nextFree={d.nextFreeSlot ? whenLabel(d.nextFreeSlot.start) : undefined}
                        selected={doctor?.id === d.id}
                        onSelect={() => { setDoctorId(d.id); setSlotStart(null); }}
                      />
                    ))}
                  </div>
                )}
              </div>
            </Card>

            {doctor && (
              <Card
                title={`Day grid · ${doctor.name}`}
                subtitle={moving ? `Pick a free slot to move ${moving.ref} (${moving.patient}).` : `${relativeDay(date)} · tap a slot to book, check in, cancel or reschedule`}
                actions={
                  <div className="mb-toolbar">
                    <Button variant="secondary" size="sm" disabled={isToday} onClick={() => { setDate(addDays(date, -1)); setSlotStart(null); }} aria-label="Previous day">‹</Button>
                    <Input aria-label="Board date" type="date" value={date} min={todayKey()} onChange={(e) => { if (e.target.value) { setDate(e.target.value); setSlotStart(null); } }} />
                    <Button variant="secondary" size="sm" onClick={() => { setDate(addDays(date, 1)); setSlotStart(null); }} aria-label="Next day">›</Button>
                    {!isToday && <Button variant="link" onClick={() => { setDate(todayKey()); setSlotStart(null); }}>Today</Button>}
                  </div>
                }
              >
                <SlotGrid
                  slots={cells}
                  label={`Slots for ${doctor.name}`}
                  onPick={setSlotStart}
                  empty={doctor.status === 'ON_LEAVE' && isToday ? 'On leave today.' : 'No sessions on this day.'}
                />
                <SlotLegend />
              </Card>
            )}
          </>
        }
        side={
          <>
            {doctor && slot && (
              <SlotPanel
                key={`${doctor.id}:${slot.start}`}
                doctor={doctor}
                slot={slot}
                isToday={isToday}
                moving={moving}
                onMove={setMoving}
                referral={referral && (!referral.toDoctor || referral.toDoctor.id === doctor.id) && referral.toDepartment.id === doctor.department.id ? referral : null}
                onReferralBooked={() => setReferral(null)}
                onClose={() => setSlotStart(null)}
                onChanged={() => void load()}
              />
            )}
            <ReferralsCard
              referrals={referrals}
              active={referral?.orderId ?? null}
              onBook={(r) => {
                setReferral(r);
                setMoving(null);
                setSlotStart(null);
                setDeptId(r.toDepartment.id);
                setDoctorId(r.toDoctor?.id ?? null);
              }}
            />
            {doctor && <QueueCard doctor={doctor} onChanged={() => void load()} />}
            {!doctor && <Card title="Queue"><p className="muted">Select a doctor to see their queue.</p></Card>}
          </>
        }
      />

      <WalkInModal open={walkInOpen} onClose={() => setWalkInOpen(false)} doctors={board?.doctors ?? []} defaultDoctorId={doctor?.id} onDone={() => void load()} />
    </StaffLayout>
  );
}

/* ---------------- Selected slot: book / check in / cancel / reschedule ---------------- */

function SlotPanel({ doctor, slot, isToday, moving, onMove, referral, onReferralBooked, onClose, onChanged }: {
  doctor: BoardDoctor;
  slot: BoardSlot;
  isToday: boolean;
  moving: { appointmentId: string; ref: string; patient: string } | null;
  onMove: (m: { appointmentId: string; ref: string; patient: string } | null) => void;
  referral: ReferralToBook | null;
  onReferralBooked: () => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [hold, setHold] = useState<Hold | null>(null);
  const [patient, setPatient] = useState<PatientSummary | null>(
    referral?.patient ? { id: referral.patient.id, name: referral.patient.name, mrn: referral.patient.mrn, phone: referral.patient.phone, gender: 'UNKNOWN', dateOfBirth: null, email: null, hasPortalAccount: false } : null,
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const { left, start } = useCountdown();

  // Leaving the panel releases an unconfirmed hold so the slot frees up for others.
  const holdRef = useRef<string | null>(null);
  holdRef.current = hold?.holdId ?? null;
  useEffect(() => () => {
    if (holdRef.current) void api(`/api/scheduling/holds/${holdRef.current}`, { method: 'DELETE' }).catch(() => undefined);
  }, []);

  const when = `${relativeDay(keyOf(slot.start))} · ${timeLabel(slot.start)}–${timeLabel(slot.end)}`;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast.error('That didn’t work', errorMessage(err));
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const placeHold = () =>
    run(async () => {
      const { hold: h } = await api<{ hold: Hold }>('/api/scheduling/holds', { json: { doctorId: doctor.id, slotStart: slot.start } });
      setHold(h);
      start(h.holdSeconds);
    });

  const confirm = () =>
    run(async () => {
      if (!hold || !patient) return;
      const forReferral = referral && referral.patient?.id === patient.id ? referral : null;
      const { appointment } = await api<{ appointment: { ref: string } }>('/api/scheduling/appointments', {
        json: { holdId: hold.holdId, patientId: patient.id, reason: reason || undefined, referralOrderId: forReferral?.orderId },
      });
      setHold(null);
      toast.success(`Booked ${appointment.ref}`, `${patient.name} with ${doctor.name}, ${when}.${forReferral ? ` Referral ${forReferral.orderNumber} is now scheduled.` : ''}`);
      if (forReferral) onReferralBooked();
      onChanged();
    });

  const moveHere = () =>
    run(async () => {
      if (!moving) return;
      const { hold: h } = await api<{ hold: Hold }>('/api/scheduling/holds', { json: { doctorId: doctor.id, slotStart: slot.start } });
      const { appointment } = await api<{ appointment: { ref: string } }>(`/api/scheduling/appointments/${moving.appointmentId}/reschedule`, { json: { holdId: h.holdId } });
      toast.success('Rescheduled', `${moving.ref} is now ${appointment.ref}, ${when}. The patient was emailed.`);
      onMove(null);
      onChanged();
    });

  const checkIn = () =>
    run(async () => {
      const r = await api<{ token: number; ref: string }>('/api/reception/check-in', { json: { appointmentId: slot.appointment!.id } });
      toast.show({ tone: 'success', title: `Token T${r.token} issued`, message: `${slot.patient?.name} is checked in for ${doctor.name}.` }, 6000);
      onChanged();
    });

  const cancel = () =>
    run(async () => {
      await api(`/api/scheduling/appointments/${slot.appointment!.id}/cancel`, { json: { reason: cancelReason } });
      setCancelOpen(false);
      toast.success(`${slot.appointment!.ref} cancelled`, 'The slot is free again and the patient was emailed.');
      onChanged();
    });

  const a = slot.appointment;
  const active = a && slot.state !== 'CANCELLED';
  return (
    <Card title={timeLabel(slot.start)} subtitle={`${doctor.name} · ${when}`} actions={<Button variant="ghost" size="sm" onClick={onClose}>Close</Button>}>
      <div className="stack">
        <div className="row">{slot.state === 'HELD' ? <Badge tone="pending">{slot.heldByMe ? 'Held by you' : 'Held'}</Badge> : <Badge status={slot.state === 'FREE' ? 'FREE' : slot.state} />}{slot.payment && <Badge status={slot.payment} />}{slot.past && <Badge tone="neutral" size="sm">Past</Badge>}</div>

        {active && slot.patient && (
          <PersonList items={[{ key: 'p', name: slot.patient.name, sub: `${slot.patient.mrn}${slot.patient.phone ? ` · ${slot.patient.phone}` : ''}`, action: <Badge status={a.source} size="sm" /> }]} />
        )}
        {active && (
          <p className="muted">Ref <strong>{a.ref}</strong>{a.tokenNumber ? <> · Token <strong>T{a.tokenNumber}</strong></> : null}{a.reason ? <> · {a.reason}</> : null}</p>
        )}
        {active && a.status === 'BOOKED' && (
          <div className="row">
            {isToday && <Button loading={busy} onClick={checkIn}>Check in</Button>}
            <Button variant="secondary" disabled={busy} onClick={() => onMove({ appointmentId: a.id, ref: a.ref, patient: slot.patient?.name ?? '' })}>Reschedule</Button>
            <Button variant="danger-outline" disabled={busy} onClick={() => setCancelOpen(true)}>Cancel</Button>
          </div>
        )}
        {moving && active && a.id === moving.appointmentId && (
          <p className="muted">Now pick a free slot on the grid (any doctor or day) for {moving.ref}. <Button variant="link" onClick={() => onMove(null)}>Stop</Button></p>
        )}

        {slot.state === 'CANCELLED' && a && <p className="muted">{a.ref} was cancelled. The slot can be booked again.</p>}
        {slot.state === 'HELD' && !slot.heldByMe && <p className="muted">Someone is booking this slot right now (held for up to 10 minutes).</p>}

        {slot.bookable && moving && (
          <Button loading={busy} onClick={moveHere}>Move {moving.ref} here</Button>
        )}
        {slot.bookable && !moving && !hold && (
          <>
            {referral && <p className="muted">For referral <strong>{referral.orderNumber}</strong> · {referral.patient?.name}</p>}
            <p className="muted">Free · {doctor.consultationFeePaise !== null ? `Consultation ${formatPaise(doctor.consultationFeePaise)}` : 'No fee set'}</p>
            <div><Button loading={busy} onClick={placeHold}>Hold &amp; book this slot</Button></div>
          </>
        )}
        {hold && (
          <>
            <div className={`mb-hold${left < 60 ? ' is-low' : ''}`} role="timer">Held for you <strong>{left > 0 ? mmss(left) : 'expired'}</strong></div>
            <PatientPicker selected={patient} onPick={setPatient} autoFocus />
            <Textarea label="Reason (optional)" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            <div className="row">
              <Button loading={busy} disabled={!patient || left === 0} onClick={confirm}>Confirm booking</Button>
              <Button variant="ghost" onClick={() => { void api(`/api/scheduling/holds/${hold.holdId}`, { method: 'DELETE' }); setHold(null); onChanged(); }}>Release</Button>
            </div>
          </>
        )}
      </div>

      <Modal
        open={cancelOpen}
        title={`Cancel ${a?.ref ?? ''}`}
        onClose={() => setCancelOpen(false)}
        footer={<><Button variant="secondary" onClick={() => setCancelOpen(false)}>Keep it</Button><Button variant="danger" loading={busy} disabled={cancelReason.trim().length < 3} onClick={cancel}>Cancel appointment</Button></>}
      >
        <Textarea label="Reason" placeholder="e.g. Patient called to cancel" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} autoFocus />
      </Modal>
    </Card>
  );
}

/* ---------------- Queue for the selected doctor ---------------- */

function QueueCard({ doctor, onChanged }: { doctor: BoardDoctor; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (visitId: string, action: 'call' | 'finish') => {
    setBusy(visitId);
    try {
      await api(`/api/reception/visits/${visitId}/${action}`, { method: 'POST' });
      onChanged();
    } catch (err) {
      toast.error('Queue not updated', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const c = doctor.current;
  return (
    <>
      <NowConsultingCard
        title={`Now with ${doctor.name}`}
        patient={c?.patient ? { name: c.patient.name, meta: `${c.patient.mrn} · ${c.type === 'WALK_IN' ? 'Walk-in' : 'Appointment'}`, status: 'IN_CONSULTATION' } : undefined}
        facts={c ? [`Token ${T(c.token)}`, c.since ? `Since ${timeLabel(c.since)}` : '', `${doctor.done} seen today`].filter(Boolean) : undefined}
        emptyText={doctor.status === 'ON_LEAVE' ? 'On leave.' : 'No one is with the doctor right now. Call in the next token from the queue.'}
      >
        {c && <div className="row"><Button size="sm" loading={busy === c.visitId} onClick={() => void act(c.visitId, 'finish')}>Mark consultation done</Button></div>}
      </NowConsultingCard>
      <Card title="Waiting" subtitle={`${doctor.queue.length} in queue${doctor.status === 'RUNNING_LATE' ? ` · ${doctor.lateByMinutes} min behind` : ''}`}>
        {doctor.queue.length ? (
          <ul className="mb-queue">
            {doctor.queue.map((q, i) => (
              <li key={q.visitId}>
                <span className="mb-token">{T(q.token)}</span>
                <div>
                  <strong>{q.patient?.name ?? 'Patient'}</strong>
                  <span>{q.type === 'WALK_IN' ? 'Walk-in' : `Booked ${q.slotStart ? timeLabel(q.slotStart) : ''}`} · arrived {timeLabel(q.arrivedAt)}</span>
                </div>
                {i === 0 && !c ? (
                  <Button size="sm" loading={busy === q.visitId} onClick={() => void act(q.visitId, 'call')}>Call in</Button>
                ) : (
                  <Badge status={q.type} size="sm" />
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Nobody waiting. Checked-in patients and walk-ins appear here with their token.</p>
        )}
      </Card>
    </>
  );
}

/* ---------------- Walk-in: patient → doctor → WALK_IN visit + token (no appointment) ---------------- */

function WalkInModal({ open, onClose, doctors, defaultDoctorId, onDone }: { open: boolean; onClose: () => void; doctors: BoardDoctor[]; defaultDoctorId?: string; onDone: () => void }) {
  const toast = useToast();
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [doctorId, setDoctorId] = useState('');
  const [complaint, setComplaint] = useState('');
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ token: number; doctor: string; patient: string } | null>(null);

  useEffect(() => {
    if (open) {
      setPatient(null);
      setComplaint('');
      setIssued(null);
      setDoctorId(defaultDoctorId ?? '');
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!patient || !doctorId) return;
    setBusy(true);
    try {
      const r = await api<{ token: number; doctor: { name: string }; patient: { name: string } }>('/api/reception/walk-ins', { json: { patientId: patient.id, doctorId, complaint: complaint || undefined } });
      setIssued({ token: r.token, doctor: r.doctor.name, patient: r.patient.name });
      onDone();
    } catch (err) {
      toast.error('Walk-in not registered', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const options = doctors.map((d) => ({ value: d.id, label: `${d.name} · ${d.department.name} · ${d.status.replace(/_/g, ' ').toLowerCase()} · ${d.queue.length} waiting`, disabled: d.status === 'ON_LEAVE' }));
  return (
    <Modal
      open={open}
      title={issued ? 'Walk-in registered' : 'New walk-in'}
      onClose={onClose}
      footer={issued ? <Button onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!patient || !doctorId} onClick={submit}>Issue token</Button></>}
    >
      {issued ? (
        <div className="stack mb-issued">
          <span className="mb-token mb-token--lg">T{issued.token}</span>
          <p><strong>{issued.patient}</strong> is in the queue for <strong>{issued.doctor}</strong>.</p>
          <p className="muted">A walk-in visit was opened — no appointment was created.</p>
        </div>
      ) : (
        <div className="stack">
          <PatientPicker selected={patient} onPick={setPatient} autoFocus />
          <Select label="Doctor" value={doctorId} placeholder="Choose a doctor…" options={options} onChange={(e) => setDoctorId(e.target.value)} />
          <Textarea label="Complaint (optional)" rows={2} value={complaint} onChange={(e) => setComplaint(e.target.value)} />
        </div>
      )}
    </Modal>
  );
}

/* ---------------- Referrals from doctors waiting to be booked ---------------- */

function ReferralsCard({ referrals, active, onBook }: { referrals: ReferralToBook[]; active: string | null; onBook: (r: ReferralToBook) => void }) {
  return (
    <Card title="Referrals to book" subtitle="Doctors' referrals — book each with the department (or doctor) named." actions={referrals.length ? <Badge status="TO_BOOK" size="sm">{referrals.length} to book</Badge> : undefined}>
      {referrals.length ? (
        <PersonList
          items={referrals.map((r) => ({
            key: r.orderId,
            name: <>{r.patient?.name ?? 'Patient'} {r.priority !== 'ROUTINE' && <Badge status={r.priority} size="sm" />}</>,
            sub: `${r.patient?.mrn ?? ''} · ${r.fromDoctor.name} → ${r.toDoctor ? `${r.toDoctor.name}, ` : ''}${r.toDepartment.name} · ${whenLabel(r.createdAt)}`,
            action: active === r.orderId ? <Badge tone="primary" size="sm">Booking…</Badge> : <Button variant="link" onClick={() => onBook(r)}>Book</Button>,
          }))}
        />
      ) : (
        <p className="muted">No referrals waiting. When a doctor refers a patient, it appears here to book.</p>
      )}
    </Card>
  );
}
