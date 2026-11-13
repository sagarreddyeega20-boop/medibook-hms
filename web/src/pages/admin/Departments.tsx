import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, DashGrid, Input, Modal, PersonCell, Select, StatCard, StatGrid, Table, useToast, type Column } from '../../components';
import { api, errorMessage } from '../../lib/api';
import { StaffLayout } from '../staff/StaffLayout';

interface Department {
  id: string;
  code: string;
  name: string;
  kind: Kind;
  isActive: boolean;
  staffCount: number;
  doctorCount: number;
}
type Kind = 'CLINICAL' | 'LAB' | 'RADIOLOGY' | 'PHARMACY' | 'ADMIN' | 'BILLING';

const KINDS: { value: Kind; label: string }[] = [
  { value: 'CLINICAL', label: 'Clinical (doctors see patients)' },
  { value: 'LAB', label: 'Laboratory' },
  { value: 'RADIOLOGY', label: 'Radiology' },
  { value: 'PHARMACY', label: 'Pharmacy' },
  { value: 'BILLING', label: 'Billing & accounts' },
  { value: 'ADMIN', label: 'Administration / front office' },
];
const kindLabel = (k: Kind) => KINDS.find((x) => x.value === k)?.label.split(' (')[0] ?? k;

const empty = { code: '', name: '', kind: 'CLINICAL' as Kind };

/** Admin: hospital departments. Clinical departments hold doctors and show on the reception board and patient portal. */
export function Departments() {
  const toast = useToast();
  const [rows, setRows] = useState<Department[] | null>(null);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(empty);
  const [edit, setEdit] = useState({ name: '', kind: 'CLINICAL' as Kind });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => setRows((await api<{ departments: Department[] }>('/api/staff/departments')).departments), []);
  useEffect(() => {
    load().catch((err) => toast.error('Could not load departments', errorMessage(err)));
  }, [load, toast]);

  const selected = rows?.find((d) => d.id === selectedId) ?? null;
  useEffect(() => {
    if (selected) setEdit({ name: selected.name, kind: selected.kind });
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (rows ?? []).filter((d) => !q || `${d.code} ${d.name} ${d.kind}`.toLowerCase().includes(q));
  }, [rows, search]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const { department } = await api<{ department: Department }>('/api/staff/departments', { json: form });
      await load();
      setSelectedId(department.id);
      setAdding(false);
      setForm(empty);
      toast.success(`${department.name} created`, department.kind === 'CLINICAL' ? 'Assign doctors to it from Doctors & schedules.' : undefined);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const save = async (patch: Partial<Pick<Department, 'name' | 'kind' | 'isActive'>>, done: string) => {
    if (!selected) return;
    setBusy(true);
    try {
      await api(`/api/staff/departments/${selected.id}`, { method: 'PATCH', json: patch });
      await load();
      toast.success(done);
    } catch (err) {
      toast.error('Could not save', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<Department>[] = [
    { key: 'name', header: 'Department', render: (d) => <PersonCell name={d.name} sub={d.code} /> },
    { key: 'kind', header: 'Type', render: (d) => kindLabel(d.kind) },
    { key: 'doctors', header: 'Doctors', numeric: true, render: (d) => d.doctorCount },
    { key: 'staff', header: 'Staff', numeric: true, render: (d) => d.staffCount },
    { key: 'status', header: 'Status', render: (d) => <Badge status={d.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
  ];

  const active = rows?.filter((d) => d.isActive) ?? [];
  return (
    <StaffLayout
      title="Departments"
      subtitle="Clinical departments hold doctors and appear on the reception board and the patient portal."
      search={{ placeholder: 'Search code or name', value: search, onChange: setSearch }}
      actions={<Button onClick={() => { setError(undefined); setAdding(true); }}>Add department</Button>}
    >
      <StatGrid label="Departments summary">
        <StatCard label="Departments" value={rows ? active.length : '—'} />
        <StatCard label="Clinical" value={rows ? active.filter((d) => d.kind === 'CLINICAL').length : '—'} tone="teal" />
        <StatCard label="Doctors" value={rows ? active.reduce((n, d) => n + d.doctorCount, 0) : '—'} tone="blue" />
        <StatCard label="Inactive" value={rows ? rows.length - active.length : '—'} tone="danger" />
      </StatGrid>
      <DashGrid
        main={
          <Card title="All departments" flush>
            <Table columns={columns} rows={filtered} rowKey={(d) => d.id} onRowClick={(d) => setSelectedId(d.id)} isCurrent={(d) => d.id === selectedId} caption="Departments" />
          </Card>
        }
        side={
          selected ? (
            <Card title={selected.name} subtitle={`${selected.code} · ${selected.doctorCount} doctor${selected.doctorCount === 1 ? '' : 's'}`}>
              <form className="stack" onSubmit={(e) => { e.preventDefault(); void save({ name: edit.name, kind: edit.kind }, 'Department saved'); }}>
                <Input label="Name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                <Select label="Type" value={edit.kind} options={KINDS} onChange={(e) => setEdit({ ...edit, kind: e.target.value as Kind })} />
                <div className="row">
                  <Button type="submit" loading={busy}>Save</Button>
                  {selected.isActive ? (
                    <Button variant="danger-outline" disabled={busy} onClick={() => void save({ isActive: false }, `${selected.name} deactivated`)}>Deactivate</Button>
                  ) : (
                    <Button variant="secondary" disabled={busy} onClick={() => void save({ isActive: true }, `${selected.name} reactivated`)}>Reactivate</Button>
                  )}
                </div>
                {selected.kind === 'CLINICAL' && <Link className="mb-btn mb-btn--link" to={`/admin/doctors?department=${selected.id}`}>Manage its doctors and schedules</Link>}
              </form>
            </Card>
          ) : (
            <Card title="Department details">
              <p className="muted">Select a department to rename it, change its type or deactivate it. Departments are never deleted, so past visits and revenue keep their department.</p>
            </Card>
          )
        }
      />

      <Modal
        open={adding}
        title="Add department"
        onClose={() => setAdding(false)}
        footer={<><Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button><Button type="submit" form="dept-form" loading={busy}>Create department</Button></>}
      >
        <form id="dept-form" className="stack" onSubmit={create}>
          <Input label="Code" placeholder="e.g. ORTHO" hint="2–8 letters, used in reports and catalogue codes" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} maxLength={8} />
          <Input label="Name" placeholder="e.g. Orthopaedics" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Select label="Type" value={form.kind} options={KINDS} onChange={(e) => setForm({ ...form, kind: e.target.value as Kind })} />
          {error && <p className="mb-error-text" role="alert">{error}</p>}
        </form>
      </Modal>
    </StaffLayout>
  );
}
