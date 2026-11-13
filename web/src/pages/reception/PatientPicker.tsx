import { useEffect, useState, type FormEvent } from 'react';
import { Badge, Button, Input, PersonList, Select } from '../../components';
import { api, ApiRequestError, errorMessage } from '../../lib/api';

export interface PatientSummary {
  id: string;
  mrn: string;
  name: string;
  gender: string;
  dateOfBirth: string | null;
  phone: string | null;
  email: string | null;
  hasPortalAccount: boolean;
}

const age = (dob: string | null) => {
  if (!dob) return null;
  const d = new Date(dob);
  const now = new Date();
  return now.getFullYear() - d.getFullYear() - (now < new Date(now.getFullYear(), d.getMonth(), d.getDate()) ? 1 : 0);
};
export const patientLine = (p: PatientSummary) =>
  [p.mrn, p.gender !== 'UNKNOWN' ? `${p.gender.charAt(0)}${p.gender.slice(1).toLowerCase()}${age(p.dateOfBirth) !== null ? `, ${age(p.dateOfBirth)}` : ''}` : null, p.phone].filter(Boolean).join(' · ');

/** Search by MRN, name or phone (debounced). */
export function usePatientSearch(q: string) {
  const [results, setResults] = useState<PatientSummary[] | null>(null);
  useEffect(() => {
    if (q.trim().length < 2) {
      setResults(null);
      return;
    }
    const t = window.setTimeout(() => {
      api<{ patients: PatientSummary[] }>(`/api/patients/search?q=${encodeURIComponent(q.trim())}`)
        .then((r) => setResults(r.patients))
        .catch(() => setResults([]));
    }, 250);
    return () => window.clearTimeout(t);
  }, [q]);
  return results;
}

/** Find a patient, or register a new one (with duplicate detection). Calls onPick with the chosen patient. */
export function PatientPicker({ selected, onPick, autoFocus }: { selected?: PatientSummary | null; onPick: (p: PatientSummary | null) => void; autoFocus?: boolean }) {
  const [q, setQ] = useState('');
  const [registering, setRegistering] = useState(false);
  const results = usePatientSearch(q);

  if (selected) {
    return (
      <div className="mb-dupwarn mb-dupwarn--ok">
        <PersonList items={[{ key: selected.id, name: selected.name, sub: patientLine(selected), action: <Button variant="link" onClick={() => onPick(null)}>Change</Button> }]} />
      </div>
    );
  }
  if (registering) return <RegisterPatientForm initialName={/\d/.test(q) ? '' : q} onDone={(p) => { setRegistering(false); onPick(p); }} onCancel={() => setRegistering(false)} />;

  return (
    <div className="stack">
      <Input label="Patient" placeholder="Search MRN, name or phone" value={q} onChange={(e) => setQ(e.target.value)} autoFocus={autoFocus} type="search" />
      {results && (
        results.length ? (
          <ul className="mb-resultlist" aria-label="Matching patients">
            {results.slice(0, 6).map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => onPick(p)}>
                  <span className="mb-person"><strong>{p.name}</strong><span>{patientLine(p)}</span></span>
                  <span className="mb-btn mb-btn--link">Select</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No patient matches “{q}”.</p>
        )
      )}
      <div><Button variant="secondary" size="sm" onClick={() => setRegistering(true)}>Register new patient</Button></div>
    </div>
  );
}

const emptyForm = { fullName: '', gender: '', dateOfBirth: '', phone: '', email: '' };

/**
 * Reception registration. Warns when name + date of birth + phone match an existing patient
 * (checked live and again on submit) and offers to open that record instead.
 */
export function RegisterPatientForm({ onDone, onCancel, initialName = '', submitLabel = 'Register patient' }: { onDone: (p: PatientSummary) => void; onCancel?: () => void; initialName?: string; submitLabel?: string }) {
  const [form, setForm] = useState({ ...emptyForm, fullName: initialName });
  const [matches, setMatches] = useState<PatientSummary[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  // Live duplicate check once name, date of birth and phone are filled in.
  useEffect(() => {
    if (form.fullName.trim().length < 2 || !/^\d{4}-\d{2}-\d{2}$/.test(form.dateOfBirth) || form.phone.replace(/\D/g, '').length < 10) {
      setMatches([]);
      return;
    }
    const t = window.setTimeout(() => {
      api<{ matches: PatientSummary[] }>('/api/patients/duplicates', { json: { fullName: form.fullName, dateOfBirth: form.dateOfBirth, phone: form.phone } })
        .then((r) => setMatches(r.matches))
        .catch(() => undefined);
    }, 300);
    return () => window.clearTimeout(t);
  }, [form.fullName, form.dateOfBirth, form.phone]);

  const submit = async (e: FormEvent | null, confirmNotDuplicate = false) => {
    e?.preventDefault();
    if (form.fullName.trim().length < 2) return setError('Enter the full name');
    if (!form.gender) return setError('Choose the gender');
    if (!form.dateOfBirth) return setError('Enter the date of birth');
    if (form.phone.replace(/\D/g, '').length < 10) return setError('Enter a valid mobile number');
    setBusy(true);
    setError(undefined);
    try {
      const { patient } = await api<{ patient: PatientSummary }>('/api/patients', { json: { ...form, email: form.email || undefined, confirmNotDuplicate } });
      onDone(patient);
    } catch (err) {
      if (err instanceof ApiRequestError && err.error.code === 'DUPLICATE_PATIENT') {
        setMatches((err.error.details as unknown as { matches: PatientSummary[] }).matches);
      } else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)}>
      <Input label="Full name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} autoComplete="off" />
      <div className="grid-2">
        <Select label="Gender" value={form.gender} placeholder="Choose…" options={[{ value: 'FEMALE', label: 'Female' }, { value: 'MALE', label: 'Male' }, { value: 'OTHER', label: 'Other' }]} onChange={(e) => setForm({ ...form, gender: e.target.value })} />
        <Input label="Date of birth" type="date" value={form.dateOfBirth} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })} />
        <Input label="Mobile" inputMode="tel" placeholder="+91 98450 12345" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        <Input label="Email (optional)" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} hint="Booking confirmations go here" />
      </div>
      {matches.length > 0 && (
        <div className="mb-dupwarn" role="alert">
          <strong>Possible duplicate: same name, date of birth and phone as {matches.length === 1 ? 'this patient' : 'these patients'}.</strong>
          <PersonList items={matches.map((m) => ({ key: m.id, name: m.name, sub: patientLine(m), action: <Button size="sm" onClick={() => onDone(m)}>Open this record</Button> }))} />
          <div><Button variant="secondary" size="sm" loading={busy} onClick={() => void submit(null, true)}>It’s a different person — register anyway</Button></div>
        </div>
      )}
      {error && <p className="mb-error-text" role="alert">{error}</p>}
      <div className="row">
        {matches.length === 0 && <Button type="submit" loading={busy}>{submitLabel}</Button>}
        {onCancel && <Button variant="ghost" onClick={onCancel}>Back to search</Button>}
        {matches.length > 0 && <Badge status="AWAITING">Check before registering</Badge>}
      </div>
    </form>
  );
}
