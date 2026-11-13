import { Fragment, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';

export interface NavItem {
  to: string;
  label: string;
  icon?: ReactNode;
  end?: boolean;
}

export interface NavSection {
  title?: string;
  items: NavItem[];
}

interface AppShellProps {
  nav: NavSection[];
  user?: { name: string; role: string };
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');

/** Dark left sidebar + main content area, modelled on the MediBook v1 doctor dashboard. */
export function AppShell({ nav, user, title, subtitle, actions, children }: AppShellProps) {
  return (
    <div className="mb-shell">
      <aside className="mb-side" aria-label="Main navigation">
        <Link to="/" className="mb-brand">
          <span className="mb-brand__mark" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z" /></svg>
          </span>
          <span>
            MediBook HMS
            <small>Hospital management</small>
          </span>
        </Link>

        <nav className="mb-nav">
          {nav.map((section, i) => (
            <Fragment key={section.title ?? i}>
              {section.title && <p className="mb-nav__section">{section.title}</p>}
              {section.items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end} className="mb-nav__link">
                  {item.icon}
                  {item.label}
                </NavLink>
              ))}
            </Fragment>
          ))}
        </nav>

        {user && (
          <div className="mb-profile">
            <span className="mb-profile__avatar" aria-hidden="true">{initials(user.name)}</span>
            <div className="mb-profile__text">
              <strong>{user.name}</strong>
              <span>{user.role}</span>
            </div>
          </div>
        )}
      </aside>

      <main className="mb-main">
        {(title || actions) && (
          <div className="mb-pagehead">
            <div>
              {title && <h1 className="page-title">{title}</h1>}
              {subtitle && <p>{subtitle}</p>}
            </div>
            {actions && <div className="row">{actions}</div>}
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
