import type { ButtonHTMLAttributes } from 'react';
import { cx } from '../lib/cx';

/**
 * v1 button styles:
 * primary = teal filled · secondary = white outline · dark = navy filled ("View history")
 * soft = teal tint · ghost = text only · danger = red filled · danger-outline = v1 "Cancel" · link = underlined teal text
 */
export type ButtonVariant = 'primary' | 'secondary' | 'dark' | 'soft' | 'ghost' | 'danger' | 'danger-outline' | 'link';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'md' | 'sm' | 'lg';
  block?: boolean;
  loading?: boolean;
}

export function Button({ variant = 'primary', size = 'md', block, loading, className, children, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('mb-btn', `mb-btn--${variant}`, size !== 'md' && `mb-btn--${size}`, block && 'mb-btn--block', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className="mb-spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}
