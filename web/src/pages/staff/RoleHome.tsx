import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, DashGrid, PersonList, StatCard, StatGrid } from '../../components';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { greeting } from '../../lib/format';
import { useLive } from '../../lib/live';
import { whenLabel } from '../../lib/time';
import { ROLE_HOME, ROLE_LABELS } from '../../lib/roles';
import { StaffLayout } from './StaffLayout';

/** Admin console home (/admin): staff and department counts, today's logins, the admin screens, break-glass alerts. */
interface Overview { activeStaff: number; lockedStaff: number; invited: number; departments: number; clinical: number; logins24h: number; deniedOrBroken24h: number }

const SETUP = [
  { to: '/admin/staff', name: 'Staff & roles', sub: 'Create staff IDs, change roles, resend invites, deactivate' },
  { to: '/admin/departments', name: 'Departments', sub: 'Clinical, lab, radiology, pharmacy and office departments' },
  { to: '/admin/doctors', name: 'Doctors & schedules', sub: 'Specialty, consultation fee, weekly sessions and leaves' },
  { to: '/admin/prices', name: 'Prices & tax', sub: 'Service catalogue: consultations, tests, scans, medicines' },
  { to: '/admin/audit', name: 'Audit log', sub: 'Every login, clinical view, break-glass and refusal' },
];

export function RoleHome() {
  const { user } = useAuth();
  const [o, setO] = useState<Overview | null>(null);

  useEffect(() => {
    if (!user) return;
    void Promise.all([
      api<{ staff: { status: string }[] }>('/api/staff'),
      api<{ departments: { kind: string; isActive?: boolean }[] }>('/api/staff/options'),
      api<{ last24h: Record<string, number> }>('/api/audit?limit=1').catch(() => ({ last24h: {} as Record<string, number> })),
    ]).then(([s, d, a]) => {
      const depts = d.departments.filter((x) => x.isActive !== false);
      const c = (...k: string[]) => k.reduce((n, x) => n + (a.last24h[x] ?? 0), 0);
      setO({
        activeStaff: s.staff.filter((x) => x.status === 'ACTIVE').length,
        lockedStaff: s.staff.filter((x) => x.status === 'LOCKED').length,
        invited: s.staff.filter((x) => x.status === 'INVITED').length,
        departments: depts.length,
        clinical: depts.filter((x) => x.kind === 'CLINICAL').length,
        logins24h: c('LOGIN_SUCCESS'),
        deniedOrBroken24h: c('BREAK_GLASS', 'ACCESS_DENIED'),
      });
    }).catch(() => undefined);
  }, [user]);

  if (!user) return null;
  const first = user.name.split(' ')[0];

  return (
    <StaffLayout title={`${greeting()}, ${first}`} subtitle={`${ROLE_LABELS[user.role]} · ${ROLE_HOME[user.role].title}`}>
      <StatGrid label="At a glance">
        <StatCard label="Active staff" value={o?.activeStaff ?? '—'} />
        <StatCard label="Departments" value={o?.departments ?? '—'} tone="teal" />
        <StatCard label="Logins (24 h)" value={o?.logins24h ?? '—'} tone="blue" />
        <StatCard label="Locked accounts" value={o?.lockedStaff ?? '—'} tone="danger" />
      </StatGrid>
      <DashGrid
        main={
          <Card title="Hospital setup" subtitle={o ? `${o.clinical} clinical departments · ${o.invited} invite${o.invited === 1 ? '' : 's'} pending · ${o.deniedOrBroken24h} break-glass / denied in 24 h` : undefined}>
            <PersonList items={SETUP.map((x) => ({ key: x.to, name: x.name, sub: x.sub, action: <Link className="mb-btn mb-btn--link" to={x.to}>Open</Link> }))} />
          </Card>
        }
        side={
          <>
            {user.permissions.includes('audit:read') && <AlertsCard />}
            <Card title="Session" subtitle={`${user.staffCode} · ${ROLE_LABELS[user.role]}`}>
              <p className="muted">Signed in with password + email code. You’ll be signed out after 15 minutes without activity.</p>
            </Card>
          </>
        }
      />
    </StaffLayout>
  );
}

interface Alert { id: string; subject: string | null; body: string; readAt: string | null; createdAt: string; data: { kind?: string } | null }

/** Admin in-app alerts (break-glass access). Arrives live over the user's socket room. */
function AlertsCard() {
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const load = () => api<{ items: Alert[] }>('/api/notifications').then((r) => setAlerts(r.items)).catch(() => setAlerts([]));
  useEffect(() => void load(), []);
  useLive(['notification'], () => void load());
  const read = async (id: string) => {
    await api(`/api/notifications/${id}/read`, { method: 'POST' }).catch(() => undefined);
    void load();
  };
  const unread = alerts?.filter((a) => !a.readAt).length ?? 0;
  return (
    <Card title="Alerts" subtitle="Break-glass access to patient records." actions={unread ? <Badge tone="danger" dot size="sm">{unread} new</Badge> : undefined}>
      {alerts?.length ? (
        <PersonList
          items={alerts.slice(0, 6).map((a) => ({
            key: a.id,
            name: <>{!a.readAt && <Badge status="BREAK_GLASS" size="sm" />} {a.subject}</>,
            sub: `${whenLabel(a.createdAt)} · ${a.body}`,
            action: a.readAt ? <Link className="mb-btn mb-btn--link" to="/admin/audit">Audit</Link> : <Button variant="link" onClick={() => void read(a.id)}>Mark read</Button>,
          }))}
        />
      ) : (
        <p className="muted">{alerts ? 'No alerts.' : 'Loading…'}</p>
      )}
    </Card>
  );
}
