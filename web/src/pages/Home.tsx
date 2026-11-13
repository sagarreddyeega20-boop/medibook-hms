import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell, Badge, Button, Card, type BadgeTone } from '../components';
import { getHealth, type Health } from '../lib/api';
import { demoUser, foundationNav } from '../lib/nav';

const modules = ['auth', 'staff', 'patients', 'scheduling', 'reception', 'visits', 'orders', 'pharmacy', 'billing', 'accounts', 'audit', 'notifications'];

export function Home() {
  const [health, setHealth] = useState<Health | null>(null);
  const [failed, setFailed] = useState(false);

  const load = () => {
    setFailed(false);
    getHealth().then(setHealth).catch(() => setFailed(true));
  };
  useEffect(load, []);

  const tone = (s?: string): BadgeTone => (s === 'ok' ? 'success' : 'danger');

  return (
    <AppShell
      nav={foundationNav}
      user={demoUser}
      title="MediBook HMS"
      subtitle="Foundation build — the visit is the centre of the data model."
      actions={<Link to="/demo/components"><Button variant="soft">View components</Button></Link>}
    >
      <div className="grid-2">
        <Card title="API health" subtitle="GET /api/health" actions={<Button size="sm" variant="secondary" onClick={load}>Refresh</Button>}>
          {failed ? (
            <Badge tone="danger" dot>API unreachable</Badge>
          ) : !health ? (
            <p className="muted">Checking…</p>
          ) : (
            <div className="row">
              <Badge tone={health.status === 'ok' ? 'success' : 'warning'} dot>API {health.status}</Badge>
              <Badge tone={tone(health.services.database)} dot>PostgreSQL {health.services.database}</Badge>
              <Badge tone={tone(health.services.redis)} dot>Redis {health.services.redis}</Badge>
            </div>
          )}
        </Card>
        <Card title="Server modules" subtitle="Each module owns its tables and exposes a service">
          <div className="row">
            {modules.map((m) => <Badge key={m} tone="primary">{m}</Badge>)}
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
