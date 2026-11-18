import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge, Button, Card, DashGrid, EmptyState, PersonCell, PersonList, StatCard, StatGrid, SummaryRows, Table, useToast, type Column } from '../../components';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { billingApi, METHOD_LABELS, openPdf, type Counter, type InvoiceSummary } from '../../lib/billing';
import { formatPaise, greeting } from '../../lib/format';
import { useLive } from '../../lib/live';
import { longDayLabel, timeLabel, todayKey, whenLabel } from '../../lib/time';
import { StaffLayout } from '../staff/StaffLayout';

type Found = Awaited<ReturnType<typeof billingApi.searchPatients>>[number];

/** Billing counter (RECEPTIONIST, ACCOUNTS): v1 staff dashboard — unpaid bills, patient search, today's takings and receipts. */
export function BillingCounter() {
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState<Counter | null>(null);
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<Found[] | null>(null);

  const load = useCallback(async () => setData(await billingApi.counter()), []);
  useEffect(() => {
    load().catch((err) => toast.error('Could not load the billing counter', errorMessage(err)));
  }, [load, toast]);
  useLive(['billing:changed'], () => void load().catch(() => undefined));

  const q = search.trim();
  useEffect(() => {
    if (q.length < 2) return setFound(null);
    const t = window.setTimeout(() => billingApi.searchPatients(q).then(setFound).catch(() => setFound([])), 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const open = (patientId: string) => navigate(`/billing/patients/${patientId}`);

  const unpaidColumns: Column<InvoiceSummary>[] = [
    { key: 'patient', header: 'Patient', render: (r) => <PersonCell name={r.patient?.name ?? 'Patient'} sub={r.patient?.mrn} /> },
    { key: 'bill', header: 'Bill', render: (r) => <PersonCell name={r.invoiceNumber} sub={r.visit ? `${r.visit.department} · ${whenLabel(r.visit.startedAt)}` : undefined} /> },
    { key: 'total', header: 'Total', numeric: true, render: (r) => formatPaise(r.totalPaise) },
    { key: 'due', header: 'Balance due', numeric: true, render: (r) => <strong>{formatPaise(r.balancePaise)}</strong> },
    { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
    { key: 'action', header: 'Action', render: (r) => <Button size="sm" onClick={(e) => { e.stopPropagation(); if (r.patient) open(r.patient.id); }}>Collect</Button> },
  ];
  const foundColumns: Column<Found>[] = [
    { key: 'patient', header: 'Patient', render: (r) => <PersonCell name={r.name} sub={[r.mrn, r.phone].filter(Boolean).join(' · ')} /> },
    { key: 'bills', header: 'Unpaid bills', numeric: true, render: (r) => r.unpaidInvoices },
    { key: 'due', header: 'Balance due', numeric: true, render: (r) => <strong>{formatPaise(r.outstandingPaise)}</strong> },
    { key: 'action', header: 'Action', render: (r) => <Button size="sm" variant={r.outstandingPaise ? 'primary' : 'secondary'} onClick={(e) => { e.stopPropagation(); open(r.id); }}>{r.outstandingPaise ? 'Collect' : 'Open'}</Button> },
  ];

  const s = data?.stats;
  return (
    <StaffLayout
      title={`${greeting()}, ${user?.name.split(' ')[0] ?? ''}`}
      subtitle={`${longDayLabel(todayKey())} · Billing counter`}
      search={{ placeholder: 'Search patient ID, name or phone', value: search, onChange: setSearch }}
      actions={<Link className="mb-btn mb-btn--secondary" to="/billing/close-day">Close the day</Link>}
    >
      <StatGrid label="Counter at a glance">
        <StatCard label="Collected today" value={s ? formatPaise(s.collectedTodayPaise) : '—'} tone="teal" />
        <StatCard label="Receipts today" value={s?.receiptsToday ?? '—'} />
        <StatCard label="Unpaid bills" value={s?.unpaidInvoices ?? '—'} tone="blue" />
        <StatCard label="Refunds awaiting accounts" value={s?.pendingRefunds ?? '—'} tone="danger" />
      </StatGrid>

      <DashGrid
        main={
          found ? (
            <Card flush>
              <div className="mb-card__head" style={{ padding: 'var(--space-5) var(--space-6) 0' }}>
                <h2 className="mb-card__title">Patients matching “{q}”</h2>
              </div>
              <Table columns={foundColumns} rows={found} rowKey={(r) => r.id} onRowClick={(r) => open(r.id)} caption="Patient search results"
                empty={<EmptyState title="No patient found" text="Search by patient ID (MRN), name or mobile number." />} />
            </Card>
          ) : (
            <Card flush>
              <div className="mb-card__head" style={{ padding: 'var(--space-5) var(--space-6) 0' }}>
                <div>
                  <h2 className="mb-card__title">Unpaid bills</h2>
                  <p className="mb-card__subtitle">One bill per visit: consultation, tests, scans and medicines.{s ? ` ${formatPaise(s.outstandingPaise)} outstanding.` : ''}</p>
                </div>
                <Badge tone="success" dot size="sm">Live</Badge>
              </div>
              <Table
                columns={unpaidColumns}
                rows={data?.unpaid ?? []}
                rowKey={(r) => r.id}
                onRowClick={(r) => r.patient && open(r.patient.id)}
                caption="Unpaid bills"
                empty={<EmptyState title={data ? 'Every bill is paid' : 'Loading…'} text={data ? 'New bills appear here as soon as a visit is charged.' : undefined} />}
              />
            </Card>
          )
        }
        side={
          <>
            <Card title="Today by method" subtitle={data?.reconciled ? 'Day closed' : 'Received − refunds paid out'} actions={data?.reconciled ? <Badge status={data.reconciled.differencePaise === 0 ? 'BALANCED' : data.reconciled.differencePaise < 0 ? 'SHORT' : 'OVER'} size="sm" /> : undefined}>
              <SummaryRows
                variant="bill"
                rows={(data?.methods ?? []).map((m) => ({ label: METHOD_LABELS[m.method], value: formatPaise(m.expectedPaise) }))}
              />
              <div className="row" style={{ marginTop: 'var(--space-4)' }}>
                <Link className="mb-btn mb-btn--link" to="/billing/close-day">{data?.reconciled ? 'View day close' : 'Count cash & close the day'}</Link>
              </div>
            </Card>
            <Card title="Latest receipts">
              {data?.receipts.length ? (
                <PersonList
                  items={data.receipts.map((r) => ({
                    key: r.id,
                    name: `${r.patient?.name ?? 'Patient'} · ${formatPaise(r.amountPaise)}`,
                    sub: `${r.receiptNumber} · ${METHOD_LABELS[r.method]} · ${timeLabel(r.receivedAt)}`,
                    action: <Button size="sm" variant="ghost" onClick={() => openPdf(`/api/billing/payments/${r.id}/pdf`)}>Print</Button>,
                  }))}
                />
              ) : (
                <p className="muted">{data ? 'No payments yet today.' : 'Loading…'}</p>
              )}
            </Card>
          </>
        }
      />
    </StaffLayout>
  );
}
