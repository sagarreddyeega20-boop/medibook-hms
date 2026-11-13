import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge, Button, Card, DashGrid, EmptyState, NowConsultingCard, PersonCell, PersonList, StatCard, StatGrid, Table, useToast, type Column,
} from '../../components';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { greeting } from '../../lib/format';
import { useLive } from '../../lib/live';
import { longDayLabel, timeLabel, todayKey, whenLabel } from '../../lib/time';
import { StaffLayout } from '../staff/StaffLayout';
import { patientMeta } from './clinical';

interface PatientRef { id: string; name: string; mrn: string; gender: string; age: number | null }
interface Row {
  key: string;
  time: string;
  kind: 'APPOINTMENT' | 'WALK_IN';
  ref: string;
  reason: string | null;
  token: number | null;
  status: string;
  visitId: string | null;
  patient: PatientRef | null;
  referral: boolean;
}
interface Dashboard {
  date: string;
  doctor: { id: string; name: string; staffCode: string };
  stats: { today: number; completed: number; waiting: number; cancelled: number };
  rows: Row[];
  current: { visitId: string; token: number | null; since: string | null; complaint: string | null; patient: PatientRef | null } | null;
  referrals: { id: string; orderNumber: string; status: string; priority: string; scheduledFor: string | null; patient: PatientRef | null; fromDoctor: { name: string; department: string | null } }[];
}
interface Found { id: string; name: string; mrn: string; gender: string; dateOfBirth: string | null; phone: string | null }

