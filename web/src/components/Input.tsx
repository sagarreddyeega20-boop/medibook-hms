import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { cx } from '../lib/cx';

interface FieldProps {
  label?: string;
  hint?: ReactNode;
  error?: string;
}

export function Field({ id, label, hint, error, children }: FieldProps & { id: string; children: ReactNode }) {
  return (
    <div className={cx('mb-field', error && 'mb-field--invalid')}>
      {label && <label className="mb-label" htmlFor={id}>{label}</label>}
      {children}
      {error ? <span className="mb-error-text" id={`${id}-error`}>{error}</span> : hint && <span className="mb-hint">{hint}</span>}
    </div>
  );
}

type InputProps = FieldProps & InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ label, hint, error, id, className, ...rest }, ref) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <Field id={inputId} label={label} hint={hint} error={error}>
      <input
        ref={ref}
        id={inputId}
        className={cx('mb-input', className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${inputId}-error` : undefined}
        {...rest}
      />
    </Field>
  );
});

type TextareaProps = FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ label, hint, error, id, className, ...rest }, ref) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <Field id={inputId} label={label} hint={hint} error={error}>
      <textarea
        ref={ref}
        id={inputId}
        className={cx('mb-input mb-textarea', className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${inputId}-error` : undefined}
        {...rest}
      />
    </Field>
  );
});
