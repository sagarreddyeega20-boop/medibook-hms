import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Card, DashGrid, EmptyState, HBarChart, Input, Modal, PersonCell, PersonList, Pill, StatCard, StatGrid, SummaryRows, Table, Tabs, Textarea, TrendChart, useToast, type Column,
} from '../../components';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { billingApi, METHOD_LABELS, type AccountsDashboard, type Refund } from '../../lib/billing';
import { formatPaise, greeting } from '../../lib/format';
import { useLive } from '../../lib/live';
import { addDays, dayLabel, todayKey, whenLabel } from '../../lib/time';
import { StaffLayout } from '../staff/StaffLayout';

type Tx = AccountsDashboard['transactions'][number];

const PRESETS = [
  { id: 'today', label: 'Today', days: 1 },
  { id: '7', label: 'Last 7 days', days: 7 },
  { id: '30', label: 'Last 30 days', days: 30 },
  { id: '90', label: 'Last 90 days', days: 90 },
];

/** "₹12k", "₹1.2L" for chart axes (Indian grouping). */
const axisRupees = (paise: number) => {
  const r = paise / 100;
  if (r >= 1e7) return `₹${+(r / 1e7).toFixed(1)}Cr`;
  if (r >= 1e5) return `₹${+(r / 1e5).toFixed(1)}L`;
  if (r >= 1e3) return `₹${+(r / 1e3).toFixed(1)}k`;
  return `₹${Math.round(r)}`;
};

/**
 * ACCOUNTS home: revenue by department, daily trend, pharmacy margin, appointments vs walk-ins, patients,
 * transactions (CSV export) and refunds to approve. Amounts and counts only — no clinical data.
 */
