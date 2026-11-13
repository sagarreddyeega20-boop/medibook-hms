import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthCard, Button, IdHighlight, Input, Select } from '../../components';
import { api, ApiRequestError, errorMessage } from '../../lib/api';
import { useAuth, type MeResponse } from '../../lib/auth';
import { homeFor } from '../../lib/roles';
import { AuthLayout } from './AuthLayout';
import { OtpStep, type Challenge } from './OtpStep';

interface Form {
  fullName: string;
  gender: string;
  dateOfBirth: string;
  phone: string;
  email: string;
}

const empty: Form = { fullName: '', gender: '', dateOfBirth: '', phone: '', email: '' };

/** Patient self-registration: details → email OTP → account + Patient ID (MRN). */
export function Register() {
  const navigate = useNavigate();
  const { signedIn } = useAuth();
  const [form, setForm] = useState<Form>(empty);
  const [errors, setErrors] = useState<Partial<Record<keyof Form | 'form', string>>>({});
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [done, setDone] = useState<MeResponse | null>(null);

  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const validate = () => {
    const e: typeof errors = {};
    if (form.fullName.trim().length < 2) e.fullName = 'Enter your full name';
    if (!form.gender) e.gender = 'Select gender';
    if (!form.dateOfBirth) e.dateOfBirth = 'Enter your date of birth';
    if (!/^\+?[0-9 ]{10,16}$/.test(form.phone.trim())) e.phone = 'Enter a valid mobile number';
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) e.email = 'Enter a valid email address';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!validate()) return;
    setBusy(true);
    try {
      setChallenge(await api<Challenge>('/api/auth/patient/register', { json: form }));
    } catch (err) {
      const issues = err instanceof ApiRequestError && Array.isArray(err.error.details) ? (err.error.details as { path: string; message: string }[]) : [];
      if (issues.length) setErrors(Object.fromEntries(issues.map((i) => [i.path, i.message])));
      else setErrors({ form: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const onVerified = (me: MeResponse) => {
    signedIn(me);
    if (me.newlyRegistered) setDone(me);
    else navigate(homeFor(me.user.role), { replace: true }); // the email already had an account: just signed in
  };

  if (done) {
    return (
      <AuthLayout>
        <AuthCard title="You’re all set" subtitle={`Welcome to MediBook, ${done.user.name}.`}>
          <IdHighlight label="Your Patient ID" value={done.user.mrn ?? ''}>
            Use this ID at reception and on every visit. We’ve also saved it to your account.
          </IdHighlight>
          <Button block onClick={() => navigate(homeFor(done.user.role), { replace: true })}>Go to my dashboard</Button>
        </AuthCard>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthCard
        wide
        title={challenge ? 'Verify your email' : 'Create your account'}
        subtitle={challenge ? 'Enter the code to create your account.' : 'Book visits and keep every record under one Patient ID.'}
        footer={challenge ? undefined : <>Already have an account? <Link className="mb-btn mb-btn--link" to="/login?tab=patient">Log in</Link></>}
      >
        {challenge ? (
          <OtpStep challenge={challenge} onVerified={onVerified} onBack={() => setChallenge(null)} backLabel="Edit my details" />
        ) : (
          <form className="stack" onSubmit={submit} noValidate>
            <Input label="Full name" autoComplete="name" value={form.fullName} onChange={set('fullName')} error={errors.fullName} />
            <div className="mb-auth__row">
              <Select
                label="Gender" placeholder="Select" value={form.gender} onChange={set('gender')} error={errors.gender}
                options={[{ value: 'FEMALE', label: 'Female' }, { value: 'MALE', label: 'Male' }, { value: 'OTHER', label: 'Other' }]}
              />
              <Input label="Date of birth" type="date" max={new Date().toISOString().slice(0, 10)} autoComplete="bday" value={form.dateOfBirth} onChange={set('dateOfBirth')} error={errors.dateOfBirth} />
            </div>
            <Input label="Mobile number" type="tel" placeholder="+91 98450 14410" autoComplete="tel" value={form.phone} onChange={set('phone')} error={errors.phone} />
            <Input label="Email" type="email" placeholder="you@example.com" autoComplete="email" hint="We’ll email you a code to verify it." value={form.email} onChange={set('email')} error={errors.email} />
            {errors.form && <p className="mb-error-text" role="alert">{errors.form}</p>}
            <Button type="submit" block loading={busy}>Create account</Button>
          </form>
        )}
      </AuthCard>
    </AuthLayout>
  );
}
