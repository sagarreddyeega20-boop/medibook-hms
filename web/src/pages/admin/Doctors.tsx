import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AvailabilityChips, Badge, Button, Card, DashGrid, EmptyState, Input, PersonCell, PersonList, Select, StatCard, StatGrid, Table, useToast, type Column,
} from '../../components';
import { api, errorMessage } from '../../lib/api';
import { formatPaise } from '../../lib/format';
import { DAY_SHORT, todayKey, toHHMM } from '../../lib/time';
import { StaffLayout } from '../staff/StaffLayout';

interface Doctor {
  id: string;
  staffCode: string;
  fullName: string;
  specialty: string | null;
  slotMinutes: number | null;
  isActive: boolean;
  department: { id: string; code: string; name: string } | null;
  consultationFeePaise: number | null;
  feeSource: 'DOCTOR' | 'DEPARTMENT' | null;
}
interface Department { id: string; code: string; name: string; kind: string; isActive: boolean }
interface Session { dayOfWeek: number; start: string; end: string; slotMinutes: number }
interface Leave { id: string; startsAt: string; endsAt: string; reason: string | null }

const DAY_OPTIONS = [1, 2, 3, 4, 5, 6, 0].map((d) => ({ value: String(d), label: DAY_SHORT[d]! }));
const SLOT_OPTIONS = [10, 15, 20, 30, 45, 60].map((m) => ({ value: String(m), label: `${m} min` }));
const leaveFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** Admin: doctor profiles (department, specialty, consultation fee via the service catalogue), weekly schedules and leaves. */
export function Doctors() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const deptFilter = params.get('department') ?? '';
  const [doctors, setDoctors] = useState<Doctor[] | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [profile, setProfile] = useState({ departmentId: '', specialty: '', feeRupees: '', slotMinutes: '15' });
  const [sessions, setSessions] = useState<Session[]>([]);
  const [leaves, setLeaves] = useState<Leave[]>([]);
  const [leaveForm, setLeaveForm] = useState({ startDate: todayKey(), endDate: todayKey(), startTime: '', endTime: '', reason: '' });
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [d, deps] = await Promise.all([api<{ doctors: Doctor[] }>('/api/staff/doctors'), api<{ departments: Department[] }>('/api/staff/departments')]);
    setDoctors(d.doctors);
    setDepartments(deps.departments.filter((x) => x.kind === 'CLINICAL' && x.isActive));
  }, []);
  useEffect(() => {
    load().catch((err) => toast.error('Could not load doctors', errorMessage(err)));
  }, [load, toast]);

  const selected = doctors?.find((d) => d.id === selectedId) ?? null;

  const loadSchedule = useCallback(async (id: string) => {
    const r = await api<{ schedule: { dayOfWeek: number; startMinute: number; endMinute: number; slotMinutes: number }[]; leaves: Leave[] }>(`/api/scheduling/doctors/${id}/schedule`);
    setSessions(r.schedule.map((s) => ({ dayOfWeek: s.dayOfWeek, start: toHHMM(s.startMinute), end: toHHMM(s.endMinute), slotMinutes: s.slotMinutes })));
    setLeaves(r.leaves);
  }, []);

  useEffect(() => {
    if (!selected) return;
    setProfile({
      departmentId: selected.department?.id ?? '',
      specialty: selected.specialty ?? '',
      feeRupees: selected.consultationFeePaise !== null ? String(selected.consultationFeePaise / 100) : '',
      slotMinutes: String(selected.slotMinutes ?? 15),
    });
    loadSchedule(selected.id).catch((err) => toast.error('Could not load the schedule', errorMessage(err)));
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (doctors ?? []).filter(
      (d) => (!deptFilter || d.department?.id === deptFilter) && (!q || `${d.fullName} ${d.staffCode} ${d.specialty} ${d.department?.name}`.toLowerCase().includes(q)),
    );
  }, [doctors, search, deptFilter]);

  const saveProfile = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    const fee = profile.feeRupees.trim() === '' ? undefined : Math.round(Number(profile.feeRupees) * 100);
    if (fee !== undefined && (!Number.isFinite(fee) || fee < 0)) return toast.error('Enter the fee in rupees, e.g. 600');
    setBusy('profile');
    try {
      await api(`/api/staff/doctors/${selected.id}`, {
        method: 'PATCH',
        json: { departmentId: profile.departmentId || undefined, specialty: profile.specialty || null, consultationFeePaise: fee, slotMinutes: Number(profile.slotMinutes) },
      });
      await load();
      toast.success('Profile saved', fee !== undefined ? `Consultation fee ${formatPaise(fee)} is in the service catalogue.` : undefined);
    } catch (err) {
      toast.error('Could not save the profile', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const saveSchedule = async () => {
    if (!selected) return;
    setBusy('schedule');
    try {
      await api(`/api/scheduling/doctors/${selected.id}/schedule`, { method: 'PUT', json: { sessions } });
      await loadSchedule(selected.id);
      toast.success('Weekly schedule saved', 'Reception and the patient portal see the new slots now.');
    } catch (err) {
      toast.error('Could not save the schedule', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const addLeave = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setBusy('leave');
    try {
      const body = { startDate: leaveForm.startDate, endDate: leaveForm.endDate, startTime: leaveForm.startTime || undefined, endTime: leaveForm.endTime || undefined, reason: leaveForm.reason || undefined };
      const r = await api<{ affectedAppointments: number }>(`/api/scheduling/doctors/${selected.id}/leaves`, { json: body });
      await loadSchedule(selected.id);
      setLeaveForm({ ...leaveForm, reason: '' });
      if (r.affectedAppointments) toast.show({ tone: 'warning', title: 'Leave added', message: `${r.affectedAppointments} booked appointment${r.affectedAppointments === 1 ? ' falls' : 's fall'} inside it. Reception should reschedule ${r.affectedAppointments === 1 ? 'it' : 'them'}.` }, 7000);
      else toast.success('Leave added', 'Those slots are closed for booking.');
    } catch (err) {
      toast.error('Could not add the leave', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const removeLeave = async (id: string) => {
    if (!selected) return;
    try {
      await api(`/api/scheduling/leaves/${id}`, { method: 'DELETE' });
      await loadSchedule(selected.id);
      toast.success('Leave removed');
    } catch (err) {
      toast.error('Could not remove the leave', errorMessage(err));
    }
  };

  const setSession = (i: number, patch: Partial<Session>) => setSessions((xs) => xs.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const daysOpen = DAY_OPTIONS.map((o) => ({ day: o.label, open: sessions.some((s) => s.dayOfWeek === Number(o.value)) }));

  const columns: Column<Doctor>[] = [
    { key: 'who', header: 'Doctor', render: (d) => <PersonCell name={d.fullName} sub={d.staffCode} /> },
    { key: 'dept', header: 'Department', render: (d) => <PersonCell name={d.department?.name ?? '—'} sub={d.specialty ?? undefined} /> },
    { key: 'fee', header: 'Fee', numeric: true, render: (d) => (d.consultationFeePaise !== null ? formatPaise(d.consultationFeePaise) : '—') },
    { key: 'status', header: 'Status', render: (d) => <Badge status={d.isActive ? 'ACTIVE' : 'DEACTIVATED'} /> },
  ];

  return (
    <StaffLayout
      title="Doctors & schedules"
      subtitle="Department, specialty and fee per doctor; weekly sessions and leaves drive every bookable slot."
      search={{ placeholder: 'Search doctor, staff ID or specialty', value: search, onChange: setSearch }}
      actions={
        <Select
          aria-label="Filter by department"
          value={deptFilter}
          placeholder="All departments"
          options={departments.map((d) => ({ value: d.id, label: d.name }))}
          onChange={(e) => setParams(e.target.value ? { department: e.target.value } : {})}
        />
      }
    >
      <StatGrid label="Doctors summary">
        <StatCard label="Doctors" value={doctors ? doctors.filter((d) => d.isActive).length : '—'} />
        <StatCard label="Clinical departments" value={departments.length} tone="teal" />
        <StatCard label="Shown" value={filtered.length} tone="blue" />
        <StatCard label="No department" value={doctors ? doctors.filter((d) => !d.department).length : '—'} tone="danger" />
      </StatGrid>
      <DashGrid
        main={
          <Card title="Doctors" subtitle="New doctors are created in Staff & roles with the Doctor role." flush>
            <Table columns={columns} rows={filtered} rowKey={(d) => d.id} onRowClick={(d) => setSelectedId(d.id)} isCurrent={(d) => d.id === selectedId} caption="Doctors" />
          </Card>
        }
        side={
          !selected ? (
            <Card title="Doctor profile">
              <EmptyState title="Select a doctor" text="Set their department, specialty, fee, weekly sessions and leaves." />
            </Card>
          ) : (
            <>
              <Card title={selected.fullName} subtitle={`${selected.staffCode} · ${selected.department?.name ?? 'No department'}`}>
                <form className="stack" onSubmit={saveProfile}>
                  <Select label="Department" value={profile.departmentId} placeholder="Choose…" options={departments.map((d) => ({ value: d.id, label: d.name }))} onChange={(e) => setProfile({ ...profile, departmentId: e.target.value })} />
                  <Input label="Specialty" placeholder="e.g. Interventional cardiology" value={profile.specialty} onChange={(e) => setProfile({ ...profile, specialty: e.target.value })} />
                  <Input
                    label="Consultation fee (₹)"
                    inputMode="decimal"
                    value={profile.feeRupees}
                    onChange={(e) => setProfile({ ...profile, feeRupees: e.target.value })}
                    hint={selected.feeSource === 'DEPARTMENT' ? 'Using the department’s standard fee. Enter a fee to set this doctor’s own.' : 'Saved as this doctor’s item in the service catalogue.'}
                  />
                  <Select label="Default slot length" value={profile.slotMinutes} options={SLOT_OPTIONS} onChange={(e) => setProfile({ ...profile, slotMinutes: e.target.value })} />
                  <div><Button type="submit" loading={busy === 'profile'}>Save profile</Button></div>
                </form>
              </Card>

              <Card title="Weekly schedule" subtitle="Hospital time (IST). Each session is split into slots.">
                <div className="stack">
                  <AvailabilityChips days={daysOpen} legend={`${sessions.length} session${sessions.length === 1 ? '' : 's'}`} />
                  {sessions.map((s, i) => (
                    <div className="mb-sched-row" key={i}>
                      <Select label="Day" value={String(s.dayOfWeek)} options={DAY_OPTIONS} onChange={(e) => setSession(i, { dayOfWeek: Number(e.target.value) })} />
                      <Input label="From" type="time" value={s.start} onChange={(e) => setSession(i, { start: e.target.value })} />
                      <Input label="To" type="time" value={s.end} onChange={(e) => setSession(i, { end: e.target.value })} />
                      <Select label="Slot" value={String(s.slotMinutes)} options={SLOT_OPTIONS} onChange={(e) => setSession(i, { slotMinutes: Number(e.target.value) })} />
                      <Button variant="ghost" size="sm" aria-label={`Remove ${DAY_SHORT[s.dayOfWeek]} ${s.start} session`} onClick={() => setSessions((xs) => xs.filter((_, j) => j !== i))}>Remove</Button>
                    </div>
                  ))}
                  <div className="row">
                    <Button variant="secondary" size="sm" onClick={() => setSessions((xs) => [...xs, { dayOfWeek: 1, start: '09:00', end: '13:00', slotMinutes: Number(profile.slotMinutes) || 15 }])}>Add session</Button>
                    <Button size="sm" loading={busy === 'schedule'} onClick={saveSchedule}>Save schedule</Button>
                  </div>
                </div>
              </Card>

              <Card title="Leaves" subtitle="Slots inside a leave can’t be booked; the doctor shows On leave.">
                <div className="stack">
                  {leaves.length ? (
                    <PersonList
                      items={leaves.map((l) => ({
                        key: l.id,
                        name: `${leaveFmt.format(new Date(l.startsAt))} → ${leaveFmt.format(new Date(l.endsAt))}`,
                        sub: l.reason ?? 'No reason given',
                        action: <Button variant="link" onClick={() => void removeLeave(l.id)}>Remove</Button>,
                      }))}
                    />
                  ) : (
                    <p className="muted">No leaves in the last 30 days or ahead.</p>
                  )}
                  <form className="stack" onSubmit={addLeave}>
                    <div className="grid-2">
                      <Input label="From date" type="date" value={leaveForm.startDate} onChange={(e) => setLeaveForm({ ...leaveForm, startDate: e.target.value })} />
                      <Input label="To date" type="date" value={leaveForm.endDate} onChange={(e) => setLeaveForm({ ...leaveForm, endDate: e.target.value })} />
                      <Input label="From time (optional)" type="time" value={leaveForm.startTime} onChange={(e) => setLeaveForm({ ...leaveForm, startTime: e.target.value })} />
                      <Input label="To time (optional)" type="time" value={leaveForm.endTime} onChange={(e) => setLeaveForm({ ...leaveForm, endTime: e.target.value })} />
                    </div>
                    <Input label="Reason" placeholder="e.g. Conference" value={leaveForm.reason} onChange={(e) => setLeaveForm({ ...leaveForm, reason: e.target.value })} />
                    <div><Button type="submit" variant="secondary" loading={busy === 'leave'}>Add leave</Button></div>
                  </form>
                </div>
              </Card>
            </>
          )
        }
      />
    </StaffLayout>
  );
}