export function AccountsHome() {
  const { user } = useAuth();
  const toast = useToast();
  const [from, setFrom] = useState(addDays(todayKey(), -6));
  const [to, setTo] = useState(todayKey());
  const [data, setData] = useState<AccountsDashboard | null>(null);
  const [pending, setPending] = useState<Refund[]>([]);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('payments');
  const [rejecting, setRejecting] = useState<Refund | null>(null);
  const [note, setNote] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [d, p] = await Promise.all([billingApi.accounts(from, to), billingApi.refunds('REQUESTED')]);
    setData(d);
    setPending(p);
  }, [from, to]);
  useEffect(() => {
    if (from > to) return;
    load().catch((err) => toast.error('Could not load the accounts dashboard', errorMessage(err)));
  }, [load, toast, from, to]);
  useLive(['billing:changed'], () => void load().catch(() => undefined));

  const preset = (days: number) => {
    setTo(todayKey());
    setFrom(addDays(todayKey(), -(days - 1)));
  };
  const activePreset = to === todayKey() ? PRESETS.find((p) => addDays(todayKey(), -(p.days - 1)) === from)?.id : undefined;

  const decide = async (r: Refund, decision: 'approve' | 'reject', why: string | null) => {
    setBusyId(r.id);
    try {
      await billingApi.decideRefund(r.id, decision, why);
      toast.success(decision === 'approve' ? 'Refund approved' : 'Refund rejected', `${formatPaise(r.amountPaise)} · ${r.receiptNumber}`);
      setRejecting(null);
      setNote('');
      await load();
    } catch (err) {
      toast.error('Could not save the decision', errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const q = search.trim().toLowerCase();
  const txRows = useMemo(
    () => (data?.transactions ?? []).filter((t) => !q || [t.receiptNumber, t.patient?.name, t.patient?.mrn, t.reference, ...t.invoices].some((s) => s?.toLowerCase().includes(q))),
    [data, q],
  );
  const refundRows = useMemo(
    () => (data?.refunds.list ?? []).filter((r) => !q || [r.receiptNumber, r.patient?.name, r.patient?.mrn, r.reason].some((s) => s?.toLowerCase().includes(q))),
    [data, q],
  );

  const txColumns: Column<Tx>[] = [
    { key: 'when', header: 'Date', render: (t) => <PersonCell name={t.receiptNumber} sub={whenLabel(t.receivedAt)} /> },
    { key: 'patient', header: 'Patient', render: (t) => <PersonCell name={t.patient?.name ?? '—'} sub={t.patient?.mrn} /> },
    { key: 'method', header: 'Method', render: (t) => <Badge status={t.method} size="sm">{METHOD_LABELS[t.method]}</Badge> },
    { key: 'by', header: 'Recorded by', render: (t) => <PersonCell name={t.receivedBy ?? '—'} sub={t.invoices.join(', ')} /> },
    { key: 'amt', header: 'Amount', numeric: true, render: (t) => <PersonCell name={formatPaise(t.amountPaise)} sub={t.refundedPaise ? `− ${formatPaise(t.refundedPaise)} refunded` : undefined} /> },
  ];
  const refundColumns: Column<Refund>[] = [
    { key: 'when', header: 'Requested', render: (r) => <PersonCell name={r.receiptNumber} sub={whenLabel(r.createdAt)} /> },
    { key: 'patient', header: 'Patient', render: (r) => <PersonCell name={r.patient?.name ?? '—'} sub={r.patient?.mrn} /> },
    { key: 'reason', header: 'Reason', render: (r) => <PersonCell name={r.reason} sub={[r.requestedBy && `by ${r.requestedBy}`, r.decidedBy && `decided by ${r.decidedBy}`].filter(Boolean).join(' · ')} /> },
    { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} size="sm" /> },
    { key: 'amt', header: 'Amount', numeric: true, render: (r) => formatPaise(r.amountPaise) },
  ];

  const d = data;
  const single = d?.range.days === 1;
  const csvHref = `/api/accounts/transactions.csv?from=${from}&to=${to}`;
  return (
    <StaffLayout
      title={`${greeting()}, ${user?.name.split(' ')[0] ?? ''}`}
      subtitle={`Accounts · ${from === to ? dayLabel(from) : `${dayLabel(from)} – ${dayLabel(to)}`}`}
      search={{ placeholder: 'Search receipt, patient or MRN', value: search, onChange: setSearch }}
      actions={<a className="mb-btn mb-btn--secondary" href={csvHref} download>Export CSV</a>}
    >
      <Card>
        <div className="mb-range">
          <Input label="From" type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
          <Input label="To" type="date" value={to} min={from} max={todayKey()} onChange={(e) => e.target.value && setTo(e.target.value)} />
          <div className="row" role="group" aria-label="Quick ranges">
            {PRESETS.map((p) => <Pill key={p.id} selected={activePreset === p.id} onClick={() => preset(p.days)}>{p.label}</Pill>)}
          </div>
        </div>
      </Card>

      <StatGrid label="Accounts at a glance">
        <StatCard label="Revenue billed" value={d ? formatPaise(d.totals.billedPaise) : '—'} tone="teal" />
        <StatCard label="Net collected" value={d ? formatPaise(d.totals.netCollectedPaise) : '—'} />
        <StatCard label="Appointments · walk-ins" value={d ? `${d.visits.appointments} · ${d.visits.walkIns}` : '—'} tone="blue" />
        <StatCard label="Patients seen · new" value={d ? `${d.patients.seen} · ${d.patients.new}` : '—'} tone="danger" />
      </StatGrid>

      <DashGrid
        main={
          <div className="stack-lg">
            <Card title="Revenue by department" subtitle="Billed in the range, before tax. Consultations, tests, scans and medicines each count for their own department.">
              <HBarChart
                caption="Revenue by department"
                data={(d?.revenueByDepartment ?? []).map((r) => ({ key: r.departmentId, label: r.name, value: r.revenuePaise, valueLabel: <>{formatPaise(r.revenuePaise)}<small>{r.sharePercent}%</small></> }))}
                empty={d ? 'No charges in this range.' : 'Loading…'}
              />
            </Card>
            <Card title="Daily revenue" subtitle={single ? 'One day selected — widen the range to see the trend.' : 'Billed vs collected (payments minus refunds) per day.'}>
              {d ? (
                <TrendChart
                  caption="Daily revenue: billed and collected"
                  labels={d.trend.map((t) => dayLabel(t.date))}
                  series={[
                    { key: 'billed', label: 'Billed', values: d.trend.map((t) => t.billedPaise) },
                    { key: 'collected', label: 'Collected', values: d.trend.map((t) => t.collectedPaise) },
                  ]}
                  format={formatPaise}
                  formatAxis={axisRupees}
                />
              ) : <p className="muted">Loading…</p>}
            </Card>
            <Card flush>
              <div className="mb-card__head" style={{ padding: 'var(--space-5) var(--space-6) 0' }}>
                <h2 className="mb-card__title">Transactions</h2>
                <a className="mb-btn mb-btn--link" href={csvHref} download>Download CSV</a>
              </div>
              <div style={{ padding: 'var(--space-3) var(--space-6) 0' }}>
                <Tabs label="Transactions" value={tab} onChange={setTab} tabs={[{ id: 'payments', label: 'Payments', count: d?.transactions.length }, { id: 'refunds', label: 'Refunds', count: d?.refunds.list.length }]} />
              </div>
              {tab === 'payments' ? (
                <Table columns={txColumns} rows={txRows} rowKey={(t) => t.id} caption="Payments" empty={<EmptyState title={d ? 'No payments in this range' : 'Loading…'} />} />
              ) : (
                <Table columns={refundColumns} rows={refundRows} rowKey={(r) => r.id} caption="Refunds" empty={<EmptyState title={d ? 'No refunds in this range' : 'Loading…'} />} />
              )}
            </Card>
          </div>
        }
        side={
          <>
            <Card title="Refunds to approve" actions={pending.length ? <Badge tone="warning" dot size="sm">{pending.length}</Badge> : undefined}>
              {pending.length ? (
                <div className="stack">
                  {pending.map((r) => (
                    <div key={r.id} className="stack" style={{ gap: 'var(--space-2)' }}>
                      <PersonCell name={`${formatPaise(r.amountPaise)} · ${r.patient?.name ?? ''}`} sub={`${r.receiptNumber} · ${METHOD_LABELS[r.method]} · ${r.reason}`} />
                      <div className="row">
                        <Button size="sm" loading={busyId === r.id} onClick={() => void decide(r, 'approve', null)}>Approve</Button>
                        <Button size="sm" variant="danger-outline" disabled={busyId === r.id} onClick={() => setRejecting(r)}>Reject</Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">No refund is waiting for a decision.</p>
              )}
            </Card>
            <Card title="Pharmacy" subtitle="Selling price vs purchase price of medicines dispensed.">
              <SummaryRows
                variant="bill"
                rows={[
                  { label: 'Sales', value: d ? formatPaise(d.pharmacy.salesPaise) : '—' },
                  { label: 'Cost', value: d ? formatPaise(d.pharmacy.costPaise) : '—' },
                  { label: `Margin${d ? ` (${d.pharmacy.marginPercent}%)` : ''}`, value: d ? formatPaise(d.pharmacy.marginPaise) : '—' },
                ]}
              />
            </Card>
            <Card title="Visits by department" subtitle={d ? `${d.visits.total} visits · ${d.visits.appointments} appointments, ${d.visits.walkIns} walk-ins` : undefined}>
              {d?.visits.byDepartment.length ? (
                <PersonList items={d.visits.byDepartment.map((v) => ({ key: v.departmentId, name: v.name, sub: v.code, action: <strong>{v.visits}</strong> }))} />
              ) : (
                <p className="muted">{d ? 'No visits in this range.' : 'Loading…'}</p>
              )}
            </Card>
            <Card title="Collections by method">
              <SummaryRows
                variant="bill"
                rows={[
                  ...(d?.methods ?? []).map((m) => ({ label: `${METHOD_LABELS[m.method]} · ${m.count}`, value: formatPaise(m.amountPaise) })),
                  { label: 'Refunded', value: d ? `− ${formatPaise(d.totals.refundedPaise)}` : '—' },
                  { label: 'GST billed', value: d ? formatPaise(d.totals.taxBilledPaise) : '—' },
                ]}
              />
            </Card>
          </>
        }
      />

      <Modal
        open={!!rejecting}
        title="Reject refund"
        onClose={() => setRejecting(null)}
        footer={<><Button variant="secondary" onClick={() => setRejecting(null)}>Cancel</Button><Button variant="danger" loading={!!rejecting && busyId === rejecting.id} disabled={note.trim().length < 5} onClick={() => rejecting && void decide(rejecting, 'reject', note.trim())}>Reject refund</Button></>}
      >
        {rejecting && (
          <div className="stack">
            <p className="muted">{formatPaise(rejecting.amountPaise)} on {rejecting.receiptNumber} for {rejecting.patient?.name}: “{rejecting.reason}”</p>
            <Textarea label="Why is it rejected?" rows={3} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        )}
      </Modal>
    </StaffLayout>
  );
}
