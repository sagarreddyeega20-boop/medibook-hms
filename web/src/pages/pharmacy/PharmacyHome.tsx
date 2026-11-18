import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge, Button, Card, DashGrid, EmptyState, PersonCell, PersonList, StatCard, StatGrid, SummaryRows, Table, useToast, type Column } from '../../components';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatPaise, greeting } from '../../lib/format';
import { useLive } from '../../lib/live';
import { longDayLabel, todayKey, whenLabel } from '../../lib/time';
import { patientMeta } from '../doctor/clinical';
import { StaffLayout } from '../staff/StaffLayout';
import type { StockMedicine } from './types';

interface QueueRow {
  id: string;
  orderNumber: string | null;
  status: string;
  createdAt: string;
  patient: { id: string; name: string; mrn: string; gender: string; age: number | null } | null;
  doctor: { name: string; department: string | null };
  items: number;
  remaining: number;
  medicines: string[];
}
interface Dashboard {
  stats: { toDispense: number; dispensedToday: number; lowStock: number; outOfStock: number; salesTodayPaise: number; marginTodayPaise: number };
  queue: QueueRow[];
  lowStock: StockMedicine[];
}

/** PHARMACIST home: v1 staff dashboard — prescriptions waiting to be dispensed, stock alerts and today's sales. */
export function PharmacyHome() {
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState<Dashboard | null>(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => setData(await api<Dashboard>('/api/pharmacy/dashboard')), []);
  useEffect(() => {
    load().catch((err) => toast.error('Could not load prescriptions', errorMessage(err)));
  }, [load, toast]);
  useLive(['orders:changed'], () => void load().catch(() => undefined));

  const q = search.trim().toLowerCase();
  const rows = useMemo(
    () => (data?.queue ?? []).filter((r) => !q || [r.patient?.name, r.patient?.mrn, r.orderNumber, r.doctor.name, ...r.medicines].some((s) => s?.toLowerCase().includes(q))),
    [data, q],
  );

  const columns: Column<QueueRow>[] = [
    { key: 'patient', header: 'Patient', render: (r) => <PersonCell name={r.patient?.name ?? 'Patient'} sub={r.patient ? patientMeta(r.patient) : undefined} /> },
    { key: 'meds', header: 'Medicines', render: (r) => <PersonCell wrap name={`${r.items} item${r.items === 1 ? '' : 's'} · ${r.remaining} to give`} sub={r.medicines.join(', ')} /> },
    { key: 'doctor', header: 'Prescribed by', render: (r) => <PersonCell wrap name={r.doctor.name} sub={[r.orderNumber, whenLabel(r.createdAt)].filter(Boolean).join(' · ')} /> },
    { key: 'status', header: 'Status', render: (r) => <Badge status={r.status === 'ACTIVE' ? 'AWAITING' : r.status}>{r.status === 'ACTIVE' ? 'To dispense' : undefined}</Badge> },
    { key: 'action', header: 'Action', render: (r) => <Button size="sm" onClick={() => navigate(`/pharmacy/dispense/${r.id}`)}>Dispense</Button> },
  ];

  const s = data?.stats;
  return (
    <StaffLayout
      title={`${greeting()}, ${user?.name.split(' ')[0] ?? ''}`}
      subtitle={`${longDayLabel(todayKey())} · Pharmacy`}
      search={{ placeholder: 'Search patient, MRN or medicine', value: search, onChange: setSearch }}
      actions={<Link className="mb-btn mb-btn--secondary" to="/pharmacy/stock">Stock</Link>}
    >
      <StatGrid label="Pharmacy at a glance">
        <StatCard label="To dispense" value={s?.toDispense ?? '—'} />
        <StatCard label="Dispensed today" value={s?.dispensedToday ?? '—'} tone="teal" />
        <StatCard label="Low stock" value={s?.lowStock ?? '—'} tone="blue" />
        <StatCard label="Out of stock" value={s?.outOfStock ?? '—'} tone="danger" />
      </StatGrid>

      <DashGrid
        main={
          <Card flush>
            <div className="mb-card__head" style={{ padding: 'var(--space-5) var(--space-6) 0' }}>
              <h2 className="mb-card__title">Prescriptions to dispense</h2>
              <Badge tone="success" dot size="sm">Live</Badge>
            </div>
            <Table
              columns={columns}
              rows={rows}
              rowKey={(r) => r.id}
              onRowClick={(r) => navigate(`/pharmacy/dispense/${r.id}`)}
              caption="Prescriptions to dispense"
              empty={<EmptyState title={data ? (q ? 'No prescription matches your search' : 'Nothing to dispense') : 'Loading…'} text={data && !q ? 'Prescriptions appear here as soon as a doctor writes them.' : undefined} />}
            />
          </Card>
        }
        side={
          <>
            <Card title="Stock alerts" subtitle="Below the reorder level." actions={data?.lowStock.length ? <Badge tone="danger" dot size="sm">{data.lowStock.length}</Badge> : undefined}>
              {data?.lowStock.length ? (
                <PersonList
                  items={data.lowStock.slice(0, 8).map((m) => ({
                    key: m.id,
                    name: m.name,
                    sub: `${m.stockQuantity} left · reorder at ${m.reorderLevel}`,
                    action: <Badge status={m.level} size="sm" />,
                  }))}
                />
              ) : (
                <p className="muted">{data ? 'All medicines are above their reorder level.' : 'Loading…'}</p>
              )}
              <div className="row" style={{ marginTop: 'var(--space-4)' }}>
                <Link className="mb-btn mb-btn--link" to="/pharmacy/stock">Manage stock</Link>
              </div>
            </Card>
            <Card title="Today">
              <SummaryRows
                rows={[
                  { label: 'Medicine sales', value: s ? formatPaise(s.salesTodayPaise) : '—' },
                  { label: 'Pharmacy margin', value: s ? formatPaise(s.marginTodayPaise) : '—' },
                ]}
              />
            </Card>
          </>
        }
      />
    </StaffLayout>
  );
}
