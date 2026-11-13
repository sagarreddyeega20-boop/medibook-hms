import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, NowConsultingCard, Pill, Textarea, Timeline, useToast, type TimelineEntry } from '../../components';
import { api, ApiRequestError, errorMessage } from '../../lib/api';
import { timeLabel, whenLabel } from '../../lib/time';
import { ACCESS_LABELS, patientMeta, showValue, TIMELINE_FILTERS, type PatientHeader, type TimelineEvent, type TimelineResponse } from './clinical';

/** Timeline events → Timeline component entries. */
export function toEntries(events: TimelineEvent[], currentVisitId?: string): TimelineEntry[] {
  return events.map((e) => ({
    id: e.id,
    type: e.type,
    title: e.title,
    status: e.status,
    priority: e.priority,
    meta: [whenLabel(e.at), e.doctor, e.department].filter(Boolean).join(' · '),
    lines: e.lines.map(([label, value]) => ({ label, value: showValue(value) })),
    current: !!currentVisitId && e.visitId === currentVisitId,
  }));
}

/**
 * Patient timeline card with type filter pills. Loads /api/visits/patients/:id/timeline (server checks the care
 * relationship and audits the view). On 403 NO_CARE_RELATIONSHIP it calls onDenied so the page can offer break-glass.
 */
export function PatientTimelineCard({ patientId, currentVisitId, refreshKey, onLoaded, onDenied }: {
  patientId: string;
  currentVisitId?: string;
  refreshKey?: number;
  onLoaded?: (r: TimelineResponse) => void;
  onDenied?: () => void;
}) {
  const toast = useToast();
  const [filter, setFilter] = useState<(typeof TIMELINE_FILTERS)[number]['id']>('ALL');
  const [data, setData] = useState<TimelineResponse | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<TimelineResponse>(`/api/visits/patients/${patientId}/timeline`);
      setData(r);
      onLoaded?.(r);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 403) onDenied?.();
      else toast.error('Could not load the timeline', errorMessage(err));
    }
  }, [patientId, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => void load(), [load, refreshKey]);

  const types = TIMELINE_FILTERS.find((f) => f.id === filter)?.types;
  const events = (data?.events ?? []).filter((e) => !types || types.includes(e.type));
  const count = (t?: string[]) => (data ? (t ? t.reduce((n, x) => n + (data.counts[x as keyof typeof data.counts] ?? 0), 0) : data.events.length) : undefined);

  return (
    <Card title="Patient timeline" subtitle="Every visit, note, order, result, referral and prescription across all departments — newest first.">
      <div className="stack">
        <div className="mb-chips" role="group" aria-label="Filter the timeline">
          {TIMELINE_FILTERS.map((f) => (
            <Pill key={f.id} selected={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}{count(f.types) !== undefined ? ` · ${count(f.types)}` : ''}
            </Pill>
          ))}
        </div>
        {data ? <Timeline items={toEntries(events, currentVisitId)} /> : <p className="muted">Loading…</p>}
      </div>
    </Card>
  );
}

/** Patient header side card (v1 "Now consulting" look): name, MRN, age, gender, allergies in the teal box. */
export function PatientHeaderCard({ patient, title = 'Patient', facts, access, overrideUntil, children }: {
  patient: PatientHeader;
  title?: string;
  facts?: string[];
  access?: keyof typeof ACCESS_LABELS;
  overrideUntil?: string;
  children?: React.ReactNode;
}) {
  return (
    <NowConsultingCard
      title={title}
      patient={{ name: patient.name, meta: patientMeta(patient) }}
      facts={[...(facts ?? []), ...(patient.bloodGroup ? [`Blood group ${patient.bloodGroup}`] : [])]}
      intakeLabel="Allergies"
      intake={patient.allergies ?? 'No known allergies recorded'}
    >
      {access && (
        <div className="row">
          <Badge tone={access === 'BREAK_GLASS' ? 'danger' : 'primary'} dot size="sm">{ACCESS_LABELS[access]}</Badge>
          {overrideUntil && <span className="muted">until {timeLabel(overrideUntil)}</span>}
        </div>
      )}
      {children}
    </NowConsultingCard>
  );
}

/** Shown instead of the record when the doctor has no care relationship. Reason → 60 minutes, admins alerted. */
export function BreakGlassCard({ patientName, patientId, onGranted }: { patientName?: string; patientId: string; onGranted: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api<{ override: { expiresAt: string }; minutes: number }>(`/api/visits/patients/${patientId}/break-glass`, { json: { reason } });
      toast.show({ tone: 'warning', title: 'Break-glass access granted', message: `Until ${timeLabel(r.override.expiresAt)}. The admin has been alerted and every view is audited.` }, 7000);
      onGranted();
    } catch (err) {
      toast.error('Access not granted', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="No access to this record" subtitle={patientName ? `${patientName} has no visit, order or referral with you.` : 'You have no visit, order or referral with this patient.'}>
      <div className="stack">
        <p className="muted">
          In an emergency you can use <strong>break-glass</strong> access. Type the reason: you get 60 minutes of read access, the admin is
          emailed and alerted in the app, and every view is written to the audit log.
        </p>
        <Textarea label="Emergency reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Unconscious in casualty, need cardiac history" hint="At least 10 characters" />
        <div className="row">
          <Button variant="danger" loading={busy} disabled={reason.trim().length < 10} onClick={submit}>Break glass &amp; open record</Button>
        </div>
      </div>
    </Card>
  );
}
