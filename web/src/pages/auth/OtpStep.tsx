import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AuthNote, Button, OtpInput, useToast } from '../../components';
import { api, ApiRequestError, errorMessage } from '../../lib/api';
import type { MeResponse } from '../../lib/auth';
import { mmss, useCountdown } from '../../lib/useCountdown';

export interface Challenge {
  challengeId: string;
  sentTo: string;
  expiresInSeconds: number;
  resendInSeconds: number;
}

interface OtpStepProps {
  challenge: Challenge;
  onVerified: (me: MeResponse) => void;
  onBack: () => void;
  backLabel?: string;
}

/** Step 2 of every login: 6-digit code with expiry countdown and resend timer. */
export function OtpStep({ challenge, onVerified, onBack, backLabel = 'Use a different account' }: OtpStepProps) {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [locked, setLocked] = useState(false);
  const expiry = useCountdown(challenge.expiresInSeconds);
  const resend = useCountdown(challenge.resendInSeconds);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (code.length !== 6) return setError('Enter the 6-digit code from the email');
    setBusy(true);
    setError(undefined);
    try {
      onVerified(await api<MeResponse>('/api/auth/otp/verify', { json: { challengeId: challenge.challengeId, code } }));
    } catch (err) {
      setCode('');
      if (err instanceof ApiRequestError) {
        if (err.error.code === 'OTP_LOCKED' || err.error.code === 'CHALLENGE_EXPIRED') setLocked(true);
        const left = err.error.details?.attemptsRemaining;
        setError(left !== undefined ? `${err.error.message} ${left} ${left === 1 ? 'attempt' : 'attempts'} left.` : err.error.message);
      } else setError(errorMessage(err));
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const doResend = async () => {
    setResending(true);
    setError(undefined);
    try {
      const r = await api<Omit<Challenge, 'challengeId'>>('/api/auth/otp/resend', { json: { challengeId: challenge.challengeId } });
      expiry.start(r.expiresInSeconds);
      resend.start(r.resendInSeconds);
      setCode('');
      toast.success('New code sent', `Check ${r.sentTo}.`);
      inputRef.current?.focus();
    } catch (err) {
      const retry = err instanceof ApiRequestError ? err.error.details?.retryAfterSeconds : undefined;
      if (retry) resend.start(retry);
      if (err instanceof ApiRequestError && (err.error.code === 'OTP_LOCKED' || err.error.code === 'CHALLENGE_EXPIRED')) setLocked(true);
      setError(errorMessage(err));
    } finally {
      setResending(false);
    }
  };

  if (locked) {
    return (
      <>
        <p className="mb-error-text" role="alert">{error}</p>
        <Button block onClick={onBack}>Start again</Button>
      </>
    );
  }

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <p className="muted">
        We sent a 6-digit code to <strong>{challenge.sentTo}</strong>.
      </p>
      <OtpInput ref={inputRef} value={code} onChange={setCode} error={error} hint={expiry.left > 0 ? <>Code expires in <strong>{mmss(expiry.left)}</strong></> : 'This code has expired — request a new one.'} />
      <Button type="submit" block loading={busy} disabled={code.length !== 6}>Verify &amp; sign in</Button>
      <AuthNote>
        {resend.left > 0 ? (
          <>Didn’t get it? Resend in <strong>{mmss(resend.left)}</strong></>
        ) : (
          <>Didn’t get it? <Button variant="link" onClick={doResend} loading={resending}>Resend code</Button></>
        )}
      </AuthNote>
      <AuthNote>
        <Button variant="link" onClick={onBack}>{backLabel}</Button>
      </AuthNote>
    </form>
  );
}
