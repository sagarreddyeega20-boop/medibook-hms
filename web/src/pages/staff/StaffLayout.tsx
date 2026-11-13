import type { ComponentProps } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '../../components';
import { useAuth } from '../../lib/auth';
import { navFor, ROLE_HOME, ROLE_LABELS } from '../../lib/roles';

type Props = Omit<ComponentProps<typeof AppShell>, 'nav' | 'user' | 'brandSub'>;

/** AppShell wired to the signed-in staff member: role menu, profile card and logout. */
export function StaffLayout(props: Props) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;
  return (
    <AppShell
      {...props}
      nav={navFor(user)}
      brandSub={ROLE_HOME[user.role].brandSub}
      user={{
        name: user.name,
        role: `${user.staffCode} · ${ROLE_LABELS[user.role]}`,
        onLogout: async () => {
          await logout();
          navigate('/login', { replace: true });
        },
      }}
    />
  );
}
