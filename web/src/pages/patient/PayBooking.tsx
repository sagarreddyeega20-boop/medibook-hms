import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Badge, Button, Card, Icon, Input, OptionTiles, OrDivider, OrderSummary, PaymentMethodCard, ResultCard, TrustNote,
} from '../../components';
import { ApiRequestError, errorMessage } from '../../lib/api';
import { bookingApi, type Appointment } from '../../lib/booking';
import { formatPaise } from '../../lib/format';
import { cardErrors, downloadIcs, newKey, paymentsApi, spaceCard, UPI_ID, type Checkout, type Instrument, type Order } from '../../lib/payments';
import { whenLabel } from '../../lib/time';
import { mmss, useCountdown } from '../../lib/useCountdown';
import { PatientShell } from './PatientShell';

const UPI_APPS = [
  { value: 'Google Pay', label: 'GPay', mark: 'G' },
  { value: 'PhonePe', label: 'PhonePe', mark: 'Pe' },
  { value: 'Paytm', label: 'Paytm', mark: 'P' },
  { value: 'BHIM', label: 'BHIM', mark: 'B' },
];
const BANKS = [
  { value: 'State Bank of India', label: 'SBI', mark: 'S' },
  { value: 'HDFC Bank', label: 'HDFC', mark: 'H' },
  { value: 'ICICI Bank', label: 'ICICI', mark: 'I' },
  { value: 'Axis Bank', label: 'Axis', mark: 'A' },
];
const WALLETS = [
  { value: 'Paytm Wallet', label: 'Paytm', mark: 'P' },
  { value: 'PhonePe Wallet', label: 'PhonePe', mark: 'Pe' },
  { value: 'Amazon Pay', label: 'Amazon Pay', mark: 'a' },
  { value: 'Mobikwik', label: 'Mobikwik', mark: 'M' },
];
/** v1 shows the processing state for at least 2 seconds. */
const MIN_PROCESSING_MS = 2000;

type Method = 'upi' | 'card' | 'netbanking' | 'wallet' | 'hospital';
type View = 'loading' | 'checkout' | 'processing' | 'success' | 'failed' | 'expired';

const storeKey = (holdId: string) => `mb_payorder:${holdId}`;
const readStore = (holdId: string): { key: string; orderId?: string } | null => {
  try { return JSON.parse(sessionStorage.getItem(storeKey(holdId)) ?? 'null'); } catch { return null; }
};
const writeStore = (holdId: string, v: { key: string; orderId?: string }) => {
  try { sessionStorage.setItem(storeKey(holdId), JSON.stringify(v)); } catch { /* private mode: retries still work within this page */ }
};

const methodText = (o: { method: string | null; instrument: string | null; last4: string | null }) =>
  o.method === 'CARD' ? `${o.instrument ?? 'Card'} ···· ${o.last4 ?? ''}` : [o.method === 'NETBANKING' ? 'Net banking' : o.method === 'WALLET' ? 'Wallet' : 'UPI', o.instrument].filter(Boolean).join(' · ');

/**
 * Payment page (v1 payment.html): order summary with the hold countdown on the left, method cards on the right;
 * then processing → payment successful (receipt, add to calendar) | payment failed (retry) | slot expired.
 * "Pay at hospital" confirms the booking straight away. Reached from Find a doctor and from the chat assistant.
 */
