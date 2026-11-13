import { useNavigate } from 'react-router-dom';
import { Badge, ChatAppointment, ChatBlock, ChatMessage, ChatPanel, QuickReplies } from '../../components';

/** v1 page 4: the assistant on a phone (shown in a 390px frame). */
export function MobileChatDemo() {
  const navigate = useNavigate();
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 'var(--space-6) var(--space-4)' }}>
      <div style={{ width: 'min(390px, 100%)', height: 760, border: '1px solid var(--border)', borderRadius: 'var(--radius-card)', overflow: 'hidden', boxShadow: 'var(--shadow-md)' }}>
        <ChatPanel variant="mobile" title="MediBook Assistant" subtitle="ID MB-24-00731" onBack={() => navigate(-1)} placeholder="Type a message">
          <ChatMessage from="bot">What would you like to do?</ChatMessage>
          <QuickReplies options={['Book appointment', 'My appointments', 'Past consultations']} />
          <ChatMessage from="user">My appointments</ChatMessage>
          <ChatMessage from="bot">You have 2 upcoming visits:</ChatMessage>
          <ChatBlock>
            <ChatAppointment title="Dr. Ananya Rao" line="Dermatology · Sat 14 Nov, 11:30 AM" status={<Badge status="CONFIRMED" />} />
            <ChatAppointment title="Dr. Suresh Nayak" line="General physician · Sat 21 Nov, 6:00 PM" status={<Badge status="AWAITING">Awaiting</Badge>} />
          </ChatBlock>
          <ChatMessage from="bot">Want to reschedule or cancel either one?</ChatMessage>
        </ChatPanel>
      </div>
    </div>
  );
}
