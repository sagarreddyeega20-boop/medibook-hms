import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, DashGrid, PersonCell, Select, StatCard, StatGrid, Table, useToast, type Column } from '../../components';
import { api, errorMessage } from '../../lib/api';
import { StaffLayout } from '../staff/StaffLayout';

interface Entry {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  actor: { name: string; code: string | null } | null;
  patient: { id: string; name: string; mrn: string | null } | null;
  reason: string | null;
  ip: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

const ACTIONS = [
  'LOGIN_SUCCESS', 'LOGIN_FAILED', 'ACCOUNT_LOCKED', 'OTP_FAILED', 'OTP_LOCKED', 'LOGOUT', 'PASSWORD_SET',
  'STAFF_CREATED', 'STAFF_INVITE_SENT', 'ROLE_CHANGED', 'STAFF_DEACTIVATED', 'PATIENT_REGISTERED', 'ACCESS_DENIED',
  'BREAK_GLASS', 'VIEW', 'NOTE_SAVED', 'ORDER_CREATED', 'REFERRAL_CREATED', 'REFERRAL_BOOKED', 'PRESCRIPTION_CREATED', 'CHARGE_CREATED',
];
const dt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Kolkata' });

/** Short human summary of an event's metadata. */
function details(e: Entry): string {
  const m = e.metadata ?? {};
  const s = (k: string) => (m[k] === undefined || m[k] === null ? undefined : String(m[k]));
  switch (e.action) {
    case 'ROLE_CHANGED': return `${s('staffCode')}: ${s('from')} → ${s('to')}`;
    case 'STAFF_CREATED': return `${s('staffCode')} · ${s('role')} · ${s('department')}`;
    case 'LOGIN_FAILED': return [s('staffId'), s('reason')?.toLowerCase().replace(/_/g, ' ')].filter(Boolean).join(' · ');
    case 'ACCESS_DENIED': return s('reason') === 'NO_CARE_RELATIONSHIP' ? `No care relationship · ${e.entity}` : `${e.entityId ?? ''}`;
    case 'BREAK_GLASS': return `“${e.reason ?? ''}” · ${s('minutes')} min`;
    case 'VIEW': return [e.entity.replace(/_/g, ' '), s('basis')?.toLowerCase().replace(/_/g, '-'), e.reason ? `“${e.reason}”` : null].filter(Boolean).join(' · ');
    case 'OTP_FAILED': return `${s('attemptsRemaining')} attempts left`;
    default: return [s('staffCode'), s('mrn'), s('role'), s('kind')?.toLowerCase()].filter(Boolean).join(' · ');
  }
}

export function AuditLog() {
  const toast = useToast();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [action, setAction] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ entries: Entry[]; last24h: Record<string, number> }>(`/api/audit?limit=200${action ? `&action=${action}` : ''}`);
      setEntries(r.entries);
      setCounts(r.last24h);
    } catch (err) {
      toast.error('Could not load the audit log', errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [action, toast]);

  useEffect(() => void load(), [load]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (entries ?? []).filter((e) => !q || `${e.actor?.name} ${e.actor?.code} ${e.patient?.name} ${e.patient?.mrn} ${details(e)} ${e.ip}`.toLowerCase().includes(q));
  }, [entries, search]);

  const columns: Column<Entry>[] = [
    { key: 'time', header: 'Time (IST)', render: (e) => <span className="mb-time">{dt.format(new Date(e.createdAt))}</span> },
    { key: 'event', header: 'Event', render: (e) => <Badge status={e.action} /> },
    { key: 'actor', header: 'Who', render: (e) => (e.actor ? <PersonCell name={e.actor.name} sub={e.actor.code ?? undefined} /> : <span className="muted">Unknown account</span>) },
    { key: 'patient', header: 'Patient', render: (e) => (e.patient ? <PersonCell name={e.patient.name} sub={e.patient.mrn ?? undefined} /> : <span className="muted">—</span>) },
    { key: 'details', header: 'Details', render: (e) => details(e) || '—' },
    { key: 'ip', header: 'IP', render: (e) => <span className="muted">{e.ip ?? '—'}</span> },
  ];

  const c = (...keys: string[]) => keys.reduce((n, k) => n + (counts[k] ?? 0), 0);

  return (
    <StaffLayout
      title="Audit log"
      subtitle="Every login, staff change, clinical view and break-glass access."
      search={{ placeholder: 'Search person, staff ID or IP', value: search, onChange: setSearch }}
      actions={<Button variant="secondary" onClick={load} loading={loading}>Refresh</Button>}
    >
      <StatGrid label="Last 24 hours">
        <StatCard label="Logins (24 h)" value={c('LOGIN_SUCCESS')} />
        <StatCard label="Failed logins / codes" value={c('LOGIN_FAILED', 'OTP_FAILED')} tone="blue" />
        <StatCard label="Clinical views" value={c('VIEW')} tone="teal" />
        <StatCard label="Break-glass / denied" value={c('BREAK_GLASS', 'ACCOUNT_LOCKED', 'OTP_LOCKED', 'ACCESS_DENIED')} tone="danger" />
      </StatGrid>
      <DashGrid
        main={
          <Card flush>
            <div className="mb-card__head" style={{ padding: 'var(--space-5) var(--space-6) 0' }}>
              <h2 className="mb-card__title">Events</h2>
              <span className="muted">Latest {rows.length}</span>
            </div>
            <Table columns={columns} rows={rows} rowKey={(e) => e.id} caption="Audit events" />
          </Card>
        }
        side={
          <Card title="Filter">
            <Select
              label="Event type"
              placeholder="All events"
              value={action}
              onChange={(e) => setAction(e.target.value)}
              options={ACTIONS.map((a) => ({ value: a, label: a.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (x) => x.toUpperCase()) }))}
            />
            <p className="mb-hint" style={{ marginTop: 'var(--space-3)' }}>The audit log is append-only. Times are shown in IST and stored in UTC.</p>
          </Card>
        }
      />
    </StaffLayout>
  );
}
