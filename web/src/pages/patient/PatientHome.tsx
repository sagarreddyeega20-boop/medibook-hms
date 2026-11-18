import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Badge, Button, ChatAppointment, ChatBlock, ChatMessage, ChatPanel, ConfirmationCard, DoctorSlotCard, IdHighlight, Pill, QuickReplies, TypingIndicator,
} from '../../components';
import { errorMessage } from '../../lib/api';
import { parse } from '../../lib/assistant';
import { useAuth } from '../../lib/auth';
import { bookingApi, isUpcoming, type Appointment, type Department, type DirectoryDoctor, type Hold, type HouseholdMember } from '../../lib/booking';
import { formatPaise } from '../../lib/format';
import { keyOf, onDay, relativeDay, sentenceWhen, timeLabel, todayKey, whenLabel } from '../../lib/time';
import { PatientShell } from './PatientShell';

/* Chat items. Every booking action goes through lib/booking (the same API as reception and the forms). */
type Item =
  | { id: number; kind: 'text'; from: 'bot' | 'user'; text: ReactNode }
  | { id: number; kind: 'doctors'; date: string; options: { doctor: DirectoryDoctor; date: string; slots: string[] }[] }
  | { id: number; kind: 'appointments'; list: Appointment[]; cancellable: boolean }
  | { id: number; kind: 'confirmed'; appointment: Appointment }
  | { id: number; kind: 'quick'; options: string[] };

type NewItem = Item extends infer I ? (I extends Item ? Omit<I, 'id'> : never) : never;

const START = ['Book an appointment', 'My appointments', 'Cancel an appointment'];
const MAX_SLOTS = 6;

