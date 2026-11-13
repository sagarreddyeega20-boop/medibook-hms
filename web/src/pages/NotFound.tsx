import { Link } from 'react-router-dom';
import { AppShell, Button, Card, EmptyState } from '../components';
import { demoUser, foundationNav } from '../lib/nav';

export function NotFound() {
  return (
    <AppShell nav={foundationNav} user={demoUser}>
      <Card>
        <EmptyState title="Page not found" text="The page you are looking for does not exist." action={<Link to="/"><Button>Back to overview</Button></Link>} />
      </Card>
    </AppShell>
  );
}