export function PayBooking() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const holdId = params.get('hold') ?? '';
  const patientId = params.get('patient') ?? '';
  const fromChat = params.get('from') === 'chat';
  const reason = (location.state as { reason?: string } | null)?.reason;

  const [view, setView] = useState<View>('loading');
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [booked, setBooked] = useState<Appointment | null>(null); // pay at hospital
  const [method, setMethod] = useState<Method>('upi');
  const [upiApp, setUpiApp] = useState<string>();
  const [upiId, setUpiId] = useState('');
  const [bank, setBank] = useState<string>();
  const [wallet, setWallet] = useState<string>();
  const [card, setCard] = useState({ number: '', expiry: '', cvv: '', name: '' });
  const [showErrors, setShowErrors] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { left, start } = useCountdown();
  const done = useRef(false); // paid or booked: the hold must not be released when leaving

  /* ---------- Load the checkout (or resume an order after a reload) ---------- */
  useEffect(() => {
    if (!holdId || !patientId) return void setView('expired');
    let cancelled = false;
    (async () => {
      try {
        const saved = readStore(holdId);
        if (saved?.orderId) {
          const o = await paymentsApi.order(saved.orderId);
          if (cancelled) return;
          setOrder(o);
          if (o.status === 'PAID') { done.current = true; return setView('success'); }
          if (o.status === 'EXPIRED') return setView('expired');
          if (o.status === 'PROCESSING') { setView('processing'); return void poll(o.id, Date.now()); }
        }
        const c = await paymentsApi.checkout(holdId, patientId);
        if (cancelled) return;
        setCheckout(c);
        if (!c.fee) setMethod('hospital');
        start(Math.max(0, Math.floor((new Date(c.holdExpiresAt).getTime() - Date.now()) / 1000)));
        setView('checkout');
      } catch (err) {
        if (!cancelled) setView(err instanceof ApiRequestError && err.error.code === 'HOLD_EXPIRED' ? 'expired' : 'checkout');
        if (!(err instanceof ApiRequestError && err.error.code === 'HOLD_EXPIRED')) setFormError(errorMessage(err));
      }
    })();
    return () => { cancelled = true; };
  }, [holdId, patientId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The hold ran out while choosing or after a failure.
  useEffect(() => {
    if (left === 0 && checkout && (view === 'checkout' || view === 'failed')) setView('expired');
  }, [left, checkout, view]);

  /* ---------- Paying ---------- */
  const poll = async (orderId: string, startedAt: number) => {
    let o: Order;
    for (;;) {
      await new Promise((r) => setTimeout(r, 600));
      o = await paymentsApi.order(orderId);
      if (o.status !== 'PROCESSING') break;
    }
    const wait = MIN_PROCESSING_MS - (Date.now() - startedAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    setOrder(o);
    if (o.status === 'PAID') { done.current = true; setView('success'); }
    else if (o.status === 'EXPIRED') setView('expired');
    else setView('failed');
  };

  const instrument = (): Instrument | string => {
    switch (method) {
      case 'upi': {
        const id = upiId.trim();
        if (id) return UPI_ID.test(id) ? { method: 'UPI', provider: upiApp ?? 'UPI ID', upiId: id } : 'Enter a UPI ID like name@bank.';
        return upiApp ? { method: 'UPI', provider: upiApp } : 'Choose a UPI app or enter your UPI ID.';
      }
      case 'card': {
        const { errors, num, brand } = cardErrors(card);
        if (Object.keys(errors).length || !brand) return 'Check the card details.';
        return { method: 'CARD', provider: brand, last4: num.slice(-4) }; // only the brand and last 4 digits leave the browser
      }
      case 'netbanking':
        return bank ? { method: 'NETBANKING', provider: bank } : 'Choose your bank.';
      case 'wallet':
        return wallet ? { method: 'WALLET', provider: wallet } : 'Choose a wallet.';
      default:
        return 'Choose a payment method.';
    }
  };

  const pay = async () => {
    setShowErrors(true);
    setFormError(null);
    const ins = instrument();
    if (typeof ins === 'string') return setFormError(ins);
    setBusy(true);
    const startedAt = Date.now();
    setView('processing');
    try {
      let o = order;
      if (!o) {
        const saved = readStore(holdId) ?? { key: newKey() };
        writeStore(holdId, saved);
        o = await paymentsApi.createOrder({ holdId, patientId, reason, idempotencyKey: saved.key });
        writeStore(holdId, { ...saved, orderId: o.id });
        setOrder(o);
      }
      if (o.status === 'PAID') { done.current = true; setOrder(o); return setView('success'); }
      o = await paymentsApi.pay(o.id, ins, newKey());
      setOrder(o);
      await poll(o.id, startedAt);
    } catch (err) {
      if (err instanceof ApiRequestError && err.error.code === 'HOLD_EXPIRED') return setView('expired');
      setFormError(errorMessage(err));
      setView('checkout');
    } finally {
      setBusy(false);
    }
  };

  const payAtHospital = async () => {
    setBusy(true);
    setFormError(null);
    try {
      const a = await bookingApi.book(holdId, patientId, reason);
      done.current = true;
      setBooked(a);
      setView('success');
    } catch (err) {
      if (err instanceof ApiRequestError && err.error.code === 'HOLD_EXPIRED') return setView('expired');
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Leaving without paying or booking frees the slot for others. (Deferred, so React's dev double-mount
  // — unmount + immediate remount — does not release it.)
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      setTimeout(() => { if (!alive.current && !done.current && holdId) void bookingApi.release(holdId); }, 0);
    };
  }, [holdId]);

  /* ---------- Render ---------- */
  const backTo = fromChat ? '/patient' : '/patient/doctors';
  const backLabel = fromChat ? 'Back to chat' : 'Back to Find a doctor';
  const fee = checkout?.fee?.amountPaise ?? order?.amountPaise ?? 0;
  const appointment = order?.appointment ?? booked;
  const afterBooking = () => navigate(fromChat && appointment ? `/patient?booked=${encodeURIComponent(appointment.ref)}` : '/patient/appointments');
  const cardCheck = cardErrors(card);
  const cardErr = (k: keyof typeof cardCheck.errors) => (showErrors ? cardCheck.errors[k] : undefined);

  if (view === 'loading') {
    return <PatientShell><ResultCard tone="processing" title="Loading your booking…" /></PatientShell>;
  }

  if (view === 'processing') {
    return (
      <PatientShell>
        <ResultCard tone="processing" title="Processing your payment…"><p>Please don’t close or refresh this window.</p></ResultCard>
      </PatientShell>
    );
  }

  if (view === 'expired') {
    return (
      <PatientShell>
        <ResultCard
          tone="fail"
          title="Slot expired, pick another time"
          actions={
            <>
              <Button onClick={() => navigate(backTo)}>Pick another time</Button>
              <Button variant="secondary" onClick={() => navigate('/patient/appointments')}>My appointments</Button>
            </>
          }
        >
          <p>{order?.failureReason?.includes('refunded') ? order.failureReason : 'The 10-minute hold ran out, so the slot was released for other patients. No money was taken.'}</p>
        </ResultCard>
      </PatientShell>
    );
  }

  if (view === 'success' && appointment) {
    const paid = !!order?.receipt;
    const rows = [
      ...(paid ? [{ label: 'Transaction ID', value: order!.receipt!.transactionId ?? '-' }, { label: 'Receipt', value: order!.receipt!.receiptNumber }] : []),
      { label: paid ? 'Amount paid' : 'Amount due at the hospital', value: <span className="num">{formatPaise(fee)}</span> },
      { label: 'Method', value: paid ? methodText(order!) : 'Pay at hospital' },
      { label: 'Doctor', value: `${appointment.doctor?.name ?? ''}${appointment.doctor?.department?.name ? ` · ${appointment.doctor.department.name}` : ''}` },
      { label: 'When', value: whenLabel(appointment.slotStart) },
      { label: 'Patient', value: `${appointment.patient?.name ?? ''} · ${appointment.patient?.mrn ?? ''}` },
      { label: 'Booking ref', value: appointment.ref },
    ];
    return (
      <PatientShell>
        <ResultCard
          tone="success"
          title={paid ? 'Payment successful' : 'Booking confirmed'}
          rows={rows}
          actions={
            <>
              {paid && <a className="mb-btn mb-btn--secondary" href={`/api/billing/me/payments/${order!.receipt!.paymentId}/pdf`} target="_blank" rel="noopener noreferrer">Download receipt</a>}
              <Button variant="secondary" onClick={() => downloadIcs({ ref: appointment.ref, slotStart: appointment.slotStart, slotEnd: appointment.slotEnd, doctor: appointment.doctor?.name ?? 'your doctor', department: appointment.doctor?.department?.name, mrn: appointment.patient?.mrn })}>
                <Icon name="calendar" size={16} />Add to calendar
              </Button>
              <Button onClick={afterBooking}>{fromChat ? 'Back to chat' : 'Go to My appointments'}</Button>
            </>
          }
        >
          <p>{paid ? 'Your appointment is confirmed. A copy is saved under My appointments.' : `Your booking is confirmed. Pay ${formatPaise(fee)} at the hospital counter on the day.`}</p>
        </ResultCard>
      </PatientShell>
    );
  }

  if (view === 'failed') {
    return (
      <PatientShell>
        <ResultCard
          tone="fail"
          title="Payment failed"
          actions={
            <>
              <Button onClick={() => { setView('checkout'); void pay(); }} loading={busy}>Try again</Button>
              <Button variant="secondary" onClick={() => { setFormError(null); setView('checkout'); }}>Choose another method</Button>
            </>
          }
        >
          <p>{order?.failureReason ?? 'The payment did not go through.'}</p>
          <p>No money was taken. Your slot is still held — <strong>{mmss(left)}</strong> left.</p>
        </ResultCard>
      </PatientShell>
    );
  }

  return (
    <PatientShell>
      <Link to={backTo} className="mb-back"><Icon name="arrowLeft" size={16} />{backLabel}</Link>
      <h1 className="mb-page-title">Complete your booking</h1>
      {checkout ? (
        <div className="mb-pay-grid">
          <OrderSummary
            hold={{ label: 'Slot held for you', remaining: mmss(left), low: left < 60 }}
            doctor={{ name: checkout.doctor.name, speciality: [checkout.doctor.department, checkout.doctor.specialty].filter(Boolean).join(' · ') }}
            details={[
              { label: 'Hospital', value: 'MediBook Hospital' },
              { label: 'Date & time', value: whenLabel(checkout.slotStart) },
              { label: 'Patient', value: `${checkout.patient.name} · ${checkout.patient.mrn}` },
            ]}
            bill={checkout.fee ? [{ label: 'Consultation fee', paise: checkout.fee.amountPaise }] : []}
            totalPaise={fee}
          />

          <Card title="Choose payment method">
            <div className="mb-pm-list" style={{ marginTop: 0 }}>
              {checkout.fee && (
                <>
                  <PaymentMethodCard name="pm" value="upi" checked={method === 'upi'} onSelect={(v) => setMethod(v as Method)} icon="bolt"
                    title="UPI" subtitle="GPay, PhonePe, Paytm, BHIM or any UPI ID" badge={<Badge tone="primary">Recommended</Badge>}>
                    <p className="mb-label">Pay with an app</p>
                    <OptionTiles label="UPI apps" options={UPI_APPS} value={upiApp} onChange={(v) => { setUpiApp(v); setUpiId(''); }} />
                    <OrDivider />
                    <Input label="Pay with UPI ID" placeholder="name@bank" value={upiId} autoComplete="off"
                      onChange={(e) => { setUpiId(e.target.value); setUpiApp(undefined); }}
                      error={showErrors && upiId.trim() && !UPI_ID.test(upiId.trim()) ? 'Enter a UPI ID like name@bank.' : undefined}
                      hint="Demo: fail@upi is declined." />
                  </PaymentMethodCard>
                  <PaymentMethodCard name="pm" value="card" checked={method === 'card'} onSelect={(v) => setMethod(v as Method)} icon="card"
                    title="Credit / Debit card" subtitle="Visa, Mastercard, RuPay"
                    badge={method === 'card' && digits(card.number).length > 0 ? <Badge tone={cardCheck.brand ? 'info' : 'neutral'} className="mb-card-brand">{cardCheck.brand ?? 'Unknown'}</Badge> : undefined}>
                    <Input label="Card number" inputMode="numeric" autoComplete="cc-number" placeholder="1234 5678 9012 3456" maxLength={23}
                      value={card.number} onChange={(e) => setCard({ ...card, number: spaceCard(e.target.value) })} error={cardErr('number')} hint="Demo: a card ending 0002 is declined." />
                    <div className="grid-2">
                      <Input label="Expiry (MM/YY)" inputMode="numeric" autoComplete="cc-exp" placeholder="MM/YY" maxLength={5}
                        value={card.expiry} onChange={(e) => { const d = digits(e.target.value).slice(0, 4); setCard({ ...card, expiry: d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d }); }} error={cardErr('expiry')} />
                      <Input label="CVV" inputMode="numeric" autoComplete="cc-csc" type="password" placeholder="123" maxLength={3}
                        value={card.cvv} onChange={(e) => setCard({ ...card, cvv: digits(e.target.value).slice(0, 3) })} error={cardErr('cvv')} />
                    </div>
                    <Input label="Name on card" autoComplete="cc-name" value={card.name} onChange={(e) => setCard({ ...card, name: e.target.value })} error={cardErr('name')} />
                  </PaymentMethodCard>
                  <PaymentMethodCard name="pm" value="netbanking" checked={method === 'netbanking'} onSelect={(v) => setMethod(v as Method)} icon="bank"
                    title="Net banking" subtitle="All major Indian banks">
                    <OptionTiles label="Banks" options={BANKS} value={bank} onChange={setBank} />
                  </PaymentMethodCard>
                  <PaymentMethodCard name="pm" value="wallet" checked={method === 'wallet'} onSelect={(v) => setMethod(v as Method)} icon="wallet"
                    title="Wallets" subtitle="Paytm, PhonePe, Amazon Pay, Mobikwik">
                    <OptionTiles label="Wallets" options={WALLETS} value={wallet} onChange={setWallet} />
                  </PaymentMethodCard>
                </>
              )}
              <PaymentMethodCard name="pm" value="hospital" checked={method === 'hospital'} onSelect={(v) => setMethod(v as Method)} icon="clinic"
                title="Pay at hospital" subtitle="Cash, card or UPI at the billing counter on the day" />
            </div>
            {formError && <p className="mb-error-text" role="alert" style={{ marginTop: 'var(--space-4)' }}>{formError}</p>}
            {method === 'hospital' ? (
              <Button size="lg" block loading={busy} disabled={left === 0} onClick={payAtHospital} style={{ marginTop: 'var(--space-5)' }}>Confirm booking</Button>
            ) : (
              <Button size="lg" block loading={busy} disabled={left === 0} onClick={pay} style={{ marginTop: 'var(--space-5)' }}>Pay {formatPaise(fee)}</Button>
            )}
            <TrustNote>{method === 'hospital' ? 'Nothing is charged online.' : '100% secure payments · Demo mode'}</TrustNote>
          </Card>
        </div>
      ) : (
        formError && <Card><p className="mb-error-text" role="alert">{formError}</p></Card>
      )}
    </PatientShell>
  );
}

const digits = (v: string) => v.replace(/\D/g, '');
