import { useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { cx } from '../lib/cx';
import { initials } from '../lib/format';
import { Icon, LogoTile } from './Icon';

export interface NavbarLink {
  to: string;
  label: string;
  end?: boolean;
}

interface PatientNavbarProps {
  links: NavbarLink[];
  /** Teal filled call to action on the right, e.g. "Get my Patient ID". */
  cta?: ReactNode;
  user?: { name: string; onLogout?: () => void };
}

/** v1 top navbar: teal "+" tile and "MediBook" wordmark, right-aligned links, teal CTA. Collapses to a menu under 760px. */
export function PatientNavbar({ links, cta, user }: PatientNavbarProps) {
  const [open, setOpen] = useState(false);
  return (
    <header className="mb-navbar">
      <div className="mb-container mb-navbar__inner">
        <Link to="/" className="mb-navbar__brand">
          <LogoTile />
          MediBook
        </Link>
        <button
          type="button"
          className="mb-navbar__toggle"
          aria-expanded={open}
          aria-controls="mb-navbar-links"
          aria-label="Menu"
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name={open ? 'close' : 'menu'} />
        </button>
        <nav id="mb-navbar-links" className={cx('mb-navbar__links', open && 'is-open')} aria-label="Main">
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end} className="mb-navbar__link" onClick={() => setOpen(false)}>
              {l.label}
            </NavLink>
          ))}
          {user && (
            <span className="mb-navbar__user">
              <span className="mb-navbar__avatar" aria-hidden="true">{initials(user.name)}</span>
              {user.name}
            </span>
          )}
          {user?.onLogout && (
            <button type="button" className="mb-btn mb-btn--secondary mb-btn--sm" onClick={user.onLogout}>Log out</button>
          )}
          {cta}
        </nav>
      </div>
    </header>
  );
}

/** Patient layout from v1: white top navbar over a light page, content in a 1100px container. */
export function PatientLayout({ navbar, children }: { navbar: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-patient">
      {navbar}
      <main className="mb-container mb-patient__main">{children}</main>
    </div>
  );
}

/** v1 My appointments grid: optional full-width banner, then main column + 300px side column. */
export function PatientGrid({ banner, main, side }: { banner?: ReactNode; main: ReactNode; side?: ReactNode }) {
  return (
    <div className={cx('mb-pgrid', !side && 'mb-pgrid--single')}>
      {banner && <div className="mb-pgrid__banner">{banner}</div>}
      <div className="mb-pgrid__main">{main}</div>
      {side && <aside className="mb-pgrid__side">{side}</aside>}
    </div>
  );
}
