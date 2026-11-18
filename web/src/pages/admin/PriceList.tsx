import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, DashGrid, EmptyState, Input, Modal, PersonCell, SummaryRows, Table, Tabs, useToast, type Column } from '../../components';
import { api, errorMessage } from '../../lib/api';
import { paiseToInput, rupeesInputToPaise } from '../../lib/billing';
import { formatPaise } from '../../lib/format';
import { StaffLayout } from '../staff/StaffLayout';

interface Item {
  id: string;
  code: string;
  name: string;
  category: string;
  pricePaise: number;
  taxPercent: number;
  isActive: boolean;
  department: { id: string; code: string; name: string };
}

const CATEGORY_LABELS: Record<string, string> = { CONSULTATION: 'Consultations', LAB_TEST: 'Lab tests', RADIOLOGY_SCAN: 'Scans', MEDICINE: 'Medicines', PROCEDURE: 'Procedures', OTHER: 'Other' };

/** Admin: the service catalogue that drives every bill — price and GST rate per item (consultations default to 0%). */
export function PriceList() {
  const toast = useToast();
  const [items, setItems] = useState<Item[] | null>(null);
  const [tab, setTab] = useState('CONSULTATION');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Item | null>(null);
  const [price, setPrice] = useState('');
  const [tax, setTax] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => setItems((await api<{ items: Item[] }>('/api/billing/catalogue')).items), []);
  useEffect(() => {
    load().catch((err) => toast.error('Could not load the price list', errorMessage(err)));
  }, [load, toast]);

  const counts = useMemo(() => (items ?? []).reduce<Record<string, number>>((m, i) => ({ ...m, [i.category]: (m[i.category] ?? 0) + 1 }), {}), [items]);
  const q = search.trim().toLowerCase();
  const rows = (items ?? []).filter((i) => i.category === tab && (!q || [i.name, i.code, i.department.name].some((s) => s.toLowerCase().includes(q))));

  const edit = (i: Item) => {
    setEditing(i);
    setPrice(paiseToInput(i.pricePaise));
    setTax(String(i.taxPercent));
  };
  const pricePaise = rupeesInputToPaise(price);
  const taxPercent = /^\d{1,2}$/.test(tax.trim()) ? Number(tax) : null;
  const save = async () => {
    if (!editing || pricePaise === null || taxPercent === null) return;
    setBusy(true);
    try {
      await api(`/api/billing/catalogue/${editing.id}`, { method: 'PATCH', json: { pricePaise, taxPercent } });
      toast.success(`${editing.name} updated`, 'New bills use this price and rate; earlier bills keep theirs.');
      setEditing(null);
      await load();
    } catch (err) {
      toast.error('Could not save', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<Item>[] = [
    { key: 'name', header: 'Item', render: (i) => <PersonCell name={i.name} sub={i.code} /> },
    { key: 'dept', header: 'Department', render: (i) => i.department.name },
    { key: 'price', header: 'Price', numeric: true, render: (i) => formatPaise(i.pricePaise) },
    { key: 'tax', header: 'GST', numeric: true, render: (i) => (i.taxPercent ? `${i.taxPercent}%` : 'Exempt') },
    { key: 'status', header: 'Status', render: (i) => <Badge status={i.isActive ? 'ACTIVE' : 'INACTIVE'} size="sm" /> },
    { key: 'act', header: 'Action', render: (i) => <Button size="sm" variant="secondary" onClick={() => edit(i)}>Edit</Button> },
  ];

  return (
    <StaffLayout title="Prices & tax" subtitle="Service catalogue · every bill line comes from here" search={{ placeholder: 'Search item, code or department', value: search, onChange: setSearch }}>
      <DashGrid
        main={
          <Card flush>
            <div style={{ padding: 'var(--space-5) var(--space-6) 0' }}>
              <Tabs label="Categories" value={tab} onChange={setTab} tabs={Object.keys(CATEGORY_LABELS).filter((c) => counts[c]).map((c) => ({ id: c, label: CATEGORY_LABELS[c]!, count: counts[c] }))} />
            </div>
            <Table columns={columns} rows={rows} rowKey={(i) => i.id} onRowClick={edit} caption="Price list" empty={<EmptyState title={items ? 'Nothing matches' : 'Loading…'} />} />
          </Card>
        }
        side={
          <Card title="How tax works">
            <p className="muted">Each item carries its own GST rate. Consultations, tests and scans are exempt (0%); medicines default to 5%. The rate is copied onto the bill line when the charge is made, so changing it here never alters a bill already issued.</p>
          </Card>
        }
      />
      <Modal
        open={!!editing}
        title={editing ? editing.name : 'Edit item'}
        onClose={() => setEditing(null)}
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button loading={busy} disabled={pricePaise === null || taxPercent === null || taxPercent > 28} onClick={save}>Save</Button></>}
      >
        {editing && (
          <div className="stack">
            <Input label="Price (₹)" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} error={price && pricePaise === null ? 'Enter an amount like 800 or 12.50' : undefined} />
            <Input label="GST rate (%)" inputMode="numeric" value={tax} onChange={(e) => setTax(e.target.value)} hint="Whole number, 0–28" error={tax && (taxPercent === null || taxPercent > 28) ? 'Enter a whole number from 0 to 28' : undefined} />
            {pricePaise !== null && taxPercent !== null && (
              <SummaryRows variant="bill" rows={[{ label: 'Price', value: formatPaise(pricePaise) }, { label: `GST ${taxPercent}%`, value: formatPaise(Math.round((pricePaise * taxPercent) / 100)) }, { label: 'Patient pays', value: formatPaise(pricePaise + Math.round((pricePaise * taxPercent) / 100)) }]} />
            )}
          </div>
        )}
      </Modal>
    </StaffLayout>
  );
}
