import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Badge, Button, Card, DashGrid, EmptyState, Input, Modal, PaymentMethodCard, PersonCell, Select, StatCard, StatGrid, SummaryRows, Table, Textarea, TrustNote, useToast, type Column,
} from '../../components';
import { ApiRequestError, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  billingApi, METHOD_LABELS, newIdempotencyKey, openPdf, paiseToInput, rupeesInputToPaise,
  type InvoiceDetail, type InvoiceLine, type InvoiceSummary, type PatientAccount, type PaymentMethod, type Receipt,
} from '../../lib/billing';
import { formatPaise } from '../../lib/format';
import { useLive } from '../../lib/live';
import { whenLabel } from '../../lib/time';
import { StaffLayout } from '../staff/StaffLayout';

const METHODS: { value: PaymentMethod; icon: 'wallet' | 'bolt' | 'card'; title: string; subtitle: string; refLabel?: string; refHint?: string }[] = [
  { value: 'CASH', icon: 'wallet', title: 'Cash', subtitle: 'Counted at the counter' },
  { value: 'UPI', icon: 'bolt', title: 'UPI', subtitle: 'Scan & pay at the counter', refLabel: 'UPI transaction ID', refHint: '12-digit UTR from the payer’s app' },
  { value: 'CARD', icon: 'card', title: 'Card', subtitle: 'Debit / credit card on the POS machine', refLabel: 'Card last 4 digits / approval code', refHint: 'From the POS slip' },
];

