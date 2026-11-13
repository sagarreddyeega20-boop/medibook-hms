import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, DashGrid, EmptyState, PersonList, StatCard, StatGrid } from '../../components';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { greeting } from '../../lib/format';
import { useLive } from '../../lib/live';
import { whenLabel } from '../../lib/time';
import { ROLE_HOME, ROLE_LABELS, type Role } from '../../lib/roles';
import { StaffLayout } from './StaffLayout';

/** What each role's home will hold once its module is built (from docs/mvp-structure.md). */
const PLANNED: Record<Exclude<Role, 'PATIENT'>, { stats: string[]; main: string; next: string }> = {
  SUPER_ADMIN: { stats: ['Active staff', 'Departments', 'Logins today', 'Locked accounts'], main: 'Hospital setup', next: 'Departments, schedules and fees arrive with their modules.' },
  ADMIN: { stats: ['Active staff', 'Departments', 'Logins today', 'Locked accounts'], main: 'Hospital setup', next: 'Departments, schedules and fees arrive with their modules.' },
  RECEPTIONIST: { stats: ['Today’s appointments', 'Checked in', 'Walk-ins', 'Doctors available'], main: 'Live board', next: 'The live board of every doctor’s slots arrives with the reception module.' },
  DOCTOR: { stats: ['Today’s appointments', 'Completed', 'Waiting / upcoming', 'Cancelled'], main: 'Today’s schedule', next: 'Your schedule, patient timelines and orders arrive with the visits module.' },
  LAB_TECH: { stats: ['Ordered', 'Sample taken', 'In progress', 'Results ready'], main: 'Lab order queue', next: 'Lab orders appear here once doctors can order tests.' },
  RADIOLOGY_TECH: { stats: ['Ordered', 'Scheduled', 'In progress', 'Results ready'], main: 'Radiology order queue', next: 'Scan orders appear here once doctors can order them.' },
  PHARMACIST: { stats: ['To dispense', 'Dispensed today', 'Low stock', 'Out of stock'], main: 'Prescriptions to dispense', next: 'Prescriptions arrive here with the pharmacy module.' },
  ACCOUNTS: { stats: ['Revenue today', 'Transactions', 'Refunds', 'Patients today'], main: 'Revenue by department', next: 'Revenue and transactions arrive with the billing and accounts modules.' },
};

/** Placeholder home for each staff role: the v1 dashboard layout with empty stats, plus a check of the role's own API. */
export function RoleHome() {
  const { user } = useAuth();
  const [apiState, setApiState] = useState<'checking' | 'ok' | 'denied'>('checking');
  const role = user?.role as Exclude<Role, 'PATIENT'>;

  useEffect(() => {
    if (!user) return;
    api(ROLE_HOME[user.role].api).then(() => setApiState('ok')).catch(() => setApiState('denied'));
  }, [user]);

  if (!user) return null;
  const plan = PLANNED[role];
  const first = user.name.replace(/^Dr\.?\s+/i, '').split(' ')[0];
  const isDoctor = user.role === 'DOCTOR';

  return (
    <StaffLayout
      title={`${greeting()}, ${isDoctor ? 'Dr. ' : ''}${first}`}
      subtitle={`${ROLE_LABELS[user.role]} · ${ROLE_HOME[user.role].title}`}
    >
      <StatGrid label="At a glance">
        {plan.stats.map((label, i) => (
          <StatCard key={label} label={label} value="—" tone={(['default', 'teal', 'blue', 'danger'] as const)[i]} />
        ))}
      </StatGrid>
      <DashGrid
        main={
          <Card title={plan.main}>
            <EmptyState
              title="Coming soon"
              text={plan.next}
              action={user.permissions.includes('staff:read') ? <Link className="mb-btn mb-btn--primary" to="/admin/staff">Manage staff &amp; roles</Link> : undefined}
            />
          </Card>
        }
        side={
          <>
            {user.permissions.includes('audit:read') && <AlertsCard />}
            <Card title="Your access" subtitle={`${user.staffCode} · ${ROLE_LABELS[user.role]}`}>
              <div className="stack">
                <div className="row">
                  {apiState === 'checking' ? <Badge tone="neutral">Checking API…</Badge>
                    : apiState === 'ok' ? <Badge tone="success" dot>Role API reachable</Badge>
                    : <Badge tone="danger" dot>Role API refused</Badge>}
                </div>
                <div className="row">
                  {user.permissions.map((p) => <Badge key={p} tone="primary" size="sm">{p}</Badge>)}
                </div>
              </div>
            </Card>
            <Card title="Session">
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
