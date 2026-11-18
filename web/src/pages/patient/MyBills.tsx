import { useEffect, useMemo, useState } from 'react';
import { AppointmentCard, Card, EmptyState, HeroBanner, PatientGrid, SideCard, SummaryRows, Tabs, useToast } from '../../components';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { billingApi, METHOD_LABELS, type InvoiceSummary, type Receipt } from '../../lib/billing';
import { formatPaise } from '../../lib/format';
import { whenLabel } from '../../lib/time';
import { PatientShell } from './PatientShell';

/** Patient portal: bills (one per visit) and receipts for self + family, each downloadable as a PDF. */
export function MyBills() {
  const { user } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<{ invoices: InvoiceSummary[]; payments: Receipt[] } | null>(null);
  const [tab, setTab] = useState('bills');

  useEffect(() => {
    billingApi.mine().then(setData).catch((err) => toast.error('Could not load your bills', errorMessage(err)));
  }, [toast]);

  const due = useMemo(() => (data?.invoices ?? []).reduce((n, i) => n + i.balancePaise, 0), [data]);
  const forWhom = (p: { name: string } | null) => (p && p.name !== user?.name ? ` · for ${p.name}` : '');
  const download = (href: string, label: string) => <a className="mb-btn mb-btn--secondary mb-btn--sm" href={href} download>{label}</a>;

  return (
    <PatientShell>
      <PatientGrid
        banner={
          <HeroBanner
            name={user?.name ?? ''}
            meta={<>Patient ID <strong>{user?.mrn}</strong> · Bills and receipts</>}
            stats={[
              { label: 'Balance due', value: data ? formatPaise(due) : '—' },
              { label: 'Bills', value: data ? data.invoices.length : '—' },
              { label: 'Receipts', value: data ? data.payments.length : '—' },
            ]}
          />
        }
        main={
          <div className="stack">
            <Tabs label="Bills and receipts" value={tab} onChange={setTab} tabs={[{ id: 'bills', label: 'Bills', count: data?.invoices.length }, { id: 'receipts', label: 'Receipts', count: data?.payments.length }]} />
            {data && tab === 'bills' && !data.invoices.length && <Card><EmptyState title="No bills yet" text="Your bill appears here after your visit, with the consultation, tests and medicines on it." /></Card>}
            {data && tab === 'receipts' && !data.payments.length && <Card><EmptyState title="No receipts yet" text="Receipts appear here once you pay at the billing counter." /></Card>}
            {tab === 'bills' && data?.invoices.map((i) => (
              <AppointmentCard
                key={i.id}
                date={new Date(i.issuedAt ?? i.createdAt)}
                title={i.visit ? `${i.visit.doctor} · ${i.visit.department}` : i.invoiceNumber}
                lines={[
                  `Bill ${i.invoiceNumber}${forWhom(i.patient)}${i.visit ? ` · Visit ${whenLabel(i.visit.startedAt)}` : ''}`,
                  `Total ${formatPaise(i.totalPaise)}${i.taxPaise ? ` (incl. ${formatPaise(i.taxPaise)} GST)` : ''} · Paid ${formatPaise(i.paidPaise)}${i.balancePaise ? ` · Due ${formatPaise(i.balancePaise)}` : ''}`,
                ]}
                status={i.status}
                actions={download(`/api/billing/me/invoices/${i.id}/pdf`, 'Download PDF')}
              />
            ))}
            {tab === 'receipts' && data?.payments.map((p) => (
              <AppointmentCard
                key={p.id}
                date={new Date(p.receivedAt)}
                title={`${formatPaise(p.amountPaise)} · ${METHOD_LABELS[p.method]}`}
                lines={[
                  `Receipt ${p.receiptNumber}${forWhom(p.patient)} · ${whenLabel(p.receivedAt)}`,
                  `For ${p.allocations.map((a) => a.invoiceNumber).join(', ')}${p.refundedPaise ? ` · ${formatPaise(p.refundedPaise)} refunded` : ''}`,
                ]}
                status="PAID"
                actions={download(`/api/billing/me/payments/${p.id}/pdf`, 'Download PDF')}
              />
            ))}
          </div>
        }
        side={
          <>
            <SideCard title="Paying a bill">
              <p className="muted">Pay at the hospital billing counter by cash, UPI or card. One payment can cover several bills, and you get a receipt straight away.</p>
            </SideCard>
            {data && due > 0 && (
              <SideCard title="Due now">
                <SummaryRows variant="bill" rows={data.invoices.filter((i) => i.balancePaise > 0).map((i) => ({ label: i.invoiceNumber, value: formatPaise(i.balancePaise) }))} />
              </SideCard>
            )}
          </>
        }
      />
    </PatientShell>
  );
}
