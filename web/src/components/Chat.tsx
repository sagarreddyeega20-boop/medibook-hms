import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { cx } from '../lib/cx';
import { initials } from '../lib/format';
import { Icon } from './Icon';

/* ---------- Chat panel ---------- */

interface ChatPanelProps {
  title: string;                 // "MediBook Assistant"
  subtitle?: ReactNode;          // "Books, reschedules and cancels appointments"
  online?: boolean;
  headerAction?: ReactNode;      // "New chat"
  onSend?: (text: string) => void;
  placeholder?: string;
  disclaimer?: ReactNode;
  /** Mobile header (v1 page 4): teal bar with a back button. */
  variant?: 'panel' | 'mobile';
  onBack?: () => void;
  children: ReactNode;           // ChatMessage, cards, QuickReplies…
}

/** v1 chat card: header, scrolling message list, composer with teal send button. */
export function ChatPanel({ title, subtitle, online, headerAction, onSend, placeholder = 'Type a message', disclaimer, variant = 'panel', onBack, children }: ChatPanelProps) {
  const [text, setText] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [children]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    onSend?.(t);
    setText('');
  };

  return (
    <section className={cx('mb-card mb-chat', variant === 'mobile' && 'mb-chat--mobile')} aria-label={title}>
      <header className="mb-chat__head">
        {variant === 'mobile' ? (
          onBack && <button type="button" className="mb-chat__back" onClick={onBack} aria-label="Back"><Icon name="chevronLeft" /></button>
        ) : (
          <span className="mb-avatar" aria-hidden="true"><Icon name="chat" size={16} /></span>
        )}
        <div className="mb-chat__titles">
          <p className="mb-chat__title">{title}</p>
          {(subtitle || online) && (
            <p className="mb-chat__sub">
              {online && <span className="mb-chat__online" aria-hidden="true" />}
              {subtitle}
            </p>
          )}
        </div>
        {headerAction && <div className="mb-chat__action">{headerAction}</div>}
      </header>

      <div className="mb-chat__body" ref={bodyRef} role="log" aria-live="polite">
        {children}
      </div>

      <form className="mb-chat__composer" onSubmit={submit}>
        <label className="sr-only" htmlFor="mb-chat-input">Message</label>
        <input id="mb-chat-input" className="mb-input" value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} autoComplete="off" />
        <button type="submit" className="mb-chat__send" disabled={!text.trim()} aria-label="Send"><Icon name="send" size={18} /></button>
      </form>
      {disclaimer && <p className="mb-chat__disclaimer">{disclaimer}</p>}
    </section>
  );
}

/** A chat bubble. Bot = light grey left, user = teal right. Pass `card` content (doctor/slot cards) as children. */
export function ChatMessage({ from, children }: { from: 'bot' | 'user'; children: ReactNode }) {
  return (
    <div className={cx('mb-msg', `mb-msg--${from}`)}>
      <div className="mb-bubble">{children}</div>
    </div>
  );
}

/** Non-bubble content in the bot column (doctor cards, confirmation, appointment lists). */
export function ChatBlock({ children }: { children: ReactNode }) {
  return <div className="mb-msg mb-msg--bot mb-msg--block">{children}</div>;
}

export function TypingIndicator() {
  return (
    <div className="mb-msg mb-msg--bot">
      <div className="mb-bubble mb-typing" aria-label="Assistant is typing"><span /><span /><span /></div>
    </div>
  );
}

/* ---------- Slot chips & doctor card ---------- */

export function SlotChip({ children, selected, disabled, onClick }: { children: ReactNode; selected?: boolean; disabled?: boolean; onClick?: () => void }) {
  return (
    <button type="button" className="mb-chip" aria-pressed={selected} disabled={disabled} onClick={onClick}>{children}</button>
  );
}

interface DoctorSlotCardProps {
  name: string;
  meta: ReactNode;              // "Dermatology · Jayanagar 4th Block"
  fee?: ReactNode;              // "₹600"
  rating?: ReactNode;           // "★ 4.8"
  slots: { id: string; label: string }[];
  selectedId?: string;
  onPick?: (slotId: string) => void;
  slotsLabel?: string;
}

/** v1 doctor card inside the chat: initials tile, name, meta, fee, and a row of slot chips. */
export function DoctorSlotCard({ name, meta, fee, rating, slots, selectedId, onPick, slotsLabel = 'Available slots' }: DoctorSlotCardProps) {
  return (
    <div className="mb-doccard">
      <div className="mb-doccard__head">
        <span className="mb-initials" aria-hidden="true">{initials(name)}</span>
        <div>
          <p className="mb-doccard__name">{name}</p>
          <p className="mb-doccard__meta">{meta}</p>
        </div>
        {(fee || rating) && (
          <p className="mb-doccard__fee"><strong>{fee}</strong>{rating}</p>
        )}
      </div>
      <p className="mb-doccard__slots-label">{slotsLabel}</p>
      <div className="mb-chips" role="group" aria-label={`${slotsLabel} with ${name}`}>
        {slots.map((s) => (
          <SlotChip key={s.id} selected={s.id === selectedId} onClick={() => onPick?.(s.id)}>{s.label}</SlotChip>
        ))}
      </div>
    </div>
  );
}

/* ---------- Confirmation card & quick replies ---------- */

export function ConfirmationCard({ title = 'Appointment confirmed', rows, actions }: { title?: string; rows: { label: string; value: ReactNode }[]; actions?: ReactNode }) {
  return (
    <div className="mb-confirm">
      <p className="mb-confirm__title"><span className="mb-confirm__check" aria-hidden="true"><Icon name="check" size={14} strokeWidth={3} /></span>{title}</p>
      <dl className="mb-rows mb-rows--compact">
        {rows.map((r) => (
          <div key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></div>
        ))}
      </dl>
      {actions && <div className="row mb-confirm__actions">{actions}</div>}
    </div>
  );
}

export function QuickReplies({ options, onPick }: { options: string[]; onPick?: (option: string) => void }) {
  return (
    <div className="mb-msg mb-msg--bot mb-msg--block">
      <div className="mb-chips">
        {options.map((o) => <SlotChip key={o} onClick={() => onPick?.(o)}>{o}</SlotChip>)}
      </div>
    </div>
  );
}

/** Compact appointment row used inside the chat ("You have 2 upcoming visits"). */
export function ChatAppointment({ title, line, status, action }: { title: ReactNode; line: ReactNode; status?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-chatappt">
      <div>
        <strong>{title}</strong>
        <span>{line}</span>
      </div>
      {status}
      {action}
    </div>
  );
}
