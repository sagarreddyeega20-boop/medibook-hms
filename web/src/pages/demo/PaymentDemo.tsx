import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Badge, Button, Card, Icon, Input, OptionTiles, OrDivider, OrderSummary, PatientLayout, PaymentMethodCard, ResultCard, TrustNote,
} from '../../components';
import { formatPaise } from '../../lib/format';
import { PatientDemoNavbar } from './PatientDemoNav';

const upiApps = [
  { value: 'gpay', label: 'GPay', mark: 'G' },
  { value: 'phonepe', label: 'PhonePe', mark: 'Pe' },
  { value: 'paytm', label: 'Paytm', mark: 'P' },
  { value: 'bhim', label: 'BHIM', mark: 'B' },
];

const TOTAL = 62400; // paise

/** v1 payment page: order summary card + payment method cards. */
export function PaymentDemo() {
  const [method, setMethod] = useState('upi');
  const [app, setApp] = useState<string>();

  return (
    <PatientLayout navbar={<PatientDemoNavbar />}>
      <Link to="/demo/patient" className="mb-back"><Icon name="arrowLeft" size={16} />Back to chat</Link>
      <h1 className="mb-page-title">Complete your booking</h1>

      <div className="mb-pay-grid">
        <OrderSummary
          hold={{ label: 'Slot held for you', remaining: '09:59' }}
          doctor={{ name: 'Dr. Ananya Rao', speciality: 'Dermatology' }}
          details={[
            { label: 'Clinic', value: 'Skin Care Clinic, Jayanagar 4th Block' },
            { label: 'Date & time', value: 'Sat, 14 Nov · 11:30 AM' },
            { label: 'Patient', value: 'Rahul Kumar · MB-24-00731' },
            { label: 'Booking ref', value: 'APT-1142' },
          ]}
          bill={[
            { label: 'Consultation fee', paise: 60000 },
            { label: 'Platform fee', paise: 2000 },
            { label: 'GST (18% on platform fee)', paise: 400 },
          ]}
          totalPaise={TOTAL}
        />

        <Card title="Choose payment method">
          <div className="mb-pm-list" style={{ marginTop: 0 }}>
            <PaymentMethodCard name="pm" value="upi" checked={method === 'upi'} onSelect={setMethod} icon="bolt"
              title="UPI" subtitle="GPay, PhonePe, Paytm, BHIM or any UPI ID" badge={<Badge tone="primary">Recommended</Badge>}>
              <p className="mb-label">Pay with an app</p>
              <OptionTiles label="UPI apps" options={upiApps} value={app} onChange={setApp} />
              <OrDivider />
              <Input label="Pay with UPI ID" placeholder="name@bank" />
              <div><Button variant="link">Show QR code</Button></div>
            </PaymentMethodCard>
            <PaymentMethodCard name="pm" value="card" checked={method === 'card'} onSelect={setMethod} icon="card"
              title="Credit / Debit card" subtitle="Visa, Mastercard, RuPay">
              <p className="muted">Card details are entered on the payment gateway’s secure page.</p>
            </PaymentMethodCard>
            <PaymentMethodCard name="pm" value="netbanking" checked={method === 'netbanking'} onSelect={setMethod} icon="bank"
              title="Net banking" subtitle="All major Indian banks" />
            <PaymentMethodCard name="pm" value="wallet" checked={method === 'wallet'} onSelect={setMethod} icon="wallet"
              title="Wallets" subtitle="Paytm, PhonePe, Amazon Pay, Mobikwik" />
            <PaymentMethodCard name="pm" value="clinic" checked={method === 'clinic'} onSelect={setMethod} icon="clinic"
              title="Pay at clinic" subtitle="Cash, card or UPI at the reception" />
          </div>
          <Button size="lg" block style={{ marginTop: 'var(--space-5)' }}>Pay {formatPaise(TOTAL)}</Button>
          <TrustNote>100% secure payments · Demo mode</TrustNote>
        </Card>
      </div>

      <h2 className="mb-page-title" style={{ marginTop: 'var(--space-10, 40px)' }}>Result screens</h2>
      <div className="stack-lg">
        <ResultCard tone="processing" title="Processing your payment…"><p>Please don’t close or refresh this window.</p></ResultCard>
        <ResultCard
          tone="success"
          title="Payment successful"
          rows={[
            { label: 'Transaction ID', value: 'sim_pay_4f2a9c1e' },
            { label: 'Amount paid', value: formatPaise(TOTAL) },
            { label: 'Method', value: 'UPI · Google Pay' },
            { label: 'Booking ref', value: 'APT-1142' },
          ]}
          actions={<><Button variant="secondary">Download receipt</Button><Button variant="secondary"><Icon name="calendar" size={16} />Add to calendar</Button><Button>Go to My appointments</Button></>}
        >
          <p>Your appointment is confirmed. A copy is saved under My appointments.</p>
        </ResultCard>
        <ResultCard tone="fail" title="Payment failed" actions={<><Button>Try again</Button><Button variant="secondary">Choose another method</Button></>}>
          <p>The UPI payment was declined by your bank.</p>
          <p>No money was taken. Your slot is still held — <strong>7:42</strong> left.</p>
        </ResultCard>
      </div>
    </PatientLayout>
  );
}
