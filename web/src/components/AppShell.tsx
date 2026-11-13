import { Fragment, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { initials } from '../lib/format';
import { Icon, LogoTile } from './Icon';

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
  /** Small line under the "MediBook" wordmark, e.g. "for Doctors", "Reception". */
  brandSub?: string;
  user?: { name: string; role: string; onLogout?: () => void };
  /** Page heading, e.g. "Good morning, Dr. Ananya". */
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Header search box (v1 "Search Patient ID or name"). */
  search?: { placeholder: string; value?: string; onChange?: (value: string) => void; label?: string };
  /** Header buttons, e.g. a primary "Block a slot". */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * Staff layout from the v1 doctor dashboard:
 * dark sticky sidebar (logo, pill nav, profile card with logout) + main column with
 * greeting header, search and actions. Compose the body with StatGrid, DashGrid, Card, Table.
 */
export function AppShell({ nav, brandSub = 'Hospital management', user, title, subtitle, search, actions, children }: AppShellProps) {
  return (
    <div className="mb-shell">
      <aside className="mb-side" aria-label="Main navigation">
        <Link to="/" className="mb-side__brand">
          <LogoTile size={36} />
          <span>
            MediBook
            <small>{brandSub}</small>
          </span>
        </Link>

        <nav className="mb-side__nav">
          {nav.map((section, i) => (
            <Fragment key={section.title ?? i}>
              {section.title && <p className="mb-side__section">{section.title}</p>}
              {section.items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end} className="mb-side__link">
                  {item.icon}
                  {item.label}
                </NavLink>
              ))}
            </Fragment>
          ))}
        </nav>

        {user && (
          <div className="mb-side__profile">
            <span className="mb-side__avatar" aria-hidden="true">{initials(user.name)}</span>
            <div className="mb-side__who">
              <strong>{user.name}</strong>
              <span>{user.role}</span>
            </div>
            {user.onLogout && (
              <button type="button" className="mb-side__logout" onClick={user.onLogout} aria-label="Log out">
                <Icon name="logout" size={16} />
              </button>
            )}
          </div>
        )}
      </aside>

      <main className="mb-dash">
        {(title || search || actions) && (
          <header className="mb-dash__head">
            <div>
              {title && <h1 className="mb-dash__title">{title}</h1>}
              {subtitle && <p className="mb-dash__sub">{subtitle}</p>}
            </div>
            {(search || actions) && (
              <div className="mb-dash__tools">
                {search && (
                  <label className="mb-search">
                    <span className="sr-only">{search.label ?? search.placeholder}</span>
                    <Icon name="search" size={16} />
                    <input
                      className="mb-input"
                      type="search"
                      placeholder={search.placeholder}
                      value={search.value}
                      onChange={search.onChange ? (e) => search.onChange!(e.target.value) : undefined}
                    />
                  </label>
                )}
                {actions}
              </div>
            )}
          </header>
        )}
        {children}
      </main>
    </div>
  );
}

/** v1 dashboard body: main column + 340px right side panel (stacks under 1180px). */
export function DashGrid({ main, side }: { main: ReactNode; side: ReactNode }) {
  return (
    <div className="mb-dash-grid">
      <div className="mb-dash-grid__col">{main}</div>
      <aside className="mb-dash-grid__col">{side}</aside>
    </div>
  );
}
