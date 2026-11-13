import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthCard, AuthNote, Button, Input, Segmented } from '../../components';
import { api, errorMessage } from '../../lib/api';
import { useAuth, type MeResponse } from '../../lib/auth';
import { homeFor } from '../../lib/roles';
import { AuthLayout } from './AuthLayout';
import { OtpStep, type Challenge } from './OtpStep';

type Tab = 'staff' | 'patient';

/** Login: Staff (staff ID + password → email OTP) | Patient (email → OTP). */
export function Login() {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { signedIn, endedReason } = useAuth();

  const [tab, setTab] = useState<Tab>(params.get('tab') === 'patient' ? 'patient' : 'staff');
  const [staffId, setStaffId] = useState(params.get('staffId') ?? '');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<Challenge | null>(null);

  const from = (location.state as { from?: string } | null)?.from;

  const start = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    if (tab === 'staff' && (!staffId.trim() || !password)) return setError('Enter your staff ID and password');
    if (tab === 'patient' && !/^\S+@\S+\.\S+$/.test(email.trim())) return setError('Enter a valid email address');
    setBusy(true);
    try {
      const c = tab === 'staff'
        ? await api<Challenge>('/api/auth/staff/login', { json: { staffId, password } })
        : await api<Challenge>('/api/auth/patient/otp', { json: { email } });
      setPassword('');
      setChallenge(c);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onVerified = (me: MeResponse) => {
    signedIn(me);
    const home = homeFor(me.user.role);
    navigate(from && from.startsWith(home) ? from : home, { replace: true });
  };

  const switchTab = (t: string) => {
    setTab(t as Tab);
    setError(undefined);
  };

  return (
    <AuthLayout>
      <AuthCard
        title={challenge ? 'Check your email' : 'Welcome to MediBook'}
        subtitle={challenge ? 'Enter the verification code to finish signing in.' : tab === 'staff' ? 'Sign in with your hospital-issued staff ID.' : 'Log in to book visits and see your records.'}
        footer={!challenge && tab === 'patient' ? <>New here? <Link className="mb-btn mb-btn--link" to="/register">Get my Patient ID</Link></> : undefined}
      >
        {challenge ? (
          <OtpStep challenge={challenge} onVerified={onVerified} onBack={() => setChallenge(null)} />
        ) : (
          <>
            {endedReason === 'SESSION_EXPIRED' && <p className="mb-hint" role="status">You were signed out after a period of inactivity.</p>}
            <Segmented label="Sign in as" value={tab} onChange={switchTab} options={[{ id: 'staff', label: 'Staff' }, { id: 'patient', label: 'Patient' }]} />
            <form className="stack" onSubmit={start} noValidate>
              {tab === 'staff' ? (
                <>
                  <Input label="Staff ID" placeholder="HMS-DOC-0007" autoComplete="username" autoCapitalize="characters" value={staffId} onChange={(e) => setStaffId(e.target.value)} />
                  <Input label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                </>
              ) : (
                <Input label="Email" type="email" placeholder="you@example.com" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              )}
              {error && <p className="mb-error-text" role="alert">{error}</p>}
              <Button type="submit" block loading={busy}>{tab === 'staff' ? 'Continue' : 'Send OTP'}</Button>
            </form>
            {tab === 'staff' && <AuthNote>No staff ID yet? Your hospital administrator creates it for you.</AuthNote>}
          </>
        )}
      </AuthCard>
    </AuthLayout>
  );
}
