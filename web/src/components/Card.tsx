import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../lib/cx';

interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  flush?: boolean;
}

export function Card({ title, subtitle, actions, flush, className, children, ...rest }: CardProps) {
  return (
    <section className={cx('mb-card', flush && 'mb-card--flush', className)} {...rest}>
      {(title || actions) && (
        <header className="mb-card__head">
          <div>
            {title && <h2 className="mb-card__title">{title}</h2>}
            {subtitle && <p className="mb-card__subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
