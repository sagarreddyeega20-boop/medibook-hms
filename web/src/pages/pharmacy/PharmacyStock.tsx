import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Badge, Button, Card, DashGrid, EmptyState, Input, Modal, NowConsultingCard, PersonCell, PersonList, StatCard, StatGrid, SummaryRows, Table, useToast, type Column,
} from '../../components';
import { api, errorMessage } from '../../lib/api';
import { formatPaise } from '../../lib/format';
import { useLive } from '../../lib/live';
import { whenLabel } from '../../lib/time';
import { StaffLayout } from '../staff/StaffLayout';
import type { StockMedicine } from './types';

interface StockList {
  medicines: StockMedicine[];
  stats: { total: number; lowStock: number; outOfStock: number; stockValuePaise: number };
}
interface Movement { id: string; type: string; quantity: number; unitCostPaise: number | null; reference: string | null; createdAt: string; performedBy: string }

/** "12.50" (rupees typed by the pharmacist) → 1250 paise; null when not a valid amount. */
const toPaise = (rupees: string) => {
  const t = rupees.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
};
const rupees = (paise: number) => (paise / 100).toFixed(2);
const label = (m: StockMedicine) => [m.code, m.form, m.strength].filter(Boolean).join(' · ');

/**
 * Pharmacy stock: medicines with selling / purchase price, margin, reorder level and current stock,
 * low-stock badges, stock in (quantity + purchase price, stored on the movement) and new medicines.
 */
export function PharmacyStock() {
  const toast = useToast();
  const [data, setData] = useState<StockList | null>(null);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => setData(await api<StockList>(`/api/pharmacy/medicines?q=${encodeURIComponent(search.trim())}`)), [search]);
  useEffect(() => {
    const t = window.setTimeout(() => void load().catch((err) => toast.error('Could not load stock', errorMessage(err))), 200);
    return () => window.clearTimeout(t);
  }, [load, toast]);
  useLive(['orders:changed'], () => void load().catch(() => undefined)); // dispensing moves stock

  const rows = data?.medicines ?? [];
  const selected = rows.find((m) => m.id === selectedId) ?? null;

  const columns: Column<StockMedicine>[] = [
    { key: 'name', header: 'Medicine', render: (m) => <PersonCell name={m.name} sub={label(m)} /> },
    { key: 'sell', header: 'Selling', numeric: true, render: (m) => formatPaise(m.sellingPricePaise) },
    { key: 'buy', header: 'Purchase', numeric: true, render: (m) => formatPaise(m.purchasePricePaise) },
    { key: 'margin', header: 'Margin', numeric: true, render: (m) => formatPaise(m.marginPaise) },
    { key: 'reorder', header: 'Reorder at', numeric: true, render: (m) => m.reorderLevel },
    { key: 'stock', header: 'In stock', numeric: true, render: (m) => <strong>{m.stockQuantity}</strong> },
    { key: 'level', header: 'Status', render: (m) => (m.isActive ? <Badge status={m.level} /> : <Badge status="INACTIVE" />) },
    { key: 'action', header: 'Action', render: (m) => <Button size="sm" variant={m.id === selectedId ? 'primary' : 'secondary'} onClick={() => setSelectedId(m.id)}>Stock in</Button> },
  ];

  const s = data?.stats;
  return (
    <StaffLayout
      title="Pharmacy stock"
      subtitle="Medicines, prices, reorder levels and deliveries"
      search={{ placeholder: 'Search medicine or code', value: search, onChange: setSearch }}
      actions={<Button onClick={() => setAdding(true)}>Add medicine</Button>}
    >
      <StatGrid label="Stock at a glance">
        <StatCard label="Medicines" value={s?.total ?? '—'} />
        <StatCard label="Stock value (cost)" value={s ? formatPaise(Math.round(s.stockValuePaise / 100) * 100) : '—'} tone="teal" />
        <StatCard label="Low stock" value={s?.lowStock ?? '—'} tone="blue" />
        <StatCard label="Out of stock" value={s?.outOfStock ?? '—'} tone="danger" />
      </StatGrid>

      <DashGrid
        main={
          <Card flush>
            <div className="mb-card__head" style={{ padding: 'var(--space-5) var(--space-6) 0' }}>
              <h2 className="mb-card__title">Medicines</h2>
              <Link className="mb-btn mb-btn--link" to="/pharmacy">Prescriptions</Link>
            </div>
            <Table
              columns={columns}
              rows={rows}
              rowKey={(m) => m.id}
              onRowClick={(m) => setSelectedId(m.id)}
              isCurrent={(m) => m.id === selectedId}
              caption="Medicines and stock"
              empty={<EmptyState title={data ? 'No medicine found' : 'Loading…'} text={data ? 'Add a medicine to the formulary, then stock it in.' : undefined} />}
            />
          </Card>
        }
        side={
          selected ? (
            <MedicinePanel key={selected.id} medicine={selected} onChanged={load} />
          ) : (
            <NowConsultingCard title="Stock in" emptyText="Choose a medicine to record a delivery or change its price and reorder level." />
          )
        }
      />

      <AddMedicine open={adding} onClose={() => setAdding(false)} onAdded={async (m) => { setAdding(false); setSearch(''); setSelectedId(m.id); await load(); }} />
    </StaffLayout>
  );
}

