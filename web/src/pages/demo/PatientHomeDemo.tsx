import { useState } from 'react';
import {
  Button, Card, ChatBlock, ChatMessage, ChatPanel, ConfirmationCard, DoctorSlotCard, Input, PatientLayout, Pill, TypingIndicator,
} from '../../components';
import { PatientDemoNavbar } from './PatientDemoNav';

const specialities = ['General physician', 'Dermatology', 'Paediatrics', 'Cardiology', 'Orthopaedics', 'Dentistry'];

/** v1 page 1: patient home with booking chatbot. */
export function PatientHomeDemo() {
  const [picked, setPicked] = useState<string | undefined>('ar-1130');
  const [extra, setExtra] = useState<string[]>([]);
  const [typing, setTyping] = useState(false);

  const send = (text: string) => {
    setExtra((m) => [...m, text]);
    setTyping(true);
    setTimeout(() => setTyping(false), 1200);
  };

  return (
    <PatientLayout navbar={<PatientDemoNavbar signedIn={false} />}>
      <div className="mb-home">
        <div>
          <p className="mb-eyebrow">Doctors across Bengaluru</p>
          <h1 className="mb-home__title">Book a doctor by just chatting.</h1>
          <p className="mb-home__lead">
            Tell the assistant your symptoms or the specialist you need. It finds available doctors near you,
            books the slot and keeps every visit under your Patient ID.
          </p>

          <Card style={{ marginTop: 'var(--space-8)', padding: 'var(--space-5)' }}>
            <form className="stack" onSubmit={(e) => e.preventDefault()}>
              <Input label="Already a patient? Enter your Patient ID" placeholder="e.g. MB-24-00731"
                hint="An OTP is sent to your registered mobile number before records open." />
              <div><Button variant="dark" type="submit">View history</Button></div>
            </form>
          </Card>

          <div style={{ marginTop: 'var(--space-8)' }}>
            <p className="mb-label">Popular specialities</p>
            <div className="mb-chips" style={{ marginTop: 'var(--space-3)' }}>
              {specialities.map((s) => <Pill key={s}>{s}</Pill>)}
            </div>
          </div>
        </div>

        <ChatPanel
          title="MediBook Assistant"
          subtitle="Books, reschedules and cancels appointments"
          onSend={send}
          placeholder='Type a message, e.g. "cancel my appointment"'
          disclaimer="For emergencies call 108. The assistant does not give medical diagnoses."
        >
          <ChatMessage from="bot">Hi Rahul! What do you need help with today?</ChatMessage>
          <ChatMessage from="user">I have a skin rash. Need a dermatologist near Jayanagar this Saturday.</ChatMessage>
          <ChatMessage from="bot">I found 2 dermatologists with open slots on Sat, 14 Nov:</ChatMessage>
          <ChatBlock>
            <DoctorSlotCard
              name="Dr. Ananya Rao" meta="Dermatology · Jayanagar 4th Block" fee="₹600" rating="★ 4.8"
              slots={[{ id: 'ar-1000', label: '10:00 AM' }, { id: 'ar-1130', label: '11:30 AM' }, { id: 'ar-1600', label: '4:00 PM' }]}
              selectedId={picked} onPick={setPicked}
            />
            <DoctorSlotCard
              name="Dr. Kiran Shetty" meta="Dermatology · JP Nagar" fee="₹500" rating="★ 4.5"
              slots={[{ id: 'ks-0930', label: '9:30 AM' }, { id: 'ks-1400', label: '2:00 PM' }]}
              selectedId={picked} onPick={setPicked}
            />
          </ChatBlock>
          <ChatMessage from="user">11:30 AM with Dr. Ananya Rao</ChatMessage>
          <ChatBlock>
            <ConfirmationCard
              rows={[
                { label: 'When', value: 'Sat, 14 Nov · 11:30 AM' },
                { label: 'Doctor', value: 'Dr. Ananya Rao' },
                { label: 'Booking ref', value: 'APT-1142' },
                { label: 'Patient ID', value: 'MB-24-00731' },
              ]}
              actions={<><Button variant="secondary" size="sm">Add to calendar</Button><Button variant="secondary" size="sm">Reschedule</Button></>}
            />
          </ChatBlock>
          {extra.map((t, i) => <ChatMessage key={i} from="user">{t}</ChatMessage>)}
          {typing && <TypingIndicator />}
        </ChatPanel>
      </div>
    </PatientLayout>
  );
}
