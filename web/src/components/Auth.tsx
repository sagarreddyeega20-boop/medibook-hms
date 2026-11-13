import { forwardRef, useId, useRef, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '../lib/cx';
import { Field } from './Input';

/**
 * v1 login / sign-up page (docs/ui-reference/02-login.png, 03-signup.png):
 * centred white card on the light page, heavy title + muted subtitle, segmented switch, stacked form.
 */
export function AuthCard({ title, subtitle, wide, children, footer }: { title: ReactNode; subtitle?: ReactNode; wide?: boolean; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className={cx('mb-auth', wide && 'mb-auth--wide')}>
      <h1 className="mb-auth__title">{title}</h1>
      {subtitle && <p className="mb-auth__sub">{subtitle}</p>}
      <div className="mb-auth__body">{children}</div>
      {footer && <p className="mb-auth__alt">{footer}</p>}
    </section>
  );
}

export interface SegmentOption {
  id: string;
  label: string;
}

/** v1 "Patient | Doctor" segmented switch (a tablist). */
export function Segmented({ options, value, onChange, label }: { options: SegmentOption[]; value: string; onChange: (id: string) => void; label: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const next = (i + dir + options.length) % options.length;
    refs.current[next]?.focus();
    onChange(options[next]!.id);
  };
  return (
    <div className="mb-seg" role="tablist" aria-label={label}>
      {options.map((o, i) => (
        <button
          key={o.id}
          ref={(el) => { refs.current[i] = el; }}
          type="button"
          role="tab"
          aria-selected={o.id === value}
          tabIndex={o.id === value ? 0 : -1}
          className="mb-seg__btn"
          onClick={() => onChange(o.id)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

type OtpInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> & {
  label?: string;
  hint?: ReactNode;
  error?: string;
  length?: number;
  value: string;
  onChange: (value: string) => void;
};

/** v1 OTP field: one large, letter-spaced numeric input (works with SMS/email autofill). */
export const OtpInput = forwardRef<HTMLInputElement, OtpInputProps>(function OtpInput({ label = 'Verification code', hint, error, length = 6, value, onChange, id, ...rest }, ref) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <Field id={inputId} label={label} hint={hint} error={error}>
      <input
        ref={ref}
        id={inputId}
        className="mb-input mb-otp"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern={`\\d{${length}}`}
        maxLength={length}
        placeholder={'•'.repeat(length)}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, length))}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${inputId}-error` : undefined}
        {...rest}
      />
    </Field>
  );
});

/** v1 "Your Patient ID" highlight shown after sign-up. */
export function IdHighlight({ label, value, children }: { label: string; value: string; children?: ReactNode }) {
  return (
    <div className="mb-idhl">
      <p className="mb-eyebrow">{label}</p>
      <p className="mb-idhl__value">{value}</p>
      {children && <div className="mb-idhl__help">{children}</div>}
    </div>
  );
}

/** Small muted line with an inline action, e.g. "Didn't get it? Resend in 0:42". */
export function AuthNote({ children }: { children: ReactNode }) {
  return <p className="mb-auth__note">{children}</p>;
}
