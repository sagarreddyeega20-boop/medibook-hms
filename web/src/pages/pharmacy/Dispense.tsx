import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Badge, Button, Card, DashGrid, NowConsultingCard, PersonCell, SummaryRows, Table, useToast, type Column } from '../../components';
import { api, errorMessage } from '../../lib/api';
import { formatPaise } from '../../lib/format';
import { whenLabel } from '../../lib/time';
import { patientMeta } from '../doctor/clinical';
import { StaffLayout } from '../staff/StaffLayout';
import { directions, maxNow, type DispenseItem, type DispenseView } from './types';

/**
 * Dispense screen: every prescribed item with what is left to give and the stock on the shelf.
 * Dispense all or part; the prescription itself is read-only here (only the doctor can change it).
 */
export function Dispense() {
  const { id = '' } = useParams();
  const toast = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState<DispenseView | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const fill = (v: DispenseView) => setQty(Object.fromEntries(v.items.map((i) => [i.id, String(maxNow(i))])));
  const load = useCallback(async () => {
    const v = await api<DispenseView>(`/api/pharmacy/prescriptions/${id}`);
    setData(v);
    fill(v);
  }, [id]);
  useEffect(() => {
    load().catch((err) => toast.error('Could not open the prescription', errorMessage(err)));
  }, [load, toast]);

  const n = (i: DispenseItem) => {
    const v = Number(qty[i.id] ?? 0);
    return Number.isInteger(v) && v > 0 ? v : 0;
  };
  const invalid = (i: DispenseItem) => n(i) > maxNow(i) || ((qty[i.id] ?? '') !== '' && !/^\d+$/.test(qty[i.id]!));
  const lines = (data?.items ?? []).filter((i) => n(i) > 0);
  const total = lines.reduce((s, i) => s + n(i) * (i.medicine?.sellingPricePaise ?? 0), 0);
  const open = data && ['ACTIVE', 'PARTIALLY_DISPENSED'].includes(data.prescription.status);
  const fullNow = !!data && lines.length > 0 && data.items.every((i) => i.remaining === 0 || n(i) === i.remaining);
  const canGiveAll = (data?.items ?? []).every((i) => i.remaining === 0 || (i.medicine && i.medicine.stockQuantity >= i.remaining));

  const dispense = async () => {
    if (!data) return;
    setBusy(true);
    try {
      const r = await api<{ status: string; view: DispenseView }>(`/api/pharmacy/prescriptions/${id}/dispense`, { json: { items: lines.map((i) => ({ itemId: i.id, quantity: n(i) })) } });
      if (r.status === 'DISPENSED') {
        toast.success('Prescription dispensed', `${formatPaise(total)} added to ${data.patient?.name ?? 'the patient'}’s bill.`);
        navigate('/pharmacy');
      } else {
        toast.success('Partly dispensed', `${formatPaise(total)} added to the bill. The rest stays in the queue.`);
        setData(r.view);
        fill(r.view);
      }
    } catch (err) {
      toast.error('Could not dispense', errorMessage(err));
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<DispenseItem>[] = [
    { key: 'med', header: 'Medicine', render: (i) => <PersonCell name={i.medicineName} sub={directions(i) || undefined} /> },
    { key: 'prescribed', header: 'Prescribed', numeric: true, render: (i) => i.quantity },
    { key: 'given', header: 'Given', numeric: true, render: (i) => i.dispensedQuantity },
    {
      key: 'stock', header: 'In stock',
      render: (i) =>
        i.medicine ? (
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            <span className="mb-num">{i.medicine.stockQuantity}</span>
            {i.medicine.level !== 'IN_STOCK' && <Badge status={i.medicine.level} size="sm" />}
          </div>
        ) : (
          <Badge tone="warning" size="sm">Not in formulary</Badge>
        ),
    },
    { key: 'price', header: 'Price', numeric: true, render: (i) => (i.medicine ? formatPaise(i.medicine.sellingPricePaise) : '—') },
    {
      key: 'now', header: 'Dispense now',
      render: (i) =>
        i.remaining === 0 ? (
          <Badge status="DISPENSED" size="sm" />
        ) : (
          <input
            className="mb-input mb-input--qty"
            type="number"
            inputMode="numeric"
            min={0}
            max={maxNow(i)}
            aria-label={`Quantity of ${i.medicineName} to dispense now`}
            aria-invalid={invalid(i) || undefined}
            disabled={!open || !i.medicine || maxNow(i) === 0}
            value={qty[i.id] ?? ''}
            onChange={(e) => setQty((q) => ({ ...q, [i.id]: e.target.value }))}
          />
        ),
    },
  ];

  const p = data?.patient;
  return (
    <StaffLayout
      title="Dispense prescription"
      subtitle={data ? [data.prescription.orderNumber, p?.name, whenLabel(data.prescription.createdAt)].filter(Boolean).join(' · ') : 'Loading…'}
      actions={<Link className="mb-btn mb-btn--secondary" to="/pharmacy">Back to queue</Link>}
    >
      <DashGrid
        main={
          <Card flush>
            <div className="mb-card__head" style={{ padding: 'var(--space-5) var(--space-6) 0' }}>
              <div>
                <h2 className="mb-card__title">Items</h2>
                <p className="mb-card__subtitle">The prescription can’t be changed here — ask {data?.doctor.name ?? 'the doctor'} for any change.</p>
              </div>
              {data && <Badge status={data.prescription.status === 'ACTIVE' ? 'AWAITING' : data.prescription.status}>{data.prescription.status === 'ACTIVE' ? 'To dispense' : undefined}</Badge>}
            </div>
            <Table columns={columns} rows={data?.items ?? []} rowKey={(i) => i.id} caption="Prescription items" />
          </Card>
        }
        side={
          <>
            <NowConsultingCard
              title="Patient"
              patient={p ? { name: p.name, meta: patientMeta(p) } : undefined}
              emptyText="Loading…"
              intakeLabel="Prescribed by"
              intake={data ? `${data.doctor.name}${data.doctor.department ? ` · ${data.doctor.department}` : ''}` : undefined}
            />
            <Card title="This dispense" subtitle="Charged at today’s selling price to the patient’s bill.">
              <div className="stack">
                {lines.length ? (
                  <SummaryRows rows={lines.map((i) => ({ label: `${i.medicine!.name} × ${n(i)}`, value: formatPaise(n(i) * i.medicine!.sellingPricePaise) }))} />
                ) : (
                  <p className="muted">{open ? 'Enter a quantity for at least one medicine.' : 'Nothing left to dispense.'}</p>
                )}
                {lines.length > 0 && <SummaryRows variant="bill" rows={[{ label: 'Total', value: <strong>{formatPaise(total)}</strong> }]} />}
                {open && (
                  <>
                    <Button block loading={busy} disabled={!lines.length || data!.items.some(invalid)} onClick={() => void dispense()}>
                      {fullNow ? 'Dispense in full' : 'Dispense partly'}
                    </Button>
                    {!canGiveAll && <p className="muted">Some items are short or not stocked; give what is available and the rest stays in the queue.</p>}
                  </>
                )}
              </div>
            </Card>
          </>
        }
      />
    </StaffLayout>
  );
}