/** Billing counter — one patient: their bills (one per visit), take a payment across several bills, print receipts, request refunds. */
export function PatientBill() {
  const { patientId = '' } = useParams();
  const { user } = useAuth();
  const toast = useToast();
  const canRefund = !!user?.permissions.includes('refunds:request');
  const [data, setData] = useState<PatientAccount | null>(null);
  /** invoiceId → amount typed (rupees). Selected = present. */
  const [apply, setApply] = useState<Record<string, string>>({});
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [reference, setReference] = useState('');
  const [attemptKey, setAttemptKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Receipt | null>(null);
  const [viewing, setViewing] = useState<InvoiceDetail | null>(null);
  const [refunding, setRefunding] = useState<Receipt | null>(null);

  const load = useCallback(async () => {
    const d = await billingApi.patient(patientId);
    setData(d);
    return d;
  }, [patientId]);
  useEffect(() => {
    load()
      .then((d) => setApply(Object.fromEntries(d.invoices.filter((i) => i.balancePaise > 0).map((i) => [i.id, paiseToInput(i.balancePaise)]))))
      .catch((err) => toast.error('Could not load this patient’s bills', errorMessage(err)));
  }, [load, toast]);
  useLive(['billing:changed'], () => {
    if (!busy) void load().catch(() => undefined);
  });

  // Any change to what is being paid is a new payment attempt (a new key); a retry of the same attempt keeps it.
  const freshAttempt = () => setAttemptKey(newIdempotencyKey());

  const unpaid = useMemo(() => (data?.invoices ?? []).filter((i) => i.balancePaise > 0), [data]);
  const lines = unpaid
    .filter((i) => apply[i.id] !== undefined)
    .map((i) => ({ invoice: i, paise: rupeesInputToPaise(apply[i.id]!) }));
  const invalid = lines.find((l) => l.paise === null || l.paise <= 0 || l.paise > l.invoice.balancePaise);
  const totalPaise = lines.reduce((n, l) => n + (l.paise ?? 0), 0);
  const m = METHODS.find((x) => x.value === method)!;
  const needsRef = method !== 'CASH' && !reference.trim();

  const toggle = (inv: InvoiceSummary) => {
    freshAttempt();
    setApply((a) => {
      const next = { ...a };
      if (next[inv.id] !== undefined) delete next[inv.id];
      else next[inv.id] = paiseToInput(inv.balancePaise);
      return next;
    });
  };

  const pay = async () => {
    if (!data || !lines.length || invalid || needsRef) return;
    setBusy(true);
    try {
      const out = await billingApi.pay({
        patientId, method, reference: method === 'CASH' ? null : reference.trim(), idempotencyKey: attemptKey,
        allocations: lines.map((l) => ({ invoiceId: l.invoice.id, amountPaise: l.paise! })),
      });
      setDone(out.payment);
      freshAttempt();
      setReference('');
      const d = await load();
      setApply(Object.fromEntries(d.invoices.filter((i) => i.balancePaise > 0).map((i) => [i.id, paiseToInput(i.balancePaise)])));
    } catch (err) {
      // Network failure: keep the key so pressing the button again cannot record the payment twice.
      if (err instanceof ApiRequestError && err.status < 500) freshAttempt();
      toast.error('Payment not recorded', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const view = async (id: string) => {
    try {
      setViewing(await billingApi.invoice(id));
    } catch (err) {
      toast.error('Could not open the bill', errorMessage(err));
    }
  };

  const invoiceColumns: Column<InvoiceSummary>[] = [
    {
      key: 'pick', header: <span className="sr-only">Include in payment</span>, width: '44px',
      render: (r) => r.balancePaise > 0 ? (
        <input type="checkbox" className="mb-check" aria-label={`Pay ${r.invoiceNumber}`} checked={apply[r.id] !== undefined} onChange={() => toggle(r)} onClick={(e) => e.stopPropagation()} />
      ) : null,
    },
    { key: 'bill', header: 'Bill', render: (r) => <PersonCell name={r.invoiceNumber} sub={r.visit ? `${r.visit.department} · ${r.visit.doctor} · ${whenLabel(r.visit.startedAt)}` : undefined} /> },
    { key: 'total', header: 'Total', numeric: true, render: (r) => r.paidOnlinePaise > 0 ? <PersonCell name={formatPaise(r.totalPaise)} sub={`${formatPaise(r.paidOnlinePaise)} paid online`} /> : formatPaise(r.totalPaise) },
    { key: 'due', header: 'Balance', numeric: true, render: (r) => <strong>{formatPaise(r.balancePaise)}</strong> },
    {
      key: 'apply', header: 'Pay now (₹)', numeric: true,
      render: (r) => apply[r.id] !== undefined ? (
        <input
          className="mb-input mb-input--qty" inputMode="decimal" aria-label={`Amount for ${r.invoiceNumber}`} value={apply[r.id]}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => { freshAttempt(); setApply((a) => ({ ...a, [r.id]: e.target.value })); }}
        />
      ) : '—',
    },
    { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
    { key: 'view', header: 'Bill', render: (r) => <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); void view(r.id); }}>View</Button> },
  ];

  const receiptColumns: Column<Receipt>[] = [
    { key: 'r', header: 'Receipt', render: (r) => <PersonCell name={r.receiptNumber} sub={`${whenLabel(r.receivedAt)} · ${r.receivedBy?.name ?? ''}`} /> },
    { key: 'bills', header: 'Bills paid', render: (r) => r.allocations.map((a) => a.invoiceNumber).join(', ') },
    { key: 'method', header: 'Method', render: (r) => <div className="row"><Badge status={r.method} size="sm">{METHOD_LABELS[r.method]}</Badge>{r.channel === 'ONLINE' && <Badge status="PAID_ONLINE" size="sm" />}</div> },
    { key: 'amt', header: 'Amount', numeric: true, render: (r) => <PersonCell name={formatPaise(r.amountPaise)} sub={r.refundedPaise ? `${formatPaise(r.refundedPaise)} refunded` : r.refunds.some((x) => x.status === 'REQUESTED') ? 'Refund requested' : undefined} /> },
    {
      key: 'act', header: 'Actions',
      render: (r) => (
        <div className="row">
          <Button size="sm" variant="secondary" onClick={() => openPdf(`/api/billing/payments/${r.id}/pdf`)}>Print</Button>
          {canRefund && <Button size="sm" variant="ghost" onClick={() => setRefunding(r)}>Refund</Button>}
        </div>
      ),
    },
  ];

  const p = data?.patient;
  const paidToDate = (data?.invoices ?? []).reduce((n, i) => n + i.paidPaise, 0);
  return (
    <StaffLayout
      title={p ? p.name : 'Patient bills'}
      subtitle={p ? [`Patient ID ${p.mrn}`, p.phone].filter(Boolean).join(' · ') : 'Loading…'}
      actions={<Link className="mb-btn mb-btn--secondary" to="/billing">Billing counter</Link>}
    >
      <StatGrid label="Patient account">
        <StatCard label="Balance due" value={data ? formatPaise(data.outstandingPaise) : '—'} tone={data?.outstandingPaise ? 'danger' : 'teal'} />
        <StatCard label="Unpaid bills" value={data ? unpaid.length : '—'} tone="blue" />
        <StatCard label="Bills" value={data?.invoices.length ?? '—'} />
        <StatCard label="Paid to date" value={data ? formatPaise(paidToDate) : '—'} tone="teal" />
      </StatGrid>

      <DashGrid
        main={
          <div className="stack-lg">
            <Card flush>
              <div className="mb-card__head" style={{ padding: 'var(--space-5) var(--space-6) 0' }}>
                <div>
                  <h2 className="mb-card__title">Bills</h2>
                  <p className="mb-card__subtitle">Tick the bills this payment covers; one payment can settle several.</p>
                </div>
              </div>
              <Table columns={invoiceColumns} rows={data?.invoices ?? []} rowKey={(r) => r.id} onRowClick={(r) => void view(r.id)} caption="Bills"
                empty={<EmptyState title={data ? 'No bills yet' : 'Loading…'} text={data ? 'A bill opens with the first charge on a visit.' : undefined} />} />
            </Card>
            <Card flush>
              <div className="mb-card__head" style={{ padding: 'var(--space-5) var(--space-6) 0' }}>
                <h2 className="mb-card__title">Receipts</h2>
              </div>
              <Table columns={receiptColumns} rows={data?.payments ?? []} rowKey={(r) => r.id} caption="Receipts" empty={<EmptyState title="No payments yet" />} />
            </Card>
          </div>
        }
        side={
          <Card title="Collect payment" subtitle={lines.length ? `${lines.length} bill${lines.length === 1 ? '' : 's'} selected` : 'Select a bill to collect'}>
            <div className="stack">
              {lines.length > 0 && (
                <SummaryRows variant="bill" rows={[...lines.map((l) => ({ label: l.invoice.invoiceNumber, value: l.paise === null ? '—' : formatPaise(l.paise) })), { label: 'Total', value: formatPaise(totalPaise) }]} />
              )}
              {METHODS.map((x) => (
                <PaymentMethodCard key={x.value} name="method" value={x.value} checked={method === x.value} onSelect={(v) => { freshAttempt(); setMethod(v as PaymentMethod); }} icon={x.icon} title={x.title} subtitle={x.subtitle}>
                  {x.refLabel && (
                    <Input label={x.refLabel} hint={x.refHint} value={reference} maxLength={80} onChange={(e) => { freshAttempt(); setReference(e.target.value); }} />
                  )}
                </PaymentMethodCard>
              ))}
              {invalid && <p className="mb-error-text">Amount for {invalid.invoice.invoiceNumber} must be between ₹0.01 and {formatPaise(invalid.invoice.balancePaise)}.</p>}
              <Button size="lg" block loading={busy} disabled={!lines.length || !!invalid || needsRef || totalPaise <= 0} onClick={pay}>
                {totalPaise > 0 ? `Record ${formatPaise(totalPaise)} by ${m.title}` : 'Record payment'}
              </Button>
              <TrustNote>Pressing again after a network error never records the payment twice.</TrustNote>
            </div>
          </Card>
        }
      />

      <Modal
        open={!!done}
        title="Payment recorded"
        onClose={() => setDone(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDone(null)}>Done</Button>
            <Button onClick={() => done && openPdf(`/api/billing/payments/${done.id}/pdf`)}>Print receipt</Button>
          </>
        }
      >
        {done && (
          <SummaryRows
            rows={[
              { label: 'Receipt', value: done.receiptNumber },
              { label: 'Method', value: `${METHOD_LABELS[done.method]}${done.reference ? ` · ${done.reference}` : ''}` },
              ...done.allocations.map((a) => ({ label: a.invoiceNumber, value: `${formatPaise(a.amountPaise)} · ${a.invoiceBalancePaise ? `${formatPaise(a.invoiceBalancePaise)} left` : 'paid'}` })),
              { label: 'Amount received', value: formatPaise(done.amountPaise) },
            ]}
          />
        )}
      </Modal>

      <InvoiceModal invoice={viewing} onClose={() => setViewing(null)} printUrl={viewing ? `/api/billing/invoices/${viewing.id}/pdf` : ''} />

      <RefundModal receipt={refunding} onClose={() => setRefunding(null)} onDone={() => { setRefunding(null); void load(); }} />
    </StaffLayout>
  );
}

/** A bill's lines, each tagged with its department; totals with tax. Shared by the counter. */
export function InvoiceModal({ invoice, onClose, printUrl }: { invoice: InvoiceDetail | null; onClose: () => void; printUrl: string }) {
  const columns: Column<InvoiceLine>[] = [
    { key: 'd', header: 'Item', render: (l) => <PersonCell name={l.description} sub={l.department.name} /> },
    { key: 'p', header: 'Payment', render: (l) => (l.paidOnline ? <Badge status="PAID_ONLINE" size="sm" /> : '—') },
    { key: 'q', header: 'Qty', numeric: true, render: (l) => l.quantity },
    { key: 'r', header: 'Rate', numeric: true, render: (l) => formatPaise(l.unitPricePaise) },
    { key: 't', header: 'Tax', numeric: true, render: (l) => (l.taxPercent ? `${l.taxPercent}% · ${formatPaise(l.taxPaise)}` : '—') },
    { key: 'a', header: 'Amount', numeric: true, render: (l) => formatPaise(l.totalPaise + l.taxPaise) },
  ];
  return (
    <Modal
      open={!!invoice}
      title={invoice ? `Bill ${invoice.invoiceNumber}` : 'Bill'}
      onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button onClick={() => openPdf(printUrl)}>Print bill</Button></>}
    >
      {invoice && (
        <div className="stack">
          <p className="muted">
            {invoice.visit ? `${invoice.visit.visitNumber} · ${invoice.visit.type === 'WALK_IN' ? 'Walk-in' : 'Appointment'} · ${invoice.visit.doctor} (${invoice.visit.department}) · ${whenLabel(invoice.visit.startedAt)}` : ''}
          </p>
          <Table columns={columns} rows={invoice.lines} rowKey={(l) => l.id} caption="Bill lines" />
          <SummaryRows
            variant="bill"
            rows={[
              { label: 'Subtotal', value: formatPaise(invoice.subtotalPaise) },
              ...(invoice.discountPaise ? [{ label: 'Discount', value: `− ${formatPaise(invoice.discountPaise)}` }] : []),
              { label: 'Tax (GST)', value: formatPaise(invoice.taxPaise) },
              { label: 'Total', value: formatPaise(invoice.totalPaise) },
              ...(invoice.paidOnlinePaise ? [{ label: 'Paid online (consultation)', value: formatPaise(invoice.paidOnlinePaise) }] : []),
              { label: 'Paid', value: formatPaise(invoice.paidPaise) },
              { label: 'Balance due', value: <Badge status={invoice.status}>{formatPaise(invoice.balancePaise)}</Badge> },
            ]}
          />
        </div>
      )}
    </Modal>
  );
}