/** Patient home: v1 hero + Patient ID + speciality pills on the left, the booking assistant on the right. */
export function PatientHome() {
  const { user } = useAuth();
  const first = user?.name.split(' ')[0] ?? '';
  const [items, setItems] = useState<Item[]>([]);
  const [typing, setTyping] = useState(false);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [household, setHousehold] = useState<HouseholdMember[]>([]);
  const nextId = useRef(1);
  const ctx = useRef<{ date?: string; hold?: Hold & { doctor: DirectoryDoctor }; patientId?: string; cancelRef?: Appointment }>({});
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const shownBooking = useRef<string | null>(null);
  const deptsRef = useRef<Department[]>([]);
  deptsRef.current = departments;

  const push = useCallback((...xs: NewItem[]) => {
    setItems((cur) => [...cur.filter((i) => i.kind !== 'quick'), ...xs.map((x) => ({ ...x, id: nextId.current++ }) as Item)]);
  }, []);
  const bot = (text: ReactNode) => ({ kind: 'text' as const, from: 'bot' as const, text });
  const quick = (options: string[]) => ({ kind: 'quick' as const, options });

  const reset = useCallback(() => {
    if (ctx.current.hold) void bookingApi.release(ctx.current.hold.holdId);
    ctx.current = {};
    setItems([]);
    push(bot(`Hi ${first}! What do you need help with today? Tell me your symptoms or the specialist you need.`), quick(START));
  }, [first, push]);

  useEffect(() => {
    bookingApi.departments().then(setDepartments).catch(() => undefined);
    bookingApi.household().then(setHousehold).catch(() => undefined);
    reset();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Back from the payment page: show the confirmation inside the chat.
  useEffect(() => {
    const ref = params.get('booked');
    if (!ref || shownBooking.current === ref) return;
    shownBooking.current = ref;
    setParams({}, { replace: true });
    void busy(async () => {
      const appointment = await bookingApi.byRef(ref);
      push(bot(appointment.payment === 'PAID_ONLINE' ? 'Payment received — you’re all set.' : 'You’re booked.'), { kind: 'confirmed', appointment }, quick(['My appointments', 'Book another']));
    });
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  // Release a pending hold if the patient leaves the page.
  useEffect(() => () => { if (ctx.current.hold) void bookingApi.release(ctx.current.hold.holdId); }, []);

  const busy = async (fn: () => Promise<void>) => {
    setTyping(true);
    try {
      await fn();
    } catch (err) {
      push(bot(errorMessage(err)), quick(START));
    } finally {
      setTyping(false);
    }
  };

  /* ---------- Intents ---------- */

  const showDoctors = (dept: Department, date?: string) =>
    busy(async () => {
      ctx.current.date = date;
      const doctors = await bookingApi.doctors(dept.id, date ?? todayKey());
      const options: { doctor: DirectoryDoctor; date: string; slots: string[] }[] = [];
      for (const d of doctors) {
        const day = date ?? (d.nextFreeSlot ? keyOf(d.nextFreeSlot.start) : undefined);
        if (!day) continue;
        const free = (await bookingApi.slots(d.id, day)).slots.filter((s) => s.bookable).map((s) => s.start);
        if (free.length) options.push({ doctor: d, date: day, slots: free.slice(0, MAX_SLOTS) });
      }
      if (!options.length) {
        const later = doctors.map((d) => d.nextFreeSlot?.start).filter(Boolean).sort()[0];
        push(
          bot(date ? `No ${dept.name} doctor has a free slot ${onDay(date)}.${later ? ` The next free slot is ${sentenceWhen(later)}.` : ''}` : `There are no free ${dept.name} slots in the next two weeks. Please call reception.`),
          quick(later ? [`${dept.name} ${relativeDay(keyOf(later))}`, 'Another speciality'] : ['Another speciality']),
        );
        return;
      }
      push(bot(`I found ${options.length} ${dept.name.toLowerCase()} doctor${options.length > 1 ? 's' : ''} with open slots ${date ? onDay(date) : '(earliest first)'}:`), { kind: 'doctors', date: date ?? '', options });
    });

  const showMine = (forCancel: boolean) =>
    busy(async () => {
      const upcoming = (await bookingApi.mine()).filter(isUpcoming).sort((a, b) => a.slotStart.localeCompare(b.slotStart));
      if (!upcoming.length) return push(bot('You have no upcoming appointments.'), quick(['Book an appointment']));
      push(
        bot(forCancel ? 'Which appointment do you want to cancel?' : `You have ${upcoming.length} upcoming appointment${upcoming.length > 1 ? 's' : ''}:`),
        { kind: 'appointments', list: upcoming, cancellable: true },
        quick(['Book an appointment']),
      );
    });

  const askCancel = (a: Appointment) => {
    ctx.current.cancelRef = a;
    push(bot(<>Cancel <strong>{a.ref}</strong> with {a.doctor?.name} {sentenceWhen(a.slotStart)}?</>), quick([`Yes, cancel ${a.ref}`, 'No, keep it']));
  };

  const cancelByRef = (ref: string) =>
    busy(async () => {
      const a = await bookingApi.byRef(ref);
      if (a.status !== 'BOOKED') return push(bot(`${a.ref} is ${a.status.toLowerCase().replace('_', ' ')}, so it can’t be cancelled here.`), quick(START));
      askCancel(a);
    });

  const doCancel = () =>
    busy(async () => {
      const a = ctx.current.cancelRef;
      if (!a) return;
      ctx.current.cancelRef = undefined;
      await bookingApi.cancel(a.id, 'Cancelled via the MediBook assistant');
      push(bot(<>Done — <strong>{a.ref}</strong> is cancelled and the slot is free for others. A confirmation email is on its way.</>), quick(['Book an appointment', 'My appointments']));
    });

  const pickSlot = (doctor: DirectoryDoctor, slotStart: string) => {
    push({ kind: 'text', from: 'user', text: `${relativeDay(keyOf(slotStart))} ${timeLabel(slotStart)} with ${doctor.name}` });
    void busy(async () => {
      if (ctx.current.hold) await bookingApi.release(ctx.current.hold.holdId);
      const hold = await bookingApi.hold(doctor.id, slotStart);
      ctx.current.hold = { ...hold, doctor };
      const minutes = Math.round(hold.holdSeconds / 60);
      const held = `I’m holding ${sentenceWhen(slotStart)} with ${doctor.name} for ${minutes} minutes.`;
      if (household.length > 1) {
        push(bot(`${held} Who is the appointment for?`), quick([...household.map((h) => `For ${h.patient.name} (${h.relationship})`), 'Pick another time']));
      } else {
        ctx.current.patientId = household[0]?.patient.id;
        askPay(held);
      }
    });
  };

  /** Pay now (payment page) or pay at the hospital (book straight away). */
  const askPay = (lead = '') => {
    const d = ctx.current.hold?.doctor;
    if (!d) return push(bot('Your held slot has expired. Let’s pick a time again.'), quick(START));
    if (d.consultationFeePaise === null) {
      return push(bot(`${lead} The consultation fee is paid at the hospital. Shall I confirm it?`.trim()), quick(['Pay at hospital', 'Pick another time']));
    }
    push(bot(`${lead} The consultation fee is ${formatPaise(d.consultationFeePaise)}. Pay now online, or pay at the hospital on the day?`.trim()), quick(['Pay now', 'Pay at hospital', 'Pick another time']));
  };

  const goPay = () => {
    const hold = ctx.current.hold;
    const patientId = ctx.current.patientId;
    if (!hold || !patientId) return push(bot('Your held slot has expired. Let’s pick a time again.'), quick(START));
    ctx.current.hold = undefined; // the payment page owns the hold now
    navigate(`/patient/pay?${new URLSearchParams({ hold: hold.holdId, patient: patientId, from: 'chat' })}`);
  };

  const confirm = (patientId: string) =>
    busy(async () => {
      const hold = ctx.current.hold;
      if (!hold) return push(bot('Your held slot has expired. Let’s pick a time again.'), quick(START));
      const appointment = await bookingApi.book(hold.holdId, patientId);
      ctx.current.hold = undefined;
      push({ kind: 'confirmed', appointment }, quick(['My appointments', 'Book another']));
    });

  /* ---------- Message router ---------- */

  const handle = (text: string, echo = true) => {
    if (echo) push({ kind: 'text', from: 'user', text });
    const t = text.trim();
    const lower = t.toLowerCase();

    // Answers to the assistant's own questions first.
    if ((lower === 'pay at hospital' || lower === 'confirm booking') && ctx.current.patientId) return void confirm(ctx.current.patientId);
    if (lower === 'pay now' && ctx.current.hold) return goPay();
    const forWho = household.find((h) => lower === `for ${h.patient.name} (${h.relationship})`.toLowerCase());
    if (forWho) { ctx.current.patientId = forWho.patient.id; return askPay(); }
    if (lower === 'pick another time' || lower === 'another speciality' || lower === 'book an appointment' || lower === 'book another') {
      if (ctx.current.hold) { void bookingApi.release(ctx.current.hold.holdId); ctx.current.hold = undefined; }
      return push(bot('Which speciality do you need? You can also just describe your symptoms.'), quick(deptsRef.current.map((d) => d.name)));
    }
    if (/^yes, cancel apt-\d+$/i.test(t)) return void doCancel();
    if (lower === 'no, keep it') { ctx.current.cancelRef = undefined; return push(bot('Okay, your appointment stays as it is.'), quick(START)); }
    if (lower === 'cancel an appointment') return void showMine(true);

    const intent = parse(t, deptsRef.current);
    switch (intent.kind) {
      case 'emergency':
        return push(bot(<><strong>This sounds urgent. Call 108 or go to the nearest emergency department now.</strong> The assistant can’t help with emergencies.</>));
      case 'greet':
        return push(bot(`Hello ${first}! I can book, show or cancel appointments.`), quick(START));
      case 'mine':
        return void showMine(false);
      case 'cancel':
        return void (intent.ref ? cancelByRef(intent.ref) : showMine(true));
      case 'reschedule':
        return push(bot(<>You can move a booking from <Link to="/patient/appointments">My appointments</Link> → Reschedule. Your current slot stays booked until you confirm the new one.</>), quick(START));
      case 'book':
        if (intent.department) {
          if (intent.matched && !intent.department.name.toLowerCase().includes(intent.matched)) push(bot(`For “${intent.matched}”, ${intent.department.name} is the right department.`));
          return void showDoctors(intent.department, intent.date ?? ctx.current.date);
        }
        ctx.current.date = intent.date ?? ctx.current.date;
        return push(bot(`Sure${intent.date ? ` — ${relativeDay(intent.date)}` : ''}. Which speciality do you need? You can also describe your symptoms.`), quick(deptsRef.current.map((d) => d.name)));
      default:
        return push(bot('Sorry, I didn’t catch that. Try “fever since yesterday”, “cardiologist tomorrow”, “my appointments” or “cancel APT-000123”.'), quick(START));
    }
  };

  /* ---------- Render ---------- */

  const render = (it: Item) => {
    switch (it.kind) {
      case 'text':
        return <ChatMessage key={it.id} from={it.from}>{it.text}</ChatMessage>;
      case 'quick':
        return <QuickReplies key={it.id} options={it.options} onPick={(o) => handle(o)} />;
      case 'doctors':
        return (
          <ChatBlock key={it.id}>
            {it.options.map((o) => (
              <DoctorSlotCard
                key={o.doctor.id}
                name={o.doctor.name}
                meta={`${o.doctor.department.name}${o.doctor.specialty ? ` · ${o.doctor.specialty}` : ''}`}
                fee={o.doctor.consultationFeePaise !== null ? formatPaise(o.doctor.consultationFeePaise) : undefined}
                slotsLabel={`Available slots · ${relativeDay(o.date)}`}
                slots={o.slots.map((s) => ({ id: s, label: timeLabel(s) }))}
                selectedId={ctx.current.hold?.slotStart}
                onPick={(s) => pickSlot(o.doctor, s)}
              />
            ))}
          </ChatBlock>
        );
      case 'appointments':
        return (
          <ChatBlock key={it.id}>
            {it.list.map((a) => (
              <ChatAppointment
                key={a.id}
                title={`${a.doctor?.name ?? 'Doctor'} · ${a.doctor?.department?.name ?? ''}`}
                line={`${whenLabel(a.slotStart)} · ${a.ref}${household.length > 1 && a.patient ? ` · ${a.patient.name}` : ''}`}
                status={<Badge status={a.status === 'BOOKED' ? 'CONFIRMED' : a.status} size="sm" />}
                action={it.cancellable && a.status === 'BOOKED' ? <Button variant="danger-outline" size="sm" onClick={() => { push({ kind: 'text', from: 'user', text: `Cancel ${a.ref}` }); askCancel(a); }}>Cancel</Button> : undefined}
              />
            ))}
          </ChatBlock>
        );
      case 'confirmed':
        return (
          <ChatBlock key={it.id}>
            <ConfirmationCard
              rows={[
                { label: 'When', value: whenLabel(it.appointment.slotStart) },
                { label: 'Doctor', value: it.appointment.doctor?.name ?? '' },
                { label: 'Booking ref', value: it.appointment.ref },
                { label: 'Patient ID', value: it.appointment.patient?.mrn ?? '' },
                ...(it.appointment.payment ? [{ label: 'Payment', value: <Badge status={it.appointment.payment} size="sm" /> }] : []),
              ]}
              actions={<Link to="/patient/appointments" className="mb-btn mb-btn--secondary mb-btn--sm">View in My appointments</Link>}
            />
          </ChatBlock>
        );
    }
  };

  return (
    <PatientShell>
      <div className="mb-home">
        <div>
          <p className="mb-eyebrow">MediBook Hospital</p>
          <h1 className="mb-home__title">Book a doctor by just chatting.</h1>
          <p className="mb-home__lead">
            Tell the assistant your symptoms or the specialist you need. It finds doctors with free slots,
            holds your slot and books it under your Patient ID.
          </p>
          <div style={{ marginTop: 'var(--space-8)' }}>
            <IdHighlight label="Your Patient ID" value={user?.mrn ?? ''}>Show this ID at reception on every visit.</IdHighlight>
          </div>
          <div style={{ marginTop: 'var(--space-8)' }}>
            <p className="mb-label">Specialities</p>
            <div className="mb-chips" style={{ marginTop: 'var(--space-3)' }}>
              {departments.map((d) => <Pill key={d.id} onClick={() => handle(`Book ${d.name}`)}>{d.name}</Pill>)}
            </div>
          </div>
        </div>

        <ChatPanel
          title="MediBook Assistant"
          subtitle="Books and cancels appointments"
          online
          headerAction={<Button variant="ghost" size="sm" onClick={reset}>New chat</Button>}
          onSend={(t) => handle(t)}
          placeholder='Type a message, e.g. "skin rash, Saturday"'
          disclaimer="For emergencies call 108. The assistant does not give medical diagnoses."
        >
          {items.map(render)}
          {typing && <TypingIndicator />}
        </ChatPanel>
      </div>
    </PatientShell>
  );
}
