import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AuthCard, Button, IdHighlight, Input } from '../../components';
import { api, errorMessage } from '../../lib/api';
import { AuthLayout } from './AuthLayout';

interface LinkInfo {
  name: string;
  staffCode: string;
  minLength: number;
}

/** Opened from the staff invite email: /set-password?token=… (link valid 24 h). */
export function SetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [linkError, setLinkError] = useState<string>();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ password?: string; confirm?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) return setLinkError('This link is incomplete. Open it again from your invite email.');
    api<LinkInfo>(`/api/auth/password/link?token=${encodeURIComponent(token)}`).then(setInfo).catch((err) => setLinkError(errorMessage(err)));
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const min = info?.minLength ?? 10;
    const next: typeof errors = {};
    if (password.length < min) next.password = `Use at least ${min} characters`;
    if (confirm !== password) next.confirm = 'Passwords don’t match';
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      await api('/api/auth/password/set', { json: { token, password } });
      setDone(true);
    } catch (err) {
      setErrors({ form: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const loginLink = `/login?staffId=${encodeURIComponent(info?.staffCode ?? '')}`;

  return (
    <AuthLayout>
      {linkError ? (
        <AuthCard title="Link not valid" subtitle={linkError}>
          <Link className="mb-btn mb-btn--secondary mb-btn--block" to="/login">Go to login</Link>
        </AuthCard>
      ) : !info ? null : done ? (
        <AuthCard title="Password set" subtitle="You can now sign in with your staff ID, password and the code we email you.">
          <IdHighlight label="Your staff ID" value={info.staffCode} />
          <Link className="mb-btn mb-btn--primary mb-btn--block" to={loginLink}>Continue to login</Link>
        </AuthCard>
      ) : (
        <AuthCard title="Set your password" subtitle={`Welcome, ${info.name}. Choose a password for staff ID ${info.staffCode}.`}>
          <form className="stack" onSubmit={submit} noValidate>
            <input type="text" name="username" autoComplete="username" value={info.staffCode} readOnly hidden />
            <Input label="New password" type="password" autoComplete="new-password" hint={`At least ${info.minLength} characters.`} value={password} onChange={(e) => setPassword(e.target.value)} error={errors.password} />
            <Input label="Confirm password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={errors.confirm} />
            {errors.form && <p className="mb-error-text" role="alert">{errors.form}</p>}
            <Button type="submit" block loading={busy}>Set password</Button>
          </form>
        </AuthCard>
      )}
    </AuthLayout>
  );
}