/** Reception asks for a refund on one bill of a receipt; accounts approves or rejects it. */
function RefundModal({ receipt, onClose, onDone }: { receipt: Receipt | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [invoiceId, setInvoiceId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setInvoiceId(receipt?.allocations[0]?.invoiceId ?? '');
    setAmount('');
    setReason('');
    setError(undefined);
  }, [receipt]);

  const alloc = receipt?.allocations.find((a) => a.invoiceId === invoiceId);
  const already = receipt?.refunds.filter((r) => r.invoiceId === invoiceId && r.status !== 'REJECTED').reduce((n, r) => n + r.amountPaise, 0) ?? 0;
  const max = alloc ? alloc.amountPaise - already : 0;

  const submit = async () => {
    if (!receipt) return;
    const paise = rupeesInputToPaise(amount);
    if (!paise || paise > max) return setError(`Enter an amount up to ${formatPaise(max)}`);
    setBusy(true);
    try {
      await billingApi.requestRefund({ paymentId: receipt.id, invoiceId, amountPaise: paise, reason });
      toast.success('Refund requested', 'Accounts will approve or reject it.');
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!receipt}
      title={receipt ? `Request a refund · ${receipt.receiptNumber}` : 'Request a refund'}
      onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={max <= 0 || reason.trim().length < 5} onClick={submit}>Send to accounts</Button></>}
    >
      {receipt && (
        <div className="stack">
          <Select
            label="Bill"
            value={invoiceId}
            onChange={(e) => setInvoiceId(e.target.value)}
            options={receipt.allocations.map((a) => ({ value: a.invoiceId, label: `${a.invoiceNumber} · ${formatPaise(a.amountPaise)} paid` }))}
          />
          <Input label="Amount to refund (₹)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} hint={`Up to ${formatPaise(max)} · paid back by ${METHOD_LABELS[receipt.method]}`} error={error} />
          <Textarea label="Reason" rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Medicine returned unopened" />
          <p className="muted">Refunds are approved only by Accounts. Every request and decision is audited.</p>
        </div>
      )}
    </Modal>
  );
}
