import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, DashGrid, EmptyState, Input, PersonList, StatCard, StatGrid, SummaryRows, Table, Textarea, useToast, type Column } from '../../components';
import { errorMessage } from '../../lib/api';
import { billingApi, METHOD_LABELS, rupeesInputToPaise, type DayClose, type MethodTotals } from '../../lib/billing';
import { formatPaise } from '../../lib/format';
import { useLive } from '../../lib/live';
import { dayLabel, longDayLabel, todayKey, whenLabel } from '../../lib/time';
import { StaffLayout } from '../staff/StaffLayout';

const outcome = (diff: number) => (diff === 0 ? 'BALANCED' : diff < 0 ? 'SHORT' : 'OVER');

/** End-of-day cash reconciliation: expected totals by method vs counted cash, difference recorded once per day. */
export function CloseDay() {
  const toast = useToast();
  const [date, setDate] = useState(todayKey());
  const [data, setData] = useState<DayClose | null>(null);
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => setData(await billingApi.dayClose(date)), [date]);
  useEffect(() => {
    load().catch((err) => toast.error('Could not load the day', errorMessage(err)));
  }, [load, toast]);
  useLive(['billing:changed'], () => void load().catch(() => undefined));

  const expectedCash = data?.methods.find((m) => m.method === 'CASH')?.expectedPaise ?? 0;
  const countedPaise = rupeesInputToPaise(counted);
  const diff = countedPaise === null ? null : countedPaise - expectedCash;
  const saved = data?.reconciliation;

  const close = async () => {
    if (countedPaise === null) return;
    setBusy(true);
    try {
      await billingApi.closeDay({ date, countedCashPaise: countedPaise, note: note.trim() || null });
      toast.success(`${longDayLabel(date)} closed`, diff === 0 ? 'Cash matches the system.' : `Difference of ${formatPaise(Math.abs(diff ?? 0))} recorded.`);
      setCounted('');
      setNote('');
      await load();
    } catch (err) {
      toast.error('Could not close the day', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<MethodTotals>[] = [
    { key: 'm', header: 'Method', render: (r) => <Badge status={r.method}>{METHOD_LABELS[r.method]}</Badge> },
    { key: 'in', header: 'Received', numeric: true, render: (r) => formatPaise(r.receivedPaise) },
    { key: 'out', header: 'Refunds paid', numeric: true, render: (r) => (r.refundedPaise ? `− ${formatPaise(r.refundedPaise)}` : '—') },
    { key: 'exp', header: 'Expected', numeric: true, render: (r) => <strong>{formatPaise(r.expectedPaise)}</strong> },
  ];
  const totalExpected = (data?.methods ?? []).reduce((n, m) => n + m.expectedPaise, 0);

  return (
    <StaffLayout
      title="Close the day"
      subtitle={`${longDayLabel(date)} · Cash reconciliation`}
      actions={<Link className="mb-btn mb-btn--secondary" to="/billing">Billing counter</Link>}
    >
      <StatGrid label="Day totals">
        <StatCard label="Expected cash" value={data ? formatPaise(expectedCash) : '—'} tone="teal" />
        <StatCard label="Expected, all methods" value={data ? formatPaise(totalExpected) : '—'} />
        <StatCard label="Payments" value={data?.paymentCount ?? '—'} tone="blue" />
        <StatCard label="Refunds paid out" value={data?.refundCount ?? '—'} tone="danger" />
      </StatGrid>
      <DashGrid
        main={
          <div className="stack-lg">
            <Card>
              <div className="mb-range">
                <Input label="Business day" type="date" value={date} max={todayKey()} onChange={(e) => e.target.value && setDate(e.target.value)} />
              </div>
            </Card>
            <Card flush>
              <div className="mb-card__head" style={{ padding: 'var(--space-5) var(--space-6) 0' }}>
                <div>
                  <h2 className="mb-card__title">Expected by method</h2>
                  <p className="mb-card__subtitle">Confirmed payments minus refunds approved that day. UPI and card settle to the bank; only cash is counted.</p>
                </div>
              </div>
              <Table columns={columns} rows={data?.methods ?? []} rowKey={(r) => r.method} caption="Expected totals by payment method" empty={<EmptyState title="Loading…" />} />
            </Card>
          </div>
        }
        side={
          <>
            {saved ? (
              <Card title="Day closed" subtitle={`${saved.closedBy.fullName} · ${whenLabel(saved.createdAt)}`} actions={<Badge status={outcome(saved.differencePaise)} size="sm" />}>
                <SummaryRows
                  variant="bill"
                  rows={[
                    { label: 'Expected cash', value: formatPaise(saved.expectedCashPaise) },
                    { label: 'Counted cash', value: formatPaise(saved.countedCashPaise) },
                    { label: 'Difference', value: `${saved.differencePaise > 0 ? '+' : saved.differencePaise < 0 ? '−' : ''}${formatPaise(Math.abs(saved.differencePaise))}` },
                    { label: 'UPI (expected)', value: formatPaise(saved.expectedUpiPaise) },
                    { label: 'Card (expected)', value: formatPaise(saved.expectedCardPaise) },
                  ]}
                />
                {saved.note && <p className="muted" style={{ marginTop: 'var(--space-3)' }}>Note: {saved.note}</p>}
              </Card>
            ) : (
              <Card title="Count the cash drawer" subtitle="Recorded once per day; the difference is kept on file.">
                <div className="stack">
                  <Input label="Counted cash (₹)" inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} error={counted && countedPaise === null ? 'Enter an amount like 1250 or 1250.50' : undefined} />
                  {diff !== null && (
                    <SummaryRows
                      variant="bill"
                      rows={[
                        { label: 'Expected cash', value: formatPaise(expectedCash) },
                        { label: 'Difference', value: <Badge status={outcome(diff)}>{`${diff > 0 ? '+' : diff < 0 ? '−' : ''}${formatPaise(Math.abs(diff))}`}</Badge> },
                      ]}
                    />
                  )}
                  <Textarea label={diff ? 'Reason for the difference' : 'Note (optional)'} rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
                  <Button block loading={busy} disabled={countedPaise === null || (!!diff && !note.trim())} onClick={close}>Close {date === todayKey() ? 'today' : dayLabel(date)}</Button>
                </div>
              </Card>
            )}
            <Card title="Recent closes">
              {data?.recent.length ? (
                <PersonList items={data.recent.map((r) => ({ key: r.id, name: longDayLabel(r.businessDate), sub: `Counted ${formatPaise(r.countedCashPaise)} · ${r.closedBy.fullName}`, action: <Badge status={outcome(r.differencePaise)} size="sm" /> }))} />
              ) : (
                <p className="muted">{data ? 'No day has been closed yet.' : 'Loading…'}</p>
              )}
            </Card>
          </>
        }
      />
    </StaffLayout>
  );
}