/** DOCTOR home: v1 doctor dashboard — today's queue with Start consult / Mark done, stats, now consulting, referrals. */
export function DoctorHome() {
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState<Dashboard | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<Found[] | null>(null);

  const load = useCallback(async () => setData(await api<Dashboard>('/api/visits/dashboard')), []);
  useEffect(() => {
    load().catch((err) => toast.error('Could not load your schedule', errorMessage(err)));
  }, [load, toast]);
  useLive(['slots:changed'], () => void load().catch(() => undefined)); // check-ins, bookings, cancellations
  useEffect(() => {
    const t = window.setInterval(() => void load().catch(() => undefined), 60_000);
    return () => window.clearInterval(t);
  }, [load]);

  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) return setFound(null);
    const t = window.setTimeout(() => {
      api<{ patients: Found[] }>(`/api/visits/patients/search?q=${encodeURIComponent(q)}`).then((r) => setFound(r.patients)).catch(() => setFound([]));
    }, 250);
    return () => window.clearTimeout(t);
  }, [search]);

  const act = async (visitId: string, action: 'start' | 'complete') => {
    setBusy(visitId);
    try {
      await api(`/api/visits/${visitId}/${action}`, { method: 'POST' });
      if (action === 'start') navigate(`/doctor/visits/${visitId}`);
      else {
        toast.success('Consultation completed', 'The visit is closed and the consultation fee was added to the bill.');
        await load();
      }
    } catch (err) {
      toast.error(action === 'start' ? 'Could not start the consult' : 'Could not mark it done', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const action = (r: Row) => {
    if (r.status === 'CHECKED_IN' && r.visitId) {
      return <Button size="sm" loading={busy === r.visitId} disabled={!!data?.current} title={data?.current ? 'Finish the current consultation first' : undefined} onClick={() => void act(r.visitId!, 'start')}>Start consult</Button>;
    }
    if (r.status === 'IN_CONSULTATION' && r.visitId) return <Button size="sm" onClick={() => navigate(`/doctor/visits/${r.visitId}`)}>Open</Button>;
    if (r.status === 'COMPLETED' && r.visitId) return <Button variant="secondary" size="sm" onClick={() => navigate(`/doctor/visits/${r.visitId}`)}>View notes</Button>;
    if (r.status === 'CANCELLED' || !r.patient) return <span className="muted">—</span>;
    return <Button variant="secondary" size="sm" onClick={() => navigate(`/doctor/patients/${r.patient!.id}`)}>Patient history</Button>;
  };

  const columns: Column<Row>[] = [
    { key: 'time', header: 'Time', render: (r) => <span className="mb-time">{timeLabel(r.time)}</span> },
    { key: 'patient', header: 'Patient', render: (r) => <PersonCell name={r.patient?.name ?? 'Patient'} sub={r.patient ? patientMeta(r.patient) : undefined} /> },
    {
      key: 'reason', header: 'Reason',
      render: (r) => (
        <div className="stack" style={{ gap: 'var(--space-1)' }}>
          <span>{r.reason ?? '—'}</span>
          <div className="row" style={{ gap: 'var(--space-1)' }}>
            {r.kind === 'WALK_IN' && <Badge status="WALK_IN" size="sm" />}
            {r.referral && <Badge status="REFERRAL" size="sm">Referral</Badge>}
          </div>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
    { key: 'action', header: 'Action', render: action },
  ];

  const first = user?.name.replace(/^Dr\.?\s+/i, '').split(' ')[0] ?? '';
  const c = data?.current;
  return (
    <StaffLayout
      title={`${greeting()}, Dr. ${first}`}
      subtitle={`${longDayLabel(todayKey())} · ${user?.staffCode ?? ''}`}
      search={{ placeholder: 'Search Patient ID or name', value: search, onChange: setSearch }}
      actions={c ? <Button onClick={() => navigate(`/doctor/visits/${c.visitId}`)}>Open consultation</Button> : undefined}
    >
      <StatGrid label="Today at a glance">
        <StatCard label="Today’s appointments" value={data?.stats.today ?? '—'} />
        <StatCard label="Completed" value={data?.stats.completed ?? '—'} tone="teal" />
        <StatCard label="Waiting / upcoming" value={data?.stats.waiting ?? '—'} tone="blue" />
        <StatCard label="Cancelled" value={data?.stats.cancelled ?? '—'} tone="danger" />
      </StatGrid>

      {found && (
        <Card title={`Patients matching “${search.trim()}”`} subtitle="Opening a record you have no visit, order or referral with needs break-glass access." actions={<Button variant="ghost" size="sm" onClick={() => setSearch('')}>Clear</Button>}>
          {found.length ? (
            <PersonList items={found.map((p) => ({ key: p.id, name: p.name, sub: `${p.mrn}${p.phone ? ` · ${p.phone}` : ''}`, action: <Button variant="link" onClick={() => navigate(`/doctor/patients/${p.id}`)}>Open record</Button> }))} />
          ) : (
            <p className="muted">No patient found.</p>
          )}
        </Card>
      )}

      <DashGrid
        main={
          <Card flush>
            <div className="mb-card__head" style={{ padding: 'var(--space-5) var(--space-6) 0' }}>
              <h2 className="mb-card__title">Today’s schedule</h2>
              <Badge tone="success" dot size="sm">Live</Badge>
            </div>
            <Table
              columns={columns}
              rows={data?.rows ?? []}
              rowKey={(r) => r.key}
              isCurrent={(r) => r.status === 'IN_CONSULTATION'}
              caption="Today’s schedule"
              empty={<EmptyState title={data ? 'No patients today' : 'Loading…'} text={data ? 'Booked appointments and walk-ins checked in by reception appear here.' : undefined} />}
            />
          </Card>
        }
        side={
          <>
            <NowConsultingCard
              patient={c?.patient ? { name: c.patient.name, meta: patientMeta(c.patient), status: 'IN_CONSULTATION' } : undefined}
              facts={c ? [c.token ? `Token T${c.token}` : '', c.since ? `Since ${timeLabel(c.since)}` : ''].filter(Boolean) : undefined}
              intakeLabel="Complaint"
              intake={c?.complaint ?? undefined}
            >
              {c && (
                <div className="stack">
                  <Button block onClick={() => navigate(`/doctor/visits/${c.visitId}`)}>Open consultation</Button>
                  <Button block variant="secondary" loading={busy === c.visitId} onClick={() => void act(c.visitId, 'complete')}>Mark done</Button>
                </div>
              )}
            </NowConsultingCard>
            <Card title="Referrals to you" subtitle="Patients other doctors referred to you.">
              {data?.referrals.length ? (
                <PersonList
                  items={data.referrals.map((r) => ({
                    key: r.id,
                    name: r.patient?.name ?? 'Patient',
                    sub: `From ${r.fromDoctor.name}${r.fromDoctor.department ? ` · ${r.fromDoctor.department}` : ''}${r.scheduledFor ? ` · ${whenLabel(r.scheduledFor)}` : ''}`,
                    action: r.patient ? <Button variant="link" onClick={() => navigate(`/doctor/patients/${r.patient!.id}`)}>Timeline</Button> : undefined,
                  }))}
                />
              ) : (
                <p className="muted">No open referrals.</p>
              )}
            </Card>
          </>
        }
      />
    </StaffLayout>
  );
}