/** Side panel for one medicine: stock in, price / reorder level, recent movements. */
function MedicinePanel({ medicine: m, onChanged }: { medicine: StockMedicine; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [qty, setQty] = useState('');
  const [cost, setCost] = useState(rupees(m.purchasePricePaise));
  const [ref, setRef] = useState('');
  const [sell, setSell] = useState(rupees(m.sellingPricePaise));
  const [reorder, setReorder] = useState(String(m.reorderLevel));
  const [movements, setMovements] = useState<Movement[] | null>(null);
  const [busy, setBusy] = useState<'in' | 'edit' | null>(null);

  const loadMovements = useCallback(() => api<{ movements: Movement[] }>(`/api/pharmacy/medicines/${m.id}`).then((r) => setMovements(r.movements)).catch(() => setMovements([])), [m.id]);
  useEffect(() => void loadMovements(), [loadMovements, m.stockQuantity]);

  const qtyN = /^\d+$/.test(qty) ? Number(qty) : 0;
  const costP = toPaise(cost);
  const stockIn = async () => {
    setBusy('in');
    try {
      await api(`/api/pharmacy/medicines/${m.id}/stock-in`, { json: { quantity: qtyN, unitCostPaise: costP, reference: ref || null } });
      toast.success('Stock added', `${qtyN} × ${m.name} at ${formatPaise(costP!)} each.`);
      setQty('');
      setRef('');
      await onChanged();
    } catch (err) {
      toast.error('Could not add stock', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const sellP = toPaise(sell);
  const reorderN = /^\d+$/.test(reorder) ? Number(reorder) : null;
  const dirty = sellP !== m.sellingPricePaise || reorderN !== m.reorderLevel;
  const save = async () => {
    setBusy('edit');
    try {
      await api(`/api/pharmacy/medicines/${m.id}`, { method: 'PATCH', json: { sellingPricePaise: sellP, reorderLevel: reorderN } });
      toast.success('Medicine updated', m.name);
      await onChanged();
    } catch (err) {
      toast.error('Could not save', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <NowConsultingCard
        title="Stock in"
        patient={{ name: m.name, meta: label(m), status: m.isActive ? m.level : 'INACTIVE' }}
        facts={[`${m.stockQuantity} in stock`, `Reorder at ${m.reorderLevel}`]}
        intakeLabel="Current prices"
        intake={`Sell ${formatPaise(m.sellingPricePaise)} · buy ${formatPaise(m.purchasePricePaise)} · margin ${formatPaise(m.marginPaise)}`}
      >
        <div className="stack">
          <div className="grid-2">
            <Input label="Quantity received" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="e.g. 100" error={qty && !qtyN ? 'Whole number' : undefined} />
            <Input label="Purchase price (₹ each)" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} error={costP === null ? 'e.g. 4.50' : undefined} />
          </div>
          <Input label="Supplier invoice / note (optional)" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="e.g. INV-2041" />
          <Button block loading={busy === 'in'} disabled={!qtyN || costP === null || !m.isActive} onClick={() => void stockIn()}>Add to stock</Button>
        </div>
      </NowConsultingCard>

      <Card title="Price & reorder level" subtitle="Purchase price changes with each delivery.">
        <div className="stack">
          <div className="grid-2">
            <Input label="Selling price (₹)" inputMode="decimal" value={sell} onChange={(e) => setSell(e.target.value)} error={sellP === null ? 'e.g. 8.00' : undefined} />
            <Input label="Reorder level" inputMode="numeric" value={reorder} onChange={(e) => setReorder(e.target.value)} error={reorderN === null ? 'Whole number' : undefined} />
          </div>
          {sellP !== null && <SummaryRows rows={[{ label: 'Margin per unit', value: formatPaise(sellP - m.purchasePricePaise) }]} />}
          <Button variant="secondary" block loading={busy === 'edit'} disabled={!dirty || sellP === null || reorderN === null} onClick={() => void save()}>Save changes</Button>
        </div>
      </Card>

      <Card title="Recent movements">
        {movements?.length ? (
          <PersonList
            items={movements.map((mv) => ({
              key: mv.id,
              name: <>{mv.quantity > 0 ? '+' : '−'}{Math.abs(mv.quantity)} {mv.unitCostPaise !== null && <span className="muted">@ {formatPaise(mv.unitCostPaise)}</span>}</>,
              sub: [whenLabel(mv.createdAt), mv.reference, mv.performedBy].filter(Boolean).join(' · '),
              action: <Badge status={mv.type} size="sm" />,
            }))}
          />
        ) : (
          <p className="muted">{movements ? 'No movements yet.' : 'Loading…'}</p>
        )}
      </Card>
    </>
  );
}

/** New formulary item (stock arrives through Stock in). */
function AddMedicine({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (m: StockMedicine) => Promise<void> }) {
  const toast = useToast();
  const empty = { name: '', genericName: '', strength: '', form: 'tablet', sell: '', buy: '', reorder: '10' };
  const [f, setF] = useState(empty);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  const sell = toPaise(f.sell);
  const buy = toPaise(f.buy);
  const reorder = /^\d+$/.test(f.reorder) ? Number(f.reorder) : null;
  const ok = f.name.trim().length >= 2 && sell !== null && buy !== null && reorder !== null;

  const submit = async () => {
    setBusy(true);
    try {
      const r = await api<{ medicine: StockMedicine }>('/api/pharmacy/medicines', {
        json: { name: f.name, genericName: f.genericName || null, strength: f.strength || null, form: f.form || null, sellingPricePaise: sell, purchasePricePaise: buy, reorderLevel: reorder },
      });
      toast.success('Medicine added', `${r.medicine.name} (${r.medicine.code}). Record a delivery to stock it.`);
      setF(empty);
      await onAdded(r.medicine);
    } catch (err) {
      toast.error('Could not add the medicine', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Add medicine"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={!ok} onClick={() => void submit()}>Add medicine</Button>
        </>
      }
    >
      <div className="stack">
        <Input label="Name (as prescribed)" value={f.name} onChange={set('name')} placeholder="e.g. Amoxicillin 500 mg" />
        <div className="grid-2">
          <Input label="Generic name" value={f.genericName} onChange={set('genericName')} />
          <Input label="Strength" value={f.strength} onChange={set('strength')} placeholder="500 mg" />
        </div>
        <div className="grid-2">
          <Input label="Form" value={f.form} onChange={set('form')} placeholder="tablet, syrup …" />
          <Input label="Reorder level" inputMode="numeric" value={f.reorder} onChange={set('reorder')} />
        </div>
        <div className="grid-2">
          <Input label="Selling price (₹)" inputMode="decimal" value={f.sell} onChange={set('sell')} error={f.sell && sell === null ? 'e.g. 12.50' : undefined} />
          <Input label="Purchase price (₹)" inputMode="decimal" value={f.buy} onChange={set('buy')} error={f.buy && buy === null ? 'e.g. 8.00' : undefined} />
        </div>
      </div>
    </Modal>
  );
}
