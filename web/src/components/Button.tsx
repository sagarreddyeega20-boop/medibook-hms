import type { ButtonHTMLAttributes } from 'react';
import { cx } from '../lib/cx';

export type ButtonVariant = 'primary' | 'secondary' | 'soft' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  block?: boolean;
  loading?: boolean;
}

export function Button({ variant = 'primary', size = 'md', block, loading, className, children, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('mb-btn', `mb-btn--${variant}`, size === 'sm' && 'mb-btn--sm', block && 'mb-btn--block', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className="mb-spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}
