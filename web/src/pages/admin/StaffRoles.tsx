import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Badge, Button, Card, DashGrid, Input, Modal, PersonCell, Select, StatCard, StatGrid, Table, useToast, type Column,
} from '../../components';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ROLE_LABELS, type Role } from '../../lib/roles';
import { StaffLayout } from '../staff/StaffLayout';

interface StaffRow {
  id: string;
  staffCode: string;
  fullName: string;
  email: string | null;
  role: Role | null;
  department: { id: string; code: string; name: string } | null;
  status: 'ACTIVE' | 'INVITED' | 'LOCKED' | 'DEACTIVATED';
  lastLoginAt: string | null;
  createdAt: string;
}

interface Options {
  departments: { id: string; code: string; name: string }[];
  roles: { code: Role; name: string }[];
}

const emptyForm = { fullName: '', email: '', role: '', departmentId: '' };
const dt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

/** Admin console: create staff (no self sign-up), change roles, deactivate (never delete), resend invites. */
export function StaffRoles() {
  const { user } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState<StaffRow[] | null>(null);
  const [options, setOptions] = useState<Options>({ departments: [], roles: [] });
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState<string | null>(null);
  const [newRole, setNewRole] = useState('');
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);

  const load = useCallback(async () => {
    const [s, o] = await Promise.all([api<{ staff: StaffRow[] }>('/api/staff'), api<Options>('/api/staff/options')]);
    setRows(s.staff);
    setOptions(o);
  }, []);

  useEffect(() => {
    load().catch((err) => toast.error('Could not load staff', errorMessage(err)));
  }, [load, toast]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (rows ?? []).filter((r) => !q || `${r.fullName} ${r.staffCode} ${r.email} ${r.role}`.toLowerCase().includes(q));
  }, [rows, search]);

  const selected = rows?.find((r) => r.id === selectedId) ?? null;
  useEffect(() => setNewRole(selected?.role ?? ''), [selected?.id, selected?.role]);

  const canManage = (r: StaffRow) =>
    r.role !== 'SUPER_ADMIN' && r.email !== null && r.staffCode !== user?.staffCode &&
    (r.role !== 'ADMIN' || !!user?.permissions.includes('staff:create_admin'));

  const replaceRow = (s: StaffRow) => setRows((xs) => xs?.map((x) => (x.id === s.id ? s : x)) ?? null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (form.fullName.trim().length < 2) return setFormError('Enter the full name');
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) return setFormError('Enter a valid work email');
    if (!form.role) return setFormError('Choose a role');
    if (!form.departmentId) return setFormError('Choose a department');
    setBusy('create');
    setFormError(undefined);
    try {
      const { staff } = await api<{ staff: StaffRow }>('/api/staff', { json: form });
      setRows((xs) => [staff, ...(xs ?? [])]);
      setSelectedId(staff.id);
      setAdding(false);
      setForm(emptyForm);
      toast.success(`Staff ID ${staff.staffCode} created`, `A set-password link was emailed to ${staff.email}. It expires in 24 hours.`);
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const changeRole = async () => {
    if (!selected || !newRole || newRole === selected.role) return;
    setBusy('role');
    try {
      const { staff } = await api<{ staff: StaffRow }>(`/api/staff/${selected.id}/role`, { method: 'PATCH', json: { role: newRole } });
      replaceRow(staff);
      toast.success('Role updated', `${staff.fullName} is now ${ROLE_LABELS[staff.role!]}. Their open sessions were ended.`);
    } catch (err) {
      toast.error('Could not change role', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const deactivate = async () => {
    if (!selected) return;
    setBusy('deactivate');
    try {
      const { staff } = await api<{ staff: StaffRow }>(`/api/staff/${selected.id}/deactivate`, { method: 'POST' });
      replaceRow(staff);
      setConfirmDeactivate(false);
      toast.success('Account deactivated', `${staff.fullName} can no longer sign in. Their records are kept.`);
    } catch (err) {
      toast.error('Could not deactivate', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const resendInvite = async () => {
    if (!selected) return;
    setBusy('invite');
    try {
      await api(`/api/staff/${selected.id}/invite`, { method: 'POST' });
      toast.success('Invite sent', `A new set-password link was emailed to ${selected.email}.`);
    } catch (err) {
      toast.error('Could not send invite', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const columns: Column<StaffRow>[] = [
    { key: 'who', header: 'Staff member', render: (r) => <PersonCell name={r.fullName} sub={r.staffCode} /> },
    { key: 'role', header: 'Role', render: (r) => (r.role ? ROLE_LABELS[r.role] : '—') },
    { key: 'dept', header: 'Department', render: (r) => r.department?.name ?? '—' },
    { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
    { key: 'action', header: 'Action', render: (r) => <Button variant="link" onClick={(e) => { e.stopPropagation(); setSelectedId(r.id); }}>Manage</Button> },
  ];

  const count = (s: StaffRow['status']) => rows?.filter((r) => r.status === s).length ?? 0;

  return (
    <StaffLayout
      title="Staff & roles"
      subtitle="Create hospital-issued staff IDs. There is no self sign-up for staff."
      search={{ placeholder: 'Search name, staff ID or role', value: search, onChange: setSearch }}
      actions={<Button onClick={() => { setFormError(undefined); setAdding(true); }}>Add staff</Button>}
    >
      <StatGrid label="Staff summary">
        <StatCard label="Total staff" value={rows?.length ?? '—'} />
        <StatCard label="Active" value={rows ? count('ACTIVE') : '—'} tone="teal" />
        <StatCard label="Invite pending" value={rows ? count('INVITED') : '—'} tone="blue" />
        <StatCard label="Locked / deactivated" value={rows ? count('LOCKED') + count('DEACTIVATED') : '—'} tone="danger" />
      </StatGrid>

      <DashGrid
        main={
          <Card flush>
            <div className="mb-card__head" style={{ padding: 'var(--space-5) var(--space-6) 0' }}>
              <h2 className="mb-card__title">All staff</h2>
              <span className="muted">{filtered.length} shown</span>
            </div>
            <Table
              columns={columns}
              rows={filtered}
              rowKey={(r) => r.id}
              onRowClick={(r) => setSelectedId(r.id)}
              isCurrent={(r) => r.id === selectedId}
              caption="Staff list"
            />
          </Card>
        }
        side={
          <Card title={selected ? selected.fullName : 'Staff details'} subtitle={selected ? `${selected.staffCode} · ${selected.email}` : undefined}>
            {!selected ? (
              <p className="muted">Select a staff member to change their role, resend their invite or deactivate them.</p>
            ) : (
              <div className="stack">
                <dl className="mb-rows">
                  <div><dt>Status</dt><dd><Badge status={selected.status} /></dd></div>
                  <div><dt>Role</dt><dd>{selected.role ? ROLE_LABELS[selected.role] : '—'}</dd></div>
                  <div><dt>Department</dt><dd>{selected.department?.name ?? '—'}</dd></div>
                  <div><dt>Last login</dt><dd>{selected.lastLoginAt ? dt.format(new Date(selected.lastLoginAt)) : 'Never'}</dd></div>
                </dl>
                {!canManage(selected) ? (
                  <p className="muted">
                    {selected.staffCode === user?.staffCode ? 'This is your own account.' : 'Only a Super Admin can manage this account.'}
                  </p>
                ) : selected.status === 'DEACTIVATED' ? (
                  <p className="muted">This account is deactivated. Its history is kept.</p>
                ) : (
                  <>
                    <Select
                      label="Change role"
                      value={newRole}
                      onChange={(e) => setNewRole(e.target.value)}
                      options={options.roles.map((r) => ({ value: r.code, label: r.name }))}
                      hint="Their open sessions end; the new menu applies at next login."
                    />
                    <div className="row">
                      <Button onClick={changeRole} loading={busy === 'role'} disabled={!newRole || newRole === selected.role}>Save role</Button>
                      {selected.status === 'INVITED' && <Button variant="secondary" onClick={resendInvite} loading={busy === 'invite'}>Resend invite</Button>}
                    </div>
                    <Button variant="danger-outline" onClick={() => setConfirmDeactivate(true)}>Deactivate account</Button>
                  </>
                )}
              </div>
            )}
          </Card>
        }
      />

      <Modal
        open={adding}
        title="Add staff"
        onClose={() => setAdding(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
            <Button type="submit" form="add-staff" loading={busy === 'create'}>Create &amp; send invite</Button>
          </>
        }
      >
        <form id="add-staff" className="stack" onSubmit={create} noValidate>
          <Input label="Full name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
          <Input label="Work email" type="email" hint="The set-password link is sent here." value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <Select label="Role" placeholder="Select a role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} options={options.roles.map((r) => ({ value: r.code, label: r.name }))} />
          <Select label="Department" placeholder="Select a department" value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })} options={options.departments.map((d) => ({ value: d.id, label: d.name }))} />
          <p className="mb-hint">The staff ID is generated automatically (e.g. HMS-DOC-0007).</p>
          {formError && <p className="mb-error-text" role="alert">{formError}</p>}
        </form>
      </Modal>

      <Modal
        open={confirmDeactivate}
        title="Deactivate account?"
        onClose={() => setConfirmDeactivate(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDeactivate(false)}>Keep active</Button>
            <Button variant="danger" onClick={deactivate} loading={busy === 'deactivate'}>Deactivate</Button>
          </>
        }
      >
        <p>{selected?.fullName} ({selected?.staffCode}) will be signed out and can no longer log in. Their records and audit history are kept.</p>
      </Modal>
    </StaffLayout>
  );
}
